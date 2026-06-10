import { type Quat, quat, type Vec3, vec3 } from 'mathcat';
import { MeshTrait } from '../../builtins/mesh';
import { ModelTrait } from '../../builtins/model';
import { AnimatorTrait } from '../../builtins/animator';
import { TransformTrait } from '../../builtins/transform';
import { env } from '../../api/env';
import type { ClipChannel, ClipChannels, ClipDef } from '../models/handle';
import * as Resources from '../resources';
import { addTrait, findChildByName, getTrait, type Node, type Nodes, query } from './nodes';
import { composeWorldMatrix, getWorldMatrix, TRANSFORM_DIRTY_ALL, TRANSFORM_DIRTY_WORLD_MATRIX } from '../../builtins/transform';

// ── types ────────────────────────────────────────────────────────────

export type BlendMode = 'replace' | 'additive';

export type AnimationAction = {
    clip: ClipDef;
    /** current blend weight (0..1) */
    weight: number;
    /** crossfade destination (set by crossFadeTo) */
    targetWeight: number;
    /** weight delta per second; 0 = no fade */
    fadeRate: number;
    /** current playback time in seconds */
    time: number;
    /** playback rate (default 1) */
    speed: number;
    loopMode: 'once' | 'repeat';
    enabled: boolean;
    /** ascending = composite later. higher layers fully replace lower
     *  layers' values for nodes they write. default 0. */
    layer: number;
    /** filter clip channels by node name. null = no filtering (every
     *  channel in the clip drives its target). default null. */
    mask: ReadonlySet<string> | null;
    /** how this action composites within its layer.
     *  - 'replace' (default): contributes to the layer's weighted sum
     *  - 'additive': delta from clip's first frame, added on top */
    blendMode: BlendMode;
    /** scratch — channels resolved at top of tick. preserved across ticks
     *  so the boneIndices cache below can detect a payload swap by ref
     *  identity. cleared by `Resources.modelClipChannels` returning a
     *  fresh ref on resource reload, which forces a rebuild. */
    _channels: ClipChannels | null;
    /** parallel to `_channels.channels` — boneIndices[c] = the channel's
     *  target bone index in `state.boneOrder`, or -1 if the rig doesn't
     *  contain that bone, or if `mask` filters it out. lets the inner
     *  sample loops index directly instead of doing string-keyed
     *  `boneIndex.get` + `mask.has` per channel per tick. */
    _boneIndices: Int32Array | null;
    /** matches `state.boneOrderEpoch` when valid; mismatch ⇒ rebuild. */
    _boneIndicesEpoch: number;
    /** ref of the channels payload `_boneIndices` was built against. */
    _boneIndicesChannelsRef: ClipChannels | null;
    /** ref of the mask `_boneIndices` was built against. */
    _boneIndicesMaskRef: ReadonlySet<string> | null;
    /** parallel to `_channels.channels` — last-found keyframe `lo` index per
     *  channel. seeded to 0; sample functions read this as their search start
     *  and write back the new lo. for steady-time playback the typical case
     *  is 0–1 forward steps before hitting the right interval; only sudden
     *  rewinds / loop wraps fall through to binary search. (three.js-style
     *  cached-index hybrid in `findKeyLow`.) */
    _lastKeyIdx: Int32Array | null;
    /** channel-index buckets partitioned by property type, with masked-out /
     *  unresolved channels excluded. lets the tick body run three monomorphic
     *  loops (no `switch (channel.property)` dispatch inside the hot path);
     *  per animation.bench.ts (H1), this is ~1.2× faster than the
     *  unified-loop variant. built alongside `_boneIndices` in
     *  `rebuildActionBoneIndices`. */
    _idxTranslation: Int32Array | null;
    _idxRotation: Int32Array | null;
    _idxScale: Int32Array | null;
};

// per-bone stride into layerAccum (Float32Array):
//   0..2  posX/Y/Z weighted sum
//   3     posW (sum of weights for translation channels)
//   4..7  quatX/Y/Z/W weighted sum (post dot-flip)
//   8     quatTotal (sum of weights for rotation channels)
//   9..11 scaleX/Y/Z weighted sum
//   12    scaleW (sum of weights for scale channels)
const LAYER_STRIDE = 13;

export type AnimatorState = {
    /** keyed by ClipDef ref identity (sidecar singleton). lookup-only. */
    actions: Map<ClipDef, AnimationAction>;
    /** parallel flat list of every action in `actions`, in insertion order.
     *  the tick body iterates this — `Map.values()` was ~1.8× slower per
     *  pass in animation.bench.ts and the tick walks it three times. kept
     *  in sync with `actions` at `Animation.clip()` time. */
    actionsList: AnimationAction[];

    /**
     * cached parent-first DFS of the rig's TransformTraits — built once on
     * first tick (when `boneOrder.length === 0`) and reused. scripts that
     * restructure the rig (e.g. attach a sword to a hand bone and want it
     * eagerly tracked) call `Animation.invalidateRig(animator)` to force a
     * rebuild. parent-first ordering means the end-of-tick dirty
     * reconciliation pass walks bones in a single forward sweep.
     */
    boneOrder: TransformTrait[];
    /** parallel to `boneOrder` — direct refs to `t.position` / `t.quaternion`
     *  / `t.scale` for each bone, captured during `walkBones`. saves a
     *  hidden-class property lookup per bone per tick in the layer passes.
     *  these arrays ARE the canonical store — replace + additive write
     *  directly into them; world matrices are recomputed lazily via
     *  `getWorldMatrix` on read (Unity/three.js shape). */
    bonePos: Vec3[];
    boneQuat: Quat[];
    boneScale: Vec3[];
    /** name → index in `boneOrder`. populated alongside `boneOrder`. */
    boneIndex: Map<string, number>;
    /** bumped each time `rebuildBoneOrder` runs. actions stamp this onto
     *  their cached `_boneIndices` so a structural change invalidates them. */
    boneOrderEpoch: number;

    /** per-bone weighted sum for the current layer's replace pass (cap × 13). */
    layerAccum: Float32Array;
    /** for each bone, exclusive end index of its DFS subtree in `boneOrder`
     *  (descendants of `bi` are the contiguous range `[bi+1, subtreeEnd[bi])`).
     *  built once during `walkBones`. lets writes mark a bone-and-descendants
     *  range dirty in one `Uint8Array.fill` call — godot Skeleton3D's
     *  `nested_set_offset + nested_set_span` trick. */
    subtreeEnd: Int32Array;
    /** subtree dirty bitmap: 1 = this tick's sampling wrote to bone `bi`'s
     *  local TRS, OR an ancestor was written. cleared at top of layer
     *  composition; set by the replace-normalize loop and by `applyAdditiveTA`
     *  via `subtreeDirty.fill(1, bi, subtreeEnd[bi])`. End-of-tick reconcile
     *  walks this bitmap once and stamps `_dirty = TRANSFORM_DIRTY_ALL` on
     *  each marked bone so `getWorldMatrix` lazy-composes correctly. */
    subtreeDirty: Uint8Array;
    /** capacity of layerAccum / subtreeEnd / subtreeDirty in bones. */
    accumCapacity: number;

    /** the rig's renderable meshes, cached when `boneOrder` is (re)built.
     *  The per-rig tick gate + LOD fold these meshes' own `cull` entries
     *  (on `MeshVisualState.cull`, written by the Visibility culler): the
     *  rig is visible iff any mesh is, and coverage comes from the
     *  closest/largest one. "Is the model visible" = "is any child mesh
     *  visible" — there's no rig-level cullable. */
    _cullMeshes: MeshTrait[];

    /** current LOD stride: 1 (sample every frame) / 2 / 4 / 8. Defaults 1
     *  until the first classify pass runs; that way the first visible frame
     *  always samples and the rig doesn't show a stale pose. */
    _lodStride: number;
    /** per-rig phase offset, assigned from a room-scoped counter at first
     *  tick. Spreads sampling across frames so N stride-2 rigs split into
     *  two phase buckets (half on even frames, half on odd) rather than
     *  all sampling on the same frame. -1 until assigned. */
    _lodPhase: number;
    /** `Animations._frameCount` when classification last ran. */
    _lodClassifiedAtFrame: number;
    /** previous frame's rig visibility (0/1). False→true transition forces
     *  a sample regardless of stride/phase so a rig coming on-screen doesn't
     *  show its up-to-8-frame-stale last pose. */
    _lastVisible: number;
};

function createAnimatorState(): AnimatorState {
    return {
        actions: new Map(),
        actionsList: [],
        boneOrder: [],
        bonePos: [],
        boneQuat: [],
        boneScale: [],
        boneIndex: new Map(),
        boneOrderEpoch: 0,
        layerAccum: new Float32Array(0),
        subtreeEnd: new Int32Array(0),
        subtreeDirty: new Uint8Array(0),
        accumCapacity: 0,
        _cullMeshes: [],
        _lodStride: 1,
        _lodPhase: -1,
        _lodClassifiedAtFrame: -1,
        _lastVisible: 0,
    };
}

/**
/**
 * Ensure the animator node carries a ModelTrait — the shared voxel-light
 * slot every mesh under the rig reads. Frustum culling is per-mesh now and
 * needs no rig-level trait, so this is the only colocated trait the animator
 * installs.
 */
function ensureModelTrait(animatorNode: Node): void {
    if (!getTrait(animatorNode, ModelTrait)) {
        addTrait(animatorNode, ModelTrait);
    }
}

/** Fold the rig's meshes' own cull entries into a rig-level answer. The rig
 *  is visible iff any mesh is (a mesh with no render-state yet — not drawn
 *  this frame, e.g. server tick or pre-first-render — counts as visible so
 *  animation runs at full fidelity until the renderer catches up). Coverage
 *  comes from the largest-projected visible mesh, for LOD. */
type RigVisibility = { visible: boolean; distSq: number; extentSq: number };
function rigVisibility(state: AnimatorState): RigVisibility {
    const meshes = state._cullMeshes;
    // no determinable meshes → default visible at full fidelity.
    let visible = meshes.length === 0;
    let bestCoverage = -1;
    let distSq = 0;
    let extentSq = 0;
    for (let i = 0; i < meshes.length; i++) {
        const s = meshes[i]!._state;
        if (s === null) {
            // mesh not realized by the renderer yet — treat as visible.
            visible = true;
            continue;
        }
        if (!s.cull.visible) continue;
        visible = true;
        const coverage = s.cull.distSq > 0 ? s.cull.extentSq / s.cull.distSq : Infinity;
        if (coverage > bestCoverage) {
            bestCoverage = coverage;
            distSq = s.cull.distSq;
            extentSq = s.cull.extentSq;
        }
    }
    return { visible, distSq, extentSq };
}

/**
 * Reclassify the rig's sampling stride from its current projected coverage
 * (`extentSq / distSq` — monotonic with projected pixel size for a given
 * fov, no sqrt or projection math needed). `distSq === 0` means "no coverage
 * data yet" → treat as closest (Infinity) so the rig samples at full
 * fidelity until the culler has measured it.
 *
 * Reclassifies on first call and every 8 frames (slow drift across tier
 * boundaries); holds tier choice stable between reclassifications so the
 * stride gate is a single integer compare in the steady-state hot path.
 *
 * Hysteresis: bands have asymmetric thresholds — upgrading to a smaller
 * stride (more sampling) requires clearing the boundary by 20%, mirroring
 * the visibility distance-cull pattern. Prevents oscillation for rigs
 * drifting across a boundary.
 */
function classifyLod(state: AnimatorState, distSq: number, extentSq: number, frameCount: number): void {
    const sinceLast = frameCount - state._lodClassifiedAtFrame;
    if (state._lodClassifiedAtFrame >= 0 && sinceLast < 8) return;

    const coverage = distSq > 0 ? extentSq / distSq : Infinity;

    const current = state._lodStride;
    let stride = current;

    // upgrade (smaller stride, higher fidelity) — require clearing the
    // boundary by +20% so a drifting rig doesn't oscillate.
    if (stride > 4 && coverage >= 0.0012) stride = 4;
    if (stride > 2 && coverage >= 0.012) stride = 2;
    if (stride > 1 && coverage >= 0.06) stride = 1;

    // downgrade (larger stride, lower fidelity) — require dropping below the
    // boundary by -20%.
    if (stride < 2 && coverage < 0.04) stride = 2;
    if (stride < 4 && coverage < 0.008) stride = 4;
    if (stride < 8 && coverage < 0.0008) stride = 8;

    state._lodStride = stride;
    state._lodClassifiedAtFrame = frameCount;
}

/** advance action.time on enabled actions without sampling. used by the
 *  visibility gate so resumption is smooth when the rig comes back on-screen. */
function advanceActionTimes(state: AnimatorState, dt: number): void {
    const actions = state.actionsList;
    for (let i = 0; i < actions.length; i++) {
        const action = actions[i]!;
        if (!action.enabled) continue;
        action.time += dt * action.speed;
    }
}

function ensureAccumCapacity(state: AnimatorState, boneCount: number): void {
    if (boneCount <= state.accumCapacity) return;
    let cap = state.accumCapacity > 0 ? state.accumCapacity : 8;
    while (cap < boneCount) cap *= 2;
    state.layerAccum = new Float32Array(cap * LAYER_STRIDE);
    state.subtreeEnd = new Int32Array(cap);
    state.subtreeDirty = new Uint8Array(cap);
    state.accumCapacity = cap;
}

// ── public api ───────────────────────────────────────────────────────

/** mark enabled and snap weight to 1 (no fade). use crossFadeTo for blending in. */
export function play(action: AnimationAction): void {
    action.enabled = true;
    action.weight = 1;
    action.targetWeight = 1;
    action.fadeRate = 0;
}

/** mark disabled. weight + time preserved so a subsequent play resumes from here. */
export function stop(action: AnimationAction): void {
    action.enabled = false;
}

/**
 * blend `from` out and `to` in over `duration` seconds. both actions become
 * enabled; per-tick animator advances each weight toward its target. safe to
 * re-call mid-fade — sets fresh targets and the next tick continues smoothly.
 */
export function crossFadeTo(from: AnimationAction, to: AnimationAction, duration: number): void {
    const rate = duration > 0 ? 1 / duration : Infinity;

    to.enabled = true;
    to.targetWeight = 1;
    to.fadeRate = rate;

    from.enabled = true;
    from.targetWeight = 0;
    from.fadeRate = rate;
}

/** snap weight + target to `w`. clears any in-progress crossfade. */
export function setEffectiveWeight(action: AnimationAction, w: number): void {
    action.weight = w;
    action.targetWeight = w;
    action.fadeRate = 0;
    if (w <= 0) action.enabled = false;
}

/** get the AnimationAction for a clip on this animator, creating it if absent. */
export function clip(animator: AnimatorTrait, clipDef: ClipDef): AnimationAction {
    if (!clipDef) {
        // common cause: model handle hasn't been registered yet (codegen
        // didn't run, or the generated barrel isn't imported), so
        // `myModel.animations.foo` is undefined. fail loudly here rather
        // than letting `undefined.clip.modelId` blow up mid-tick.
        throw new Error(
            '[Animation.clip] clipDef is null/undefined — is the model handle registered? ' +
                'check that `src/generated/index.ts` runs before user code.',
        );
    }
    let state = animator._state as AnimatorState | null;
    if (!state) {
        state = createAnimatorState();
        animator._state = state;
    }
    let action = state.actions.get(clipDef);
    if (!action) {
        action = {
            clip: clipDef,
            weight: 0,
            targetWeight: 0,
            fadeRate: 0,
            time: 0,
            speed: 1,
            loopMode: 'repeat',
            enabled: false,
            layer: 0,
            mask: null,
            blendMode: 'replace',
            _channels: null,
            _boneIndices: null,
            _boneIndicesEpoch: -1,
            _boneIndicesChannelsRef: null,
            _boneIndicesMaskRef: null,
            _lastKeyIdx: null,
            _idxTranslation: null,
            _idxRotation: null,
            _idxScale: null,
        };
        state.actions.set(clipDef, action);
        state.actionsList.push(action);
    }
    return action;
}

/**
 * drop the animator's cached bone order so the next tick rebuilds it.
 * call after restructuring the rig subtree (e.g. attaching a follower node
 * to a bone that should be eagerly transformed each tick alongside the
 * skeleton). a no-op if no state exists yet.
 *
 * does not invalidate `mask` sets returned by `Animation.descendants` —
 * call that again separately if needed.
 */
export function invalidateRig(animator: AnimatorTrait): void {
    const state = animator._state as AnimatorState | null;
    if (!state) return;
    state.boneOrder.length = 0;
    state.boneIndex.clear();
}

/**
 * names of every descendant of `root` in the animator's rig, walking the
 * subtree once. typical use: `aim.mask = Animation.descendants(animator,
 * 'Spine', { includeRoot: true })`. re-call to pick up structural changes.
 *
 * `root` can also match the animator's own node name; in that case the walk
 * starts from the animator node itself.
 */
export function descendants(
    animator: AnimatorTrait,
    root: string,
    opts?: { includeRoot?: boolean },
): Set<string> {
    const out = new Set<string>();
    const animatorNode = animator._node;
    if (!animatorNode) return out;
    const rootNode = animatorNode.name === root ? animatorNode : findChildByName(animatorNode, root);
    if (!rootNode) return out;
    if (opts?.includeRoot && rootNode.name) out.add(rootNode.name);
    for (const child of rootNode.children) collectDescendantNames(child, out);
    return out;
}

function collectDescendantNames(node: Node, out: Set<string>): void {
    if (node.name) out.add(node.name);
    for (const child of node.children) collectDescendantNames(child, out);
}

/**
 * advance every animator: time + crossfade weights, then sample channels
 * into per-layer accumulators with replace + additive composition, then
 * write blended TRS values back into the rig's TransformTraits via
 * setPosition/setQuaternion/setScale.
 *
 * **client**: called per render frame with the real frame delta — bones
 * step smoothly at any fps. bones aren't enrolled in interpolation, so
 * `Interpolation.interpolate` doesn't touch them; `composeAndPublish` writes
 * local TRS via setPosition/etc, which marks the visual chain dirty.
 * `getVisualWorldMatrix` then lazily composes against the (possibly
 * interpolated) parent.
 *
 * **server**: called inside the fixed-tick loop with `timestep` so the
 * teleport detector picks up the new pose this tick (animation can affect
 * physics if scripts read bone positions in physics-relevant code paths).
 */
// ── per-room animation system state ─────────────────────────────────

/**
 * per-room state for the animation tick. caches the `[AnimatorTrait]` query
 * so the per-frame walk doesn't rebuild bitsets / hash each call.
 */
export type Animations = {
    _query: ReturnType<typeof query<[typeof AnimatorTrait]>>;
    /** monotonic per-room frame counter — drives LOD stride/phase gating in
     *  the per-animator tick. Wraps would only matter past ~10⁹ frames. */
    _frameCount: number;
    /** room-scoped counter handed out as `_lodPhase` to each animator on its
     *  first tick. Ensures N rigs at stride 2 split across both phase buckets
     *  rather than all sampling on the same frame. */
    _nextLodPhase: number;
};

export function init(nodes: Nodes): Animations {
    return { _query: query(nodes, [AnimatorTrait]), _frameCount: 0, _nextLodPhase: 0 };
}

export function tick(animations: Animations, resources: Resources.Resources, dt: number): void {
    animations._frameCount++;
    for (const [animator] of animations._query) {
        const node = animator._node;
        if (!node) continue;
        if (!animator._state) animator._state = createAnimatorState();
        const state = animator._state;
        if (state._lodPhase < 0) state._lodPhase = animations._nextLodPhase++;
        tickAnimator(state, node, resources, dt, animator.lod, animations._frameCount);
    }
}

// ── per-animator tick ────────────────────────────────────────────────

function tickAnimator(
    state: AnimatorState,
    animatorNode: Node,
    resources: Resources.Resources,
    dt: number,
    lod: boolean,
    frameCount: number,
): void {
    // bone order + cached rig mesh list are rebuilt only when invalidated
    // (boneOrder emptied via `Animation.invalidateRig` or never built).
    // Must run BEFORE the visibility gate, which folds the rig meshes' cull
    // entries; also ensures the colocated ModelTrait (shared light slot).
    // Steady state: skip the walk.
    if (state.boneOrder.length === 0) {
        rebuildBoneOrder(state, animatorNode);
    }

    // ── visibility gate ─────────────────────────────────────────────────
    // Skip sample/compose/publish for off-screen rigs. `action.time` still
    // advances so resumption is seamless. "Is the rig visible" folds its
    // meshes' own per-mesh cull results — written earlier this frame by the
    // Visibility culler — so the rig is visible iff any of its meshes is.
    const rig = rigVisibility(state);
    if (!rig.visible) {
        state._lastVisible = 0;
        advanceActionTimes(state, dt);
        return;
    }

    // ── animation LOD gate ──────────────────────────────────────────────
    // Coverage-driven stride sampling: distant/small rigs sample every N
    // frames and hold pose between samples. Bones stay at their cached
    // local TRS, subtreeDirty is never set, composeWorldMatrix is skipped.
    // Off-frames still advance action.time so motion is seamless on
    // resumption.
    //
    // Server has no camera (coverage meaningless), so server always L0.
    // `animator.lod === false` opts out for gameplay-critical rigs.
    // Visibility false→true transition forces a sample on the first
    // visible frame so the rig doesn't show its up-to-8-frame-stale pose.
    const wasVisible = state._lastVisible;
    state._lastVisible = 1;
    if (env.client && lod) {
        classifyLod(state, rig.distSq, rig.extentSq, frameCount);
        const forceSample = wasVisible === 0;
        if (!forceSample) {
            const stride = state._lodStride;
            const shouldSample = stride === 1 || ((frameCount + state._lodPhase) % stride) === 0;
            if (!shouldSample) {
                advanceActionTimes(state, dt);
                return;
            }
        }
    }

    ensureAccumCapacity(state, state.boneOrder.length);

    // advance time + weights on enabled actions, hoist channels lookup,
    // collect distinct active layers.
    const activeLayers: number[] = [];
    let anyActive = false;
    const actionsList = state.actionsList;
    for (let i = 0; i < actionsList.length; i++) {
        const action = actionsList[i]!;
        if (!action.enabled) continue;

        // crossfade
        if (action.fadeRate !== 0 && action.weight !== action.targetWeight) {
            const step = action.fadeRate * dt;
            if (action.weight < action.targetWeight) {
                action.weight = Math.min(action.targetWeight, action.weight + step);
            } else {
                action.weight = Math.max(action.targetWeight, action.weight - step);
            }
            if (action.weight === action.targetWeight) {
                action.fadeRate = 0;
                if (action.weight === 0) {
                    action.enabled = false;
                    continue;
                }
            }
        }

        action.time += dt * action.speed;

        const channels = Resources.modelClipChannels(resources, action.clip);
        action._channels = channels;
        if (!channels) continue;
        // resolve channel→bone index map if anything that feeds it changed
        // (rig structure, channels payload, or mask). steady state: zero work.
        if (
            action._boneIndicesEpoch !== state.boneOrderEpoch ||
            action._boneIndicesChannelsRef !== channels ||
            action._boneIndicesMaskRef !== action.mask
        ) {
            rebuildActionBoneIndices(action, channels, state);
        }
        const dur = channels.duration;
        if (dur > 0) {
            if (action.loopMode === 'repeat') {
                action.time = action.time % dur;
                if (action.time < 0) action.time += dur;
            } else if (action.time > dur) {
                action.time = dur;
                action.enabled = false;
            }
        }

        if (action.weight > 0) {
            anyActive = true;
            if (!activeLayers.includes(action.layer)) activeLayers.push(action.layer);
        }
    }

    if (!anyActive) return;

    activeLayers.sort((a, b) => a - b);

    const boneCount = state.boneOrder.length;
    const layerAccum = state.layerAccum;
    const bonePos = state.bonePos;
    const boneQuat = state.boneQuat;
    const boneScale = state.boneScale;
    const subtreeDirty = state.subtreeDirty;
    const subtreeEnd = state.subtreeEnd;

    // clear the subtree-dirty bitmap. set per-bone by replace-normalize and
    // additive when an active action contributes to that bone's local TRS this
    // tick — each contribution does `subtreeDirty.fill(1, bi, subtreeEnd[bi])`,
    // pre-baking the bone-and-descendants cascade so composeAndPublish can gate
    // on a single bool read per bone.
    subtreeDirty.fill(0, 0, boneCount);

    for (let li = 0; li < activeLayers.length; li++) {
        const layer = activeLayers[li]!;

        // Fast path: single replace action, no additive on this layer. The
        // weighted-blend math degenerates (`sample × w / w = sample` for one
        // contributor), so layerAccum + normalize is dead weight — sample
        // straight into bone TRS. This is the steady state for any rig
        // running `Animation.play(action)` with no crossfade or overlay.
        let replaceCount = 0;
        let additiveCount = 0;
        let singleReplace: AnimationAction | null = null;
        for (let ai = 0; ai < actionsList.length; ai++) {
            const a = actionsList[ai]!;
            if (!a.enabled || a.weight <= 0 || a.layer !== layer) continue;
            if (a.blendMode === 'replace') {
                replaceCount++;
                singleReplace = a;
            } else {
                additiveCount++;
            }
        }
        if (replaceCount === 1 && additiveCount === 0 && singleReplace!._channels) {
            const action = singleReplace!;
            const channels = action._channels!;
            const time = action.time;
            const channelArr = channels.channels;
            const boneIndices = action._boneIndices!;
            const lastKeyIdx = action._lastKeyIdx!;
            const idxT = action._idxTranslation!;
            const idxR = action._idxRotation!;
            const idxS = action._idxScale!;

            for (let i = 0; i < idxT.length; i++) {
                const c = idxT[i]!;
                const bi = boneIndices[c]!;
                lastKeyIdx[c] = sampleVec3(channelArr[c]!, time, bonePos[bi]!, lastKeyIdx[c]!);
                const end = subtreeEnd[bi]!;
                for (let k = bi; k < end; k++) subtreeDirty[k] = 1;
            }
            for (let i = 0; i < idxR.length; i++) {
                const c = idxR[i]!;
                const bi = boneIndices[c]!;
                lastKeyIdx[c] = sampleQuat(channelArr[c]!, time, boneQuat[bi]!, lastKeyIdx[c]!);
                const end = subtreeEnd[bi]!;
                for (let k = bi; k < end; k++) subtreeDirty[k] = 1;
            }
            for (let i = 0; i < idxS.length; i++) {
                const c = idxS[i]!;
                const bi = boneIndices[c]!;
                lastKeyIdx[c] = sampleVec3(channelArr[c]!, time, boneScale[bi]!, lastKeyIdx[c]!);
                const end = subtreeEnd[bi]!;
                for (let k = bi; k < end; k++) subtreeDirty[k] = 1;
            }
            continue;
        }

        // Phase 1 — replace pass for this layer (weighted sum, then override).
        layerAccum.fill(0, 0, boneCount * LAYER_STRIDE);
        for (let ai = 0; ai < actionsList.length; ai++) {
            const action = actionsList[ai]!;
            if (!action.enabled || action.weight <= 0) continue;
            if (action.layer !== layer || action.blendMode !== 'replace') continue;
            const channels = action._channels;
            if (!channels) continue;

            const w = action.weight;
            const time = action.time;
            const channelArr = channels.channels;
            const boneIndices = action._boneIndices!;
            const lastKeyIdx = action._lastKeyIdx!;
            const idxT = action._idxTranslation!;
            const idxR = action._idxRotation!;
            const idxS = action._idxScale!;

            // translation
            for (let i = 0; i < idxT.length; i++) {
                const c = idxT[i]!;
                const bi = boneIndices[c]!;
                const o = bi * LAYER_STRIDE;
                lastKeyIdx[c] = sampleVec3(channelArr[c]!, time, _scratchVec3, lastKeyIdx[c]!);
                layerAccum[o] += _scratchVec3[0]! * w;
                layerAccum[o + 1] += _scratchVec3[1]! * w;
                layerAccum[o + 2] += _scratchVec3[2]! * w;
                layerAccum[o + 3] += w;
            }
            // rotation
            for (let i = 0; i < idxR.length; i++) {
                const c = idxR[i]!;
                const bi = boneIndices[c]!;
                const o = bi * LAYER_STRIDE;
                lastKeyIdx[c] = sampleQuat(channelArr[c]!, time, _scratchQuat, lastKeyIdx[c]!);
                // dot-flip for shortest-path nlerp blending against accumulator
                const total = layerAccum[o + 8]!;
                let qx = _scratchQuat[0]!;
                let qy = _scratchQuat[1]!;
                let qz = _scratchQuat[2]!;
                let qw = _scratchQuat[3]!;
                if (total > 0) {
                    const dot =
                        layerAccum[o + 4]! * qx +
                        layerAccum[o + 5]! * qy +
                        layerAccum[o + 6]! * qz +
                        layerAccum[o + 7]! * qw;
                    if (dot < 0) {
                        qx = -qx;
                        qy = -qy;
                        qz = -qz;
                        qw = -qw;
                    }
                }
                layerAccum[o + 4] += qx * w;
                layerAccum[o + 5] += qy * w;
                layerAccum[o + 6] += qz * w;
                layerAccum[o + 7] += qw * w;
                layerAccum[o + 8] += w;
            }
            // scale
            for (let i = 0; i < idxS.length; i++) {
                const c = idxS[i]!;
                const bi = boneIndices[c]!;
                const o = bi * LAYER_STRIDE;
                lastKeyIdx[c] = sampleVec3(channelArr[c]!, time, _scratchVec3, lastKeyIdx[c]!);
                layerAccum[o + 9] += _scratchVec3[0]! * w;
                layerAccum[o + 10] += _scratchVec3[1]! * w;
                layerAccum[o + 11] += _scratchVec3[2]! * w;
                layerAccum[o + 12] += w;
            }
        }

        // override directly into trait local TRS arrays (per-bone normalize
        // from weighted sum). bones with no contribution this layer keep
        // their prior trait value — the subtreeDirty bitmap + composeAndPublish
        // gate ensures unanimated bones avoid the world-matrix recompute.
        for (let bi = 0; bi < boneCount; bi++) {
            const lo = bi * LAYER_STRIDE;
            const posW = layerAccum[lo + 3]!;
            const quatTotal = layerAccum[lo + 8]!;
            const scaleW = layerAccum[lo + 12]!;
            if (posW === 0 && quatTotal === 0 && scaleW === 0) continue;

            // godot Skeleton3D's nested-set trick: a write at bi forces every
            // descendant to recompose too. scalar loop — per animation.bench.ts
            // (H4), Uint8Array.fill carries ~17ns of per-call overhead, while
            // a scalar write is ~0.5ns/byte; for typical leaf-bone ranges
            // (<30 bones) scalar wins ~7×. The rare root-bone full-rig case
            // pays a small penalty, dwarfed by the common-case wins.
            const end = subtreeEnd[bi]!;
            for (let k = bi; k < end; k++) subtreeDirty[k] = 1;

            if (posW > 0) {
                const inv = 1 / posW;
                const p = bonePos[bi]!;
                p[0] = layerAccum[lo]! * inv;
                p[1] = layerAccum[lo + 1]! * inv;
                p[2] = layerAccum[lo + 2]! * inv;
            }
            if (quatTotal > 0) {
                const qx = layerAccum[lo + 4]!;
                const qy = layerAccum[lo + 5]!;
                const qz = layerAccum[lo + 6]!;
                const qw = layerAccum[lo + 7]!;
                const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
                if (len > 0) {
                    const il = 1 / len;
                    const q = boneQuat[bi]!;
                    q[0] = qx * il;
                    q[1] = qy * il;
                    q[2] = qz * il;
                    q[3] = qw * il;
                }
            }
            if (scaleW > 0) {
                const inv = 1 / scaleW;
                const s = boneScale[bi]!;
                s[0] = layerAccum[lo + 9]! * inv;
                s[1] = layerAccum[lo + 10]! * inv;
                s[2] = layerAccum[lo + 11]! * inv;
            }
        }

        // Phase 2 — additive pass for this layer (delta on top of current trait local).
        for (let ai = 0; ai < actionsList.length; ai++) {
            const action = actionsList[ai]!;
            if (!action.enabled || action.weight <= 0) continue;
            if (action.layer !== layer || action.blendMode !== 'additive') continue;
            const channels = action._channels;
            if (!channels) continue;

            const w = action.weight;
            const time = action.time;
            const channelArr = channels.channels;
            const boneIndices = action._boneIndices!;
            const lastKeyIdx = action._lastKeyIdx!;
            const idxT = action._idxTranslation!;
            const idxR = action._idxRotation!;
            const idxS = action._idxScale!;

            // translation
            for (let i = 0; i < idxT.length; i++) {
                const c = idxT[i]!;
                const bi = boneIndices[c]!;
                const channel = channelArr[c]!;
                lastKeyIdx[c] = sampleVec3(channel, time, _scratchVec3, lastKeyIdx[c]!);
                channelFirstFrame(channel, _scratchVec3Ref);
                const p = bonePos[bi]!;
                p[0] += (_scratchVec3[0]! - _scratchVec3Ref[0]!) * w;
                p[1] += (_scratchVec3[1]! - _scratchVec3Ref[1]!) * w;
                p[2] += (_scratchVec3[2]! - _scratchVec3Ref[2]!) * w;
                const dirtyEnd = subtreeEnd[bi]!;
                for (let k = bi; k < dirtyEnd; k++) subtreeDirty[k] = 1;
            }
            // rotation
            for (let i = 0; i < idxR.length; i++) {
                const c = idxR[i]!;
                const bi = boneIndices[c]!;
                const channel = channelArr[c]!;
                lastKeyIdx[c] = sampleQuat(channel, time, _scratchQuat, lastKeyIdx[c]!);
                channelFirstFrame(channel, _scratchQuatRef);
                // delta = sample * inv(ref). inv of a unit quat is conjugate.
                const sx = _scratchQuat[0]!;
                const sy = _scratchQuat[1]!;
                const sz = _scratchQuat[2]!;
                const sw = _scratchQuat[3]!;
                const ix = -_scratchQuatRef[0]!;
                const iy = -_scratchQuatRef[1]!;
                const iz = -_scratchQuatRef[2]!;
                const iw = _scratchQuatRef[3]!;
                let dx = sw * ix + sx * iw + sy * iz - sz * iy;
                let dy = sw * iy - sx * iz + sy * iw + sz * ix;
                let dz = sw * iz + sx * iy - sy * ix + sz * iw;
                let dw = sw * iw - sx * ix - sy * iy - sz * iz;
                if (dw < 0) {
                    dx = -dx;
                    dy = -dy;
                    dz = -dz;
                    dw = -dw;
                }
                // partial = nlerp(identity, delta, w). identity = (0,0,0,1).
                let px = dx * w;
                let py = dy * w;
                let pz = dz * w;
                let pw = 1 - w + dw * w;
                const plen = Math.sqrt(px * px + py * py + pz * pz + pw * pw);
                if (plen > 0) {
                    const il = 1 / plen;
                    px *= il;
                    py *= il;
                    pz *= il;
                    pw *= il;
                }
                // q = q * partial (apply additive on top of current local rotation).
                const q = boneQuat[bi]!;
                const rx = q[0]!,
                    ry = q[1]!,
                    rz = q[2]!,
                    rw = q[3]!;
                q[0] = rw * px + rx * pw + ry * pz - rz * py;
                q[1] = rw * py - rx * pz + ry * pw + rz * px;
                q[2] = rw * pz + rx * py - ry * px + rz * pw;
                q[3] = rw * pw - rx * px - ry * py - rz * pz;
                const dirtyEnd = subtreeEnd[bi]!;
                for (let k = bi; k < dirtyEnd; k++) subtreeDirty[k] = 1;
            }
            // scale
            for (let i = 0; i < idxS.length; i++) {
                const c = idxS[i]!;
                const bi = boneIndices[c]!;
                const channel = channelArr[c]!;
                lastKeyIdx[c] = sampleVec3(channel, time, _scratchVec3, lastKeyIdx[c]!);
                channelFirstFrame(channel, _scratchVec3Ref);
                // ratio = sample / ref; partial = lerp(1, ratio, w); s *= partial.
                const rx = _scratchVec3Ref[0]! !== 0 ? _scratchVec3[0]! / _scratchVec3Ref[0]! : 1;
                const ry = _scratchVec3Ref[1]! !== 0 ? _scratchVec3[1]! / _scratchVec3Ref[1]! : 1;
                const rz = _scratchVec3Ref[2]! !== 0 ? _scratchVec3[2]! / _scratchVec3Ref[2]! : 1;
                const s = boneScale[bi]!;
                s[0] *= 1 - w + rx * w;
                s[1] *= 1 - w + ry * w;
                s[2] *= 1 - w + rz * w;
                const dirtyEnd = subtreeEnd[bi]!;
                for (let k = bi; k < dirtyEnd; k++) subtreeDirty[k] = 1;
            }
        }
    }

    // Eager forward DFS world-matrix compose. boneOrder is parent-first DFS,
    // so for any bone bi >= 1 the parent transform is either earlier in
    // boneOrder (composed by this very loop before bi runs) or outside the
    // rig (refreshed via getWorldMatrix below on first dirty hit). After
    // this loop, every animated bone's worldMatrix is fresh and
    // TRANSFORM_DIRTY_WORLD_MATRIX is clear. visual chain stays dirty —
    // it lazily recomposes on first renderer read against the (possibly
    // interpolated) parent.interpolatedWorldMatrix.
    //
    // `subtreeDirty` already encodes the descendant cascade (one
    // `subtreeDirty.fill(1, bi, subtreeEnd[bi])` per animator-write covers
    // bone-and-descendants), so a single forward sweep is enough; no
    // recursive `markDescendants` walk needed.
    for (let bi = 0; bi < boneCount; bi++) {
        if (!subtreeDirty[bi]) continue;
        const t = state.boneOrder[bi]!;

        // ensure parent.worldMatrix is fresh. usually a no-op: parent is
        // earlier in boneOrder and was composed by this loop's prior
        // iteration. exception: rig-root bones whose `parent transform`
        // lives outside the rig — refresh it via the lazy walk-up.
        const parent = t._parent as TransformTrait | null;
        if (parent !== null && (parent._dirty & TRANSFORM_DIRTY_WORLD_MATRIX)) {
            getWorldMatrix(parent);
        }

        if (t._dirty !== TRANSFORM_DIRTY_ALL) {
            t._dirty = TRANSFORM_DIRTY_ALL;
            t._version++;
        }
        composeWorldMatrix(t);
    }
}

// ── helpers ──────────────────────────────────────────────────────────

/**
 * parent-first DFS over the animator subtree, populating `boneOrder`
 * (TransformTrait per named node) and `boneIndex` (name → index). called
 * lazily on first tick or after `invalidateRig`.
 *
 * the animator node itself is included — gltf rigs often have the root
 * node as an animation target (e.g. the 'penguin' root waddling its body).
 */
/** collect every `MeshTrait` in the subtree (inclusive) into `out`. The
 *  animator folds these meshes' cull entries for its visibility gate + LOD. */
function collectMeshes(node: Node, out: MeshTrait[]): void {
    const mesh = getTrait(node, MeshTrait);
    if (mesh) out.push(mesh);
    for (const child of node.children) collectMeshes(child, out);
}

function rebuildBoneOrder(state: AnimatorState, animatorNode: Node): void {
    // the rig's mesh subtree just changed (initial mount or post-mount
    // swap) — recache the meshes the visibility gate/LOD folds, and ensure
    // the shared-light ModelTrait now that the meshes are attached.
    state._cullMeshes.length = 0;
    collectMeshes(animatorNode, state._cullMeshes);
    ensureModelTrait(animatorNode);

    state.boneOrder.length = 0;
    state.bonePos.length = 0;
    state.boneQuat.length = 0;
    state.boneScale.length = 0;
    state.boneIndex.clear();
    // gather subtree-end indices into a JS array first (push/index-friendly),
    // then commit into the Int32Array once we know the final size and have
    // grown the SoA buffers. subtreeEnd[bi] is the exclusive end of bi's DFS
    // subtree; walkBones stamps it on the way back up.
    const subtreeEndList: number[] = [];
    walkBones(state, animatorNode, subtreeEndList);
    ensureAccumCapacity(state, state.boneOrder.length);
    const dstE = state.subtreeEnd;
    for (let i = 0; i < subtreeEndList.length; i++) {
        dstE[i] = subtreeEndList[i]!;
    }
    // bump epoch so any action's cached _boneIndices is detected stale on
    // its next use (the bone-name → index map just changed under it).
    state.boneOrderEpoch++;
}

/**
 * resolve every channel's target bone once and stash the result on the
 * action, so the per-tick sample loops can skip string-keyed Map +
 * mask lookups. `-1` means "this rig has no such bone" or "the mask
 * filters it out" — both are skipped identically by the caller.
 *
 * called only when the rig was rebuilt, the channels payload swapped
 * (resource reload), or the action's mask ref changed.
 */
function rebuildActionBoneIndices(
    action: AnimationAction,
    channels: ClipChannels,
    state: AnimatorState,
): void {
    const arr = channels.channels;
    let out = action._boneIndices;
    if (!out || out.length < arr.length) out = new Int32Array(arr.length);
    const mask = action.mask;
    const boneIndex = state.boneIndex;
    let nT = 0, nR = 0, nS = 0;
    for (let c = 0; c < arr.length; c++) {
        const ch = arr[c]!;
        const name = ch.nodeName;
        const bi = boneIndex.get(name);
        if (bi === undefined) {
            out[c] = -1;
        } else if (mask && !mask.has(name)) {
            out[c] = -1;
        } else {
            out[c] = bi;
            const p = ch.property;
            if (p === 'translation') nT++;
            else if (p === 'rotation') nR++;
            else nS++;
        }
    }
    // partition resolved channels into per-property buckets so the tick body
    // runs three monomorphic loops with no `switch (channel.property)`
    // dispatch inside the inner pass (H1).
    const idxT = new Int32Array(nT);
    const idxR = new Int32Array(nR);
    const idxS = new Int32Array(nS);
    let iT = 0, iR = 0, iS = 0;
    for (let c = 0; c < arr.length; c++) {
        if (out[c]! < 0) continue;
        const p = arr[c]!.property;
        if (p === 'translation') idxT[iT++] = c;
        else if (p === 'rotation') idxR[iR++] = c;
        else idxS[iS++] = c;
    }
    action._idxTranslation = idxT;
    action._idxRotation = idxR;
    action._idxScale = idxS;
    action._boneIndices = out;
    action._boneIndicesEpoch = state.boneOrderEpoch;
    // _lastKeyIdx is keyed to the channels payload — its slot count must
    // match `arr.length`. cache contents are only valid against this exact
    // payload too (reload swaps `times` arrays, so cached lo positions are
    // garbage). resetting on every rebuild also covers epoch + mask
    // changes without separate bookkeeping; the cost (one binary search
    // per channel on the next tick) is paid only at structural events.
    let last = action._lastKeyIdx;
    if (!last || last.length < arr.length) last = new Int32Array(arr.length);
    else last.fill(0, 0, arr.length);
    action._lastKeyIdx = last;
    action._boneIndicesChannelsRef = channels;
    action._boneIndicesMaskRef = mask;
}

function walkBones(state: AnimatorState, node: Node, subtreeEndList: number[]): void {
    let myIdx = -1;
    const t = node._traits.get(TransformTrait._slot) as TransformTrait | undefined;
    if (t && node.name && !state.boneIndex.has(node.name)) {
        myIdx = state.boneOrder.length;
        state.boneIndex.set(node.name, myIdx);
        state.boneOrder.push(t);
        // capture trait TRS array refs once. these are stable for the
        // lifetime of the trait — the trait creates them once in its
        // initializer and never reassigns the field — so caching here is sound
        // until rebuild. layer passes write into bonePos/Quat/Scale directly;
        // world matrices are computed lazily on first read via
        // `getWorldMatrix` (Unity/three.js shape).
        state.bonePos.push(t.position);
        state.boneQuat.push(t.quaternion);
        state.boneScale.push(t.scale);
        // placeholder; finalised on the way back up so descendants are counted.
        subtreeEndList.push(0);
    }
    for (const child of node.children) walkBones(state, child, subtreeEndList);
    // post-DFS stamp: subtree end = current boneOrder length. descendants of
    // myIdx live in [myIdx + 1, subtreeEndList[myIdx]).
    if (myIdx >= 0) subtreeEndList[myIdx] = state.boneOrder.length;
}

/** read the first-frame value of a channel into `out`. used as additive ref pose. */
function channelFirstFrame(channel: ClipChannel, out: Vec3 | Quat): void {
    const { values, interpolation, property } = channel;
    const stride = property === 'rotation' ? 4 : 3;
    const valueOffset = interpolation === 'CUBICSPLINE' ? stride : 0;
    if (values.length < valueOffset + stride) {
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
        if (property === 'rotation') (out as Quat)[3] = 1;
        return;
    }
    out[0] = values[valueOffset]!;
    out[1] = values[valueOffset + 1]!;
    out[2] = values[valueOffset + 2]!;
    if (property === 'rotation') (out as Quat)[3] = values[valueOffset + 3]!;
}

// ── sampling ─────────────────────────────────────────────────────────

const _scratchVec3: Vec3 = vec3.create();
const _scratchVec3Ref: Vec3 = vec3.create();
const _scratchQuat: Quat = quat.create();
const _scratchQuatRef: Quat = quat.create();

/**
 * locate `lo` such that `times[lo] <= time < times[lo+1]` (or clamps to
 * 0 / kc-1). hybrid search after three.js's `Interpolant`: the cached
 * `last` is used as a starting guess; we check the same interval, then
 * walk forward up to two keys (the typical sequential-playback case),
 * then fall back to a binary search on a sudden seek / loop wrap.
 *
 * caller is responsible for the `time <= times[0]` / `time >= times[kc-1]`
 * clamps; this helper assumes `kc >= 2` and `times[0] < time < times[kc-1]`.
 */
function findKeyLow(times: ArrayLike<number>, kc: number, time: number, last: number): number {
    let lo = last < 0 ? 0 : last >= kc - 1 ? kc - 2 : last;

    // same interval as last tick? overwhelmingly common at steady playback.
    if (times[lo]! <= time && time < times[lo + 1]!) return lo;

    // forward 1–2 steps (time advanced into next interval).
    if (lo + 2 < kc) {
        if (time < times[lo + 2]! && times[lo + 1]! <= time) return lo + 1;
    }
    if (lo + 3 < kc) {
        if (time < times[lo + 3]! && times[lo + 2]! <= time) return lo + 2;
    }

    // backward 1 step (rewind by a sliver — rare but cheap to check).
    if (lo > 0 && times[lo - 1]! <= time && time < times[lo]!) return lo - 1;

    // fall back to binary search (loop wrap, scrub, first tick).
    let l = 0;
    let h = kc - 1;
    while (h - l > 1) {
        const mid = (l + h) >> 1;
        if (times[mid]! <= time) l = mid;
        else h = mid;
    }
    return l;
}

/** sample a translation/scale channel at `time`. STEP/LINEAR; CUBICSPLINE falls back to LINEAR.
 *  threads `lastIdx` through `findKeyLow` for cached-key search; returns the
 *  found `lo` (or 0 / kc-1 clamp) for the caller to stash on the action. */
function sampleVec3(channel: ClipChannel, time: number, out: Vec3, lastIdx: number): number {
    const { times, values, interpolation } = channel;
    const kc = times.length;
    if (kc === 0) {
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
        return 0;
    }
    const stride = interpolation === 'CUBICSPLINE' ? 9 : 3;
    const valueOffset = interpolation === 'CUBICSPLINE' ? 3 : 0;

    if (kc === 1 || time <= times[0]!) {
        const o = valueOffset;
        out[0] = values[o]!;
        out[1] = values[o + 1]!;
        out[2] = values[o + 2]!;
        return 0;
    }
    if (time >= times[kc - 1]!) {
        const o = (kc - 1) * stride + valueOffset;
        out[0] = values[o]!;
        out[1] = values[o + 1]!;
        out[2] = values[o + 2]!;
        return kc - 1;
    }

    const lo = findKeyLow(times, kc, time, lastIdx);
    const hi = lo + 1;
    const t0 = times[lo]!;
    const t1 = times[hi]!;
    const o0 = lo * stride + valueOffset;
    const o1 = hi * stride + valueOffset;

    if (interpolation === 'STEP') {
        out[0] = values[o0]!;
        out[1] = values[o0 + 1]!;
        out[2] = values[o0 + 2]!;
        return lo;
    }

    const alpha = t1 > t0 ? (time - t0) / (t1 - t0) : 0;
    const inv = 1 - alpha;
    out[0] = values[o0]! * inv + values[o1]! * alpha;
    out[1] = values[o0 + 1]! * inv + values[o1 + 1]! * alpha;
    out[2] = values[o0 + 2]! * inv + values[o1 + 2]! * alpha;
    return lo;
}

/** sample a quaternion channel at `time`. STEP/LINEAR (nlerp); CUBICSPLINE falls back to nlerp.
 *  threads `lastIdx` through `findKeyLow` for cached-key search. */
function sampleQuat(channel: ClipChannel, time: number, out: Quat, lastIdx: number): number {
    const { times, values, interpolation } = channel;
    const kc = times.length;
    if (kc === 0) {
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
        out[3] = 1;
        return 0;
    }
    const stride = interpolation === 'CUBICSPLINE' ? 12 : 4;
    const valueOffset = interpolation === 'CUBICSPLINE' ? 4 : 0;

    if (kc === 1 || time <= times[0]!) {
        const o = valueOffset;
        out[0] = values[o]!;
        out[1] = values[o + 1]!;
        out[2] = values[o + 2]!;
        out[3] = values[o + 3]!;
        return 0;
    }
    if (time >= times[kc - 1]!) {
        const o = (kc - 1) * stride + valueOffset;
        out[0] = values[o]!;
        out[1] = values[o + 1]!;
        out[2] = values[o + 2]!;
        out[3] = values[o + 3]!;
        return kc - 1;
    }

    const lo = findKeyLow(times, kc, time, lastIdx);
    const hi = lo + 1;
    const t0 = times[lo]!;
    const t1 = times[hi]!;
    const o0 = lo * stride + valueOffset;
    const o1 = hi * stride + valueOffset;

    if (interpolation === 'STEP') {
        out[0] = values[o0]!;
        out[1] = values[o0 + 1]!;
        out[2] = values[o0 + 2]!;
        out[3] = values[o0 + 3]!;
        return lo;
    }

    const alpha = t1 > t0 ? (time - t0) / (t1 - t0) : 0;
    const ax = values[o0]!,
        ay = values[o0 + 1]!,
        az = values[o0 + 2]!,
        aw = values[o0 + 3]!;
    let bx = values[o1]!,
        by = values[o1 + 1]!,
        bz = values[o1 + 2]!,
        bw = values[o1 + 3]!;
    // shortest-path
    if (ax * bx + ay * by + az * bz + aw * bw < 0) {
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
    }
    const inv = 1 - alpha;
    let rx = ax * inv + bx * alpha;
    let ry = ay * inv + by * alpha;
    let rz = az * inv + bz * alpha;
    let rw = aw * inv + bw * alpha;
    const len = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
    if (len > 0) {
        const il = 1 / len;
        rx *= il;
        ry *= il;
        rz *= il;
        rw *= il;
    }
    out[0] = rx;
    out[1] = ry;
    out[2] = rz;
    out[3] = rw;
    return lo;
}
