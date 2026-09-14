import { type Quat, quat, type Vec3, vec3 } from 'math';
import { AnimatorTrait } from '../../builtins/animator';
import { MeshTrait } from '../../builtins/mesh';
import { ModelTrait } from '../../builtins/model';
import {
    composeWorldMatrix,
    getWorldMatrix,
    parentTransform,
    TRANSFORM_DIRTY_ALL,
    TRANSFORM_DIRTY_WORLD_MATRIX,
    TransformTrait,
} from '../../builtins/transform';
import { env } from '../../env';
import type { ClipChannel, ClipChannels, ClipDef } from '../models/handle';
import * as Resources from '../resources';
import { addTrait, findChildByName, getTrait, type Node, query, type SceneTree } from './scene-tree';

export type BlendMode = 'replace' | 'additive';

export type AnimationAction = {
    clip: ClipDef;
    /** 0..1. */
    weight: number;
    /** crossfade destination, set by crossFadeTo. */
    targetWeight: number;
    /** weight delta per second; 0 = no fade. */
    fadeRate: number;
    /** playback time in seconds. */
    time: number;
    /** playback rate, default 1. */
    speed: number;
    loopMode: 'once' | 'repeat';
    enabled: boolean;
    /** ascending = composite later, replacing lower layers' values for the nodes they write. default 0. */
    layer: number;
    /** filter clip channels by node name; null means no filtering. */
    mask: ReadonlySet<string> | null;
    /** 'replace' (default) contributes to the layer's weighted sum, 'additive' adds the delta from the clip's first frame on top. */
    blendMode: BlendMode;
    /** resolved at top of tick, preserved across ticks so _boneIndices can detect a payload swap by ref identity. */
    _channels: ClipChannels | null;
    /** parallel to _channels.channels: target bone index in state.boneOrder per channel, or -1 if unresolved or masked out. */
    _boneIndices: Int32Array | null;
    /** matches state.boneOrderEpoch when valid; a mismatch triggers a rebuild. */
    _boneIndicesEpoch: number;
    _boneIndicesChannelsRef: ClipChannels | null;
    _boneIndicesMaskRef: ReadonlySet<string> | null;
    /** parallel to _channels.channels: last-found keyframe lo index per channel, threaded through findKeyLow as search start and write-back. */
    _lastKeyIdx: Int32Array | null;
    /** resolved channel indices bucketed by property, so the tick body runs three monomorphic loops instead of a switch per channel. */
    _idxTranslation: Int32Array | null;
    _idxRotation: Int32Array | null;
    _idxScale: Int32Array | null;
};

// per-bone stride into layerAccum: 0-2 pos sum, 3 posW, 4-7 quat sum (post dot-flip), 8 quatTotal, 9-11 scale sum, 12 scaleW
const LAYER_STRIDE = 13;

export type AnimatorState = {
    /** keyed by ClipDef ref identity (sidecar singleton), lookup-only. */
    actions: Map<ClipDef, AnimationAction>;
    /** flat list parallel to `actions`, iterated by the tick body since Map iteration was measurably slower. */
    actionsList: AnimationAction[];

    /** cached parent-first DFS of the rig's TransformTraits; call `Animation.invalidateRig` after restructuring the rig. */
    boneOrder: TransformTrait[];
    /** parallel to `boneOrder`: direct refs to each bone's position/quaternion/scale; layer passes write into them, world matrices recompose lazily. */
    bonePos: Vec3[];
    boneQuat: Quat[];
    boneScale: Vec3[];
    /** name to index in `boneOrder`, populated alongside it. */
    boneIndex: Map<string, number>;
    /** bumped each time `rebuildBoneOrder` runs, so actions can detect their cached `_boneIndices` are stale. */
    boneOrderEpoch: number;

    /** per-bone weighted sum for the current layer's replace pass (cap x 13). */
    layerAccum: Float32Array;
    /** exclusive end index of each bone's DFS subtree in `boneOrder` (descendants of `bi` are `[bi+1, subtreeEnd[bi])`); lets a write mark a whole subtree dirty in one range fill. */
    subtreeEnd: Int32Array;
    /** subtree dirty bitmap: 1 = this tick wrote bone `bi` or an ancestor; the end-of-tick sweep stamps `_dirty = TRANSFORM_DIRTY_ALL` on each marked bone. */
    subtreeDirty: Uint8Array;
    /** capacity of layerAccum / subtreeEnd / subtreeDirty in bones. */
    accumCapacity: number;

    /** the rig's renderable meshes, cached when `boneOrder` is (re)built. */
    _cullMeshes: MeshTrait[];

    /** current LOD stride: 1 (every frame) / 2 / 4 / 8. */
    _lodStride: number;
    /** per-rig phase offset from a room-scoped counter, so same-stride rigs split across frames instead of sampling in lockstep; -1 until assigned. */
    _lodPhase: number;
    /** `Animations.frameCount` when classification last ran. */
    _lodClassifiedAtFrame: number;
    /** previous frame's rig visibility (0/1); a false-to-true transition forces a sample so a rig coming on-screen doesn't show a stale pose. */
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

/** ensure the animator node carries a ModelTrait, the shared voxel-light slot every mesh under the rig reads. */
function ensureModelTrait(animatorNode: Node): void {
    if (!getTrait(animatorNode, ModelTrait)) {
        addTrait(animatorNode, ModelTrait);
    }
}

/** folds the rig's meshes' own cull entries into a rig-level visibility answer; distSq/extentSq come from the largest-projected visible mesh, for LOD. */
type RigVisibility = { visible: boolean; distSq: number; extentSq: number };
function rigVisibility(state: AnimatorState): RigVisibility {
    const meshes = state._cullMeshes;
    let visible = meshes.length === 0;
    let bestCoverage = -1;
    let distSq = 0;
    let extentSq = 0;
    for (let i = 0; i < meshes.length; i++) {
        const s = meshes[i]!._state;
        if (s === null) {
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

/** Reclassifies the rig's sampling stride from projected coverage; hysteresis requires clearing a band boundary by 20% before switching, so a drifting rig doesn't oscillate. */
function classifyLod(state: AnimatorState, distSq: number, extentSq: number, frameCount: number): void {
    const sinceLast = frameCount - state._lodClassifiedAtFrame;
    if (state._lodClassifiedAtFrame >= 0 && sinceLast < 8) return;

    const coverage = distSq > 0 ? extentSq / distSq : Infinity;

    const current = state._lodStride;
    let stride = current;

    if (stride > 4 && coverage >= 0.0012) stride = 4;
    if (stride > 2 && coverage >= 0.012) stride = 2;
    if (stride > 1 && coverage >= 0.06) stride = 1;

    if (stride < 2 && coverage < 0.04) stride = 2;
    if (stride < 4 && coverage < 0.008) stride = 4;
    if (stride < 8 && coverage < 0.0008) stride = 8;

    state._lodStride = stride;
    state._lodClassifiedAtFrame = frameCount;
}

/** advance action.time on enabled actions without sampling, so visibility/LOD gates resume smoothly. */
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

/** Blends `from` out and `to` in over `duration` seconds; safe to re-call mid-fade, sets fresh targets and continues smoothly. */
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
        // usually means the generated barrel isn't imported yet
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

/** Drops the animator's cached bone order so the next tick rebuilds it; call after restructuring the rig subtree. */
export function invalidateRig(animator: AnimatorTrait): void {
    const state = animator._state as AnimatorState | null;
    if (!state) return;
    state.boneOrder.length = 0;
    state.boneIndex.clear();
}

/** Names of every descendant of `root` in the animator's rig; `root` can also match the animator's own node name. */
export function descendants(animator: AnimatorTrait, root: string, opts?: { includeRoot?: boolean }): Set<string> {
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

/** Per-room state for the animation tick; caches the `[AnimatorTrait]` query so the per-frame walk doesn't rebuild it each call. */
export type Animations = {
    animators: ReturnType<typeof query<[typeof AnimatorTrait]>>;
    /** monotonic per-room frame counter; drives LOD stride/phase gating. */
    frameCount: number;
    /** room-scoped counter handed out as `_lodPhase` to each animator on its first tick. */
    nextLodPhase: number;
};

export function init(sceneTree: SceneTree): Animations {
    return { animators: query(sceneTree, [AnimatorTrait]), frameCount: 0, nextLodPhase: 0 };
}

/** Advances every animator (time, crossfade weights, sampling, blending) and writes the result back into the rig's TransformTraits. */
export function tick(animations: Animations, resources: Resources.Resources, dt: number): void {
    animations.frameCount++;
    for (const [animator] of animations.animators) {
        const node = animator._node;
        if (!node) continue;
        if (!animator._state) animator._state = createAnimatorState();
        const state = animator._state;
        if (state._lodPhase < 0) state._lodPhase = animations.nextLodPhase++;
        tickAnimator(state, node, resources, dt, animator.lod, animations.frameCount);
    }
}

function tickAnimator(
    state: AnimatorState,
    animatorNode: Node,
    resources: Resources.Resources,
    dt: number,
    lod: boolean,
    frameCount: number,
): void {
    // must run before the visibility gate, which reads the rig's cached mesh list
    if (state.boneOrder.length === 0) {
        rebuildBoneOrder(state, animatorNode);
    }

    // skip sample/compose/publish for off-screen rigs; action.time still advances
    const rig = rigVisibility(state);
    if (!rig.visible) {
        state._lastVisible = 0;
        advanceActionTimes(state, dt);
        return;
    }

    // coverage-driven stride sampling: distant/small rigs sample every N frames and hold pose between samples; server has no camera so it's always full rate
    const wasVisible = state._lastVisible;
    state._lastVisible = 1;
    if (env.client && lod) {
        classifyLod(state, rig.distSq, rig.extentSq, frameCount);
        const forceSample = wasVisible === 0;
        if (!forceSample) {
            const stride = state._lodStride;
            const shouldSample = stride === 1 || (frameCount + state._lodPhase) % stride === 0;
            if (!shouldSample) {
                advanceActionTimes(state, dt);
                return;
            }
        }
    }

    ensureAccumCapacity(state, state.boneOrder.length);

    const activeLayers: number[] = [];
    let anyActive = false;
    const actionsList = state.actionsList;
    for (let i = 0; i < actionsList.length; i++) {
        const action = actionsList[i]!;
        if (!action.enabled) continue;

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
        // resolve channel-to-bone index map if the rig, channels, or mask changed
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

    subtreeDirty.fill(0, 0, boneCount);

    for (let li = 0; li < activeLayers.length; li++) {
        const layer = activeLayers[li]!;

        // fast path: a single replace action degenerates to the sample itself, skip layerAccum and write straight into bone TRS
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

        // replace pass for this layer: weighted sum, then override
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
                        layerAccum[o + 4]! * qx + layerAccum[o + 5]! * qy + layerAccum[o + 6]! * qz + layerAccum[o + 7]! * qw;
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

        // override trait local TRS with the per-bone normalized sum; bones with no contribution keep their prior value
        for (let bi = 0; bi < boneCount; bi++) {
            const lo = bi * LAYER_STRIDE;
            const posW = layerAccum[lo + 3]!;
            const quatTotal = layerAccum[lo + 8]!;
            const scaleW = layerAccum[lo + 12]!;
            if (posW === 0 && quatTotal === 0 && scaleW === 0) continue;

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

        // additive pass for this layer: delta on top of current trait local
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

    // boneOrder is parent-first DFS, so a single forward sweep composes every dirty bone after its parent
    for (let bi = 0; bi < boneCount; bi++) {
        if (!subtreeDirty[bi]) continue;
        const t = state.boneOrder[bi]!;

        // no-op except for rig-root bones whose parent lives outside the rig
        const parent = parentTransform(t);
        if (parent !== null && parent._dirty & TRANSFORM_DIRTY_WORLD_MATRIX) {
            getWorldMatrix(parent);
        }

        if (t._dirty !== TRANSFORM_DIRTY_ALL) {
            t._dirty = TRANSFORM_DIRTY_ALL;
            t._version++;
        }
        composeWorldMatrix(t, parent);
    }
}

/** collect every `MeshTrait` in the subtree (inclusive) into `out`. */
function collectMeshes(node: Node, out: MeshTrait[]): void {
    const mesh = getTrait(node, MeshTrait);
    if (mesh) out.push(mesh);
    for (const child of node.children) collectMeshes(child, out);
}

/** Parent-first DFS over the animator subtree, populating `boneOrder` and `boneIndex`; the animator node itself is included since gltf rigs often animate their root node too. */
function rebuildBoneOrder(state: AnimatorState, animatorNode: Node): void {
    state._cullMeshes.length = 0;
    collectMeshes(animatorNode, state._cullMeshes);
    ensureModelTrait(animatorNode);

    state.boneOrder.length = 0;
    state.bonePos.length = 0;
    state.boneQuat.length = 0;
    state.boneScale.length = 0;
    state.boneIndex.clear();
    // subtree-end size is unknown until the walk finishes, so gather into a plain array first
    const subtreeEndList: number[] = [];
    walkBones(state, animatorNode, subtreeEndList);
    ensureAccumCapacity(state, state.boneOrder.length);
    const dstE = state.subtreeEnd;
    for (let i = 0; i < subtreeEndList.length; i++) {
        dstE[i] = subtreeEndList[i]!;
    }
    state.boneOrderEpoch++;
}

/** Resolves every channel's target bone once and stashes the result on the action, so per-tick sample loops skip string-keyed lookups. */
function rebuildActionBoneIndices(action: AnimationAction, channels: ClipChannels, state: AnimatorState): void {
    const arr = channels.channels;
    let out = action._boneIndices;
    if (!out || out.length < arr.length) out = new Int32Array(arr.length);
    const mask = action.mask;
    const boneIndex = state.boneIndex;
    let translationCount = 0,
        rotationCount = 0,
        scaleCount = 0;
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
            if (p === 'translation') translationCount++;
            else if (p === 'rotation') rotationCount++;
            else scaleCount++;
        }
    }
    // bucket resolved channels by property so the tick body runs three monomorphic loops instead of a switch per channel
    const idxT = new Int32Array(translationCount);
    const idxR = new Int32Array(rotationCount);
    const idxS = new Int32Array(scaleCount);
    let translationWriteIndex = 0,
        rotationWriteIndex = 0,
        scaleWriteIndex = 0;
    for (let c = 0; c < arr.length; c++) {
        if (out[c]! < 0) continue;
        const p = arr[c]!.property;
        if (p === 'translation') idxT[translationWriteIndex++] = c;
        else if (p === 'rotation') idxR[rotationWriteIndex++] = c;
        else idxS[scaleWriteIndex++] = c;
    }
    action._idxTranslation = idxT;
    action._idxRotation = idxR;
    action._idxScale = idxS;
    action._boneIndices = out;
    action._boneIndicesEpoch = state.boneOrderEpoch;
    // _lastKeyIdx is keyed to the channels payload; a reload swaps `times`, so cached lo positions must be reset too
    let last = action._lastKeyIdx;
    if (!last || last.length < arr.length) last = new Int32Array(arr.length);
    else last.fill(0, 0, arr.length);
    action._lastKeyIdx = last;
    action._boneIndicesChannelsRef = channels;
    action._boneIndicesMaskRef = mask;
}

function walkBones(state: AnimatorState, node: Node, subtreeEndList: number[]): void {
    let myIdx = -1;
    const t = node.traits[TransformTrait.slot] as TransformTrait | undefined;
    if (t && node.name && !state.boneIndex.has(node.name)) {
        myIdx = state.boneOrder.length;
        state.boneIndex.set(node.name, myIdx);
        state.boneOrder.push(t);
        state.bonePos.push(t.position);
        state.boneQuat.push(t.quaternion);
        state.boneScale.push(t.scale);
        // placeholder, finalized on the way back up once descendants are counted
        subtreeEndList.push(0);
    }
    for (const child of node.children) walkBones(state, child, subtreeEndList);
    // post-DFS: descendants of myIdx live in [myIdx + 1, subtreeEndList[myIdx])
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

const _scratchVec3: Vec3 = vec3.create();
const _scratchVec3Ref: Vec3 = vec3.create();
const _scratchQuat: Quat = quat.create();
const _scratchQuatRef: Quat = quat.create();

/** Locates `lo` such that `times[lo] <= time < times[lo+1]`, using `last` as a cached starting guess; caller must clamp `time` to `[times[0], times[kc-1]]` first and `kc >= 2`. */
function findKeyLow(times: ArrayLike<number>, kc: number, time: number, last: number): number {
    const lo = last < 0 ? 0 : last >= kc - 1 ? kc - 2 : last;

    if (times[lo]! <= time && time < times[lo + 1]!) return lo;

    if (lo + 2 < kc) {
        if (time < times[lo + 2]! && times[lo + 1]! <= time) return lo + 1;
    }
    if (lo + 3 < kc) {
        if (time < times[lo + 3]! && times[lo + 2]! <= time) return lo + 2;
    }

    if (lo > 0 && times[lo - 1]! <= time && time < times[lo]!) return lo - 1;

    // fall back to binary search
    let l = 0;
    let h = kc - 1;
    while (h - l > 1) {
        const mid = (l + h) >> 1;
        if (times[mid]! <= time) l = mid;
        else h = mid;
    }
    return l;
}

/** Samples a translation/scale channel at `time` (STEP/LINEAR; CUBICSPLINE falls back to LINEAR), returning the found `lo` for the caller to stash on the action. */
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

/** Samples a quaternion channel at `time` (STEP/LINEAR nlerp; CUBICSPLINE falls back to nlerp). */
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
