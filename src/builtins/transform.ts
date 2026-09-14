/**
 * core transform system, world transform computation for the scene
 * graph's TransformTrait. pure math, no rendering dependencies. callable
 * from both client and server.
 *
 * position/quaternion/scale are **local-space** (relative to parent).
 * world-space values are computed lazily via dirty-flag propagation:
 * writing a local field via setPosition/setQuaternion/setScale marks the
 * node and its descendants dirty. reading a world field via
 * getWorldPosition/getWorldMatrix/etc triggers recompute on demand.
 *
 * the per-frame snapshot+interpolate pipeline lives in
 * `render/interpolation.ts`, interpolation is a rendering concern and
 * only meaningful client-side.
 */

import type { Mat4, Quat, Vec3 } from 'math';
import { mat4, quat, vec3 } from 'math';
import { TRANSFORM_SEND_HZ } from '../core/clock';
import { pack } from '../core/scene/pack';
import { prop } from '../core/scene/prop';
import type { Node, SceneTree } from '../core/scene/scene-tree';
import { getTrait } from '../core/scene/scene-tree';
import { dirty, rate } from '../core/scene/sync/sync-rate';
import { type TraitType } from '../core/scene/traits';
import { trait } from '../core/registry';
import { control, sync } from '../core/registry';
import { traverse } from '../core/scene/traverse';
import {
    markTransformChanged,
    markWorldDirty,
    parentTransform,
    TRANSFORM_DIRTY_ALL,
    updateWorldTransform,
    worldToLocalPosition,
    worldToLocalQuaternion,
} from '../core/scene/transform';

// the runtime lives in core so the scene tree can use it without pulling this
// module's `trait()` declaration into its import graph. Re-exported here so
// every transform function keeps a single import path for callers.
export * from '../core/scene/transform';

// ── dirty bitmask ───────────────────────────────────────────────────────
//
// godot-style: one int field, one bit per derived cache. setters set the
// minimal bits; getters check + clear bits as they recompute. lets the
// animator's publishToTraits stamp "worldMatrix fresh, world TRS deferred"
// without growing the trait shape with extra bool fields.
//
// bits live on TransformTrait._dirty (typed `number` in the trait body).
//   TRANSFORM_DIRTY_WORLD_MATRIX, t.worldMatrix stale vs local TRS / ancestors
//   TRANSFORM_DIRTY_WORLD_TRS, t.worldPosition/Quaternion/Scale stale vs worldMatrix
//   TRANSFORM_DIRTY_INTERPOLATED_MATRIX, t.interpolatedWorldMatrix stale vs local TRS / ancestor visual
//   TRANSFORM_DIRTY_INTERPOLATED_TRS, t.interpolatedWorldPosition/Quaternion/Scale stale vs
//                                   t.interpolatedWorldMatrix (set by paths that
//                                   write interpolatedWorldMatrix without mirroring
//                                   the decomposed TRS, e.g. publishToTraits
//                                   or `interpolate()`'s nested-Interp branch).
//   TRANSFORM_DIRTY_WORLD_CHUNK, t.worldChunk (chunk coord of worldPosition) stale. part of
//                                ALL so every world-transform invalidation re-flags it; cleared
//                                only by getWorldChunk, which recomputes lazily from worldPosition.

export const TransformTrait = trait('transform', {
    // ── local-space (persisted + synced) ─────────────────────────────
    position: vec3.create(),
    quaternion: quat.create(),
    scale: vec3.fromValues(1, 1, 1),

    /** sync-only teleport counter. when it changes, client snaps instead of interpolating */
    teleport: 0,

    // ── computed world-space (runtime-only, lazy recompute) ───────────
    worldPosition: vec3.create(),
    worldQuaternion: quat.create(),
    worldScale: vec3.fromValues(1, 1, 1),
    worldMatrix: mat4.create(),

    // integer chunk coord of worldPosition (cx,cy,cz), lazily recomputed by
    // getWorldChunk. holds small ints, exactly representable in f32.
    worldChunk: null as Vec3 | null,

    // ── visual world-space (runtime-only, lazy recompute) ─────────────
    // parallel chain to worldMatrix used by all rendering consumers.
    // composes from `parent.interpolatedWorldMatrix * local`, so interpolation
    // writes (or animator publishToTraits) at any ancestor flow down
    // through descendants without any per-descendant flag check. for a
    // node with no interpolation influence in its ancestry, interpolatedWorldMatrix
    // recomputes to the same value as worldMatrix.
    interpolatedWorldPosition: null as Vec3 | null,
    interpolatedWorldQuaternion: null as Quat | null,
    interpolatedWorldScale: null as Vec3 | null,
    interpolatedWorldMatrix: null as Mat4 | null,

    /** last seen teleport counter for snap detection */
    lastTeleport: 0,

    // dirty bitmask (godot-style); see TRANSFORM_DIRTY_* above.
    // starts at TRANSFORM_DIRTY_ALL so first read computes everything.
    _dirty: TRANSFORM_DIRTY_ALL,

    // sticky bit: 1 once this node's interpolatedWorld* has been touched by an
    // interpolation pass (directly, or as a descendant of an Interp node).
    // mirrors godot's `fti_global_xform_interp_set`. when 0, visual
    // getters short-circuit to the world chain. set inside `interpolate()`
    // and during `sweepInterpolatedDescendants`'s walk; cleared by
    // `setInterpolation(node, false)`.
    _interpolated: 0 as 0 | 1,

    // ── interpolation participation (set via setInterpolation API) ────
    /** sticky flag: does this node currently want interpolation? toggled
     *  by `setInterpolation(node, on)`. enrolls this transform in the
     *  `interpolating` set on Nodes, per-frame iterate target. */
    interpolate: 0 as 0 | 1,
    /** local pose at the start of the current fixed tick. seeded by
     *  `setInterpolation(true)` / `resetInterpolation` and refreshed by
     *  `snapshot()` drain. only meaningful for owner-driven (fixed-step)
     *  transforms; remote-driven transforms chase the latest received pose
     *  (`_remoteInterp`) and don't read these fields. */
    prevPosition: null as Vec3 | null,
    prevQuaternion: null as Quat | null,

    /** remote chase-latest translator (client-only). null until the first remote
     *  pose lands, so owner/local/static nodes pay nothing. holds the eased render
     *  pose and per-channel cadence the sampler in render/interpolation.ts chases
     *  the live `position`/`quaternion` target with. */
    _remoteInterpolation: null as RemoteInterpolation | null,

    // ── prediction-correction blend state (predicted physics bodies) ──
    /** frames remaining in an active correction blend; 0 when idle */
    _correctionFrames: 0,
    _correctionTarget: null as Vec3 | null,
    _correctionTargetQuat: null as Quat | null,

    /** monotonic counter bumped on world-changing transitions */
    _version: 0,

    /** local TRS moved since the last `Interpolation.snapshot` drain, so `prev` still needs
     *  refreshing. Only meaningful while `interpolate` is set: `snapshot` walks
     *  `interpolating`, which `interpolate()` already walks every frame anyway, so the
     *  moved subset needs a flag rather than a second set on the scene tree. */
    _movedSinceSnapshot: 0 as 0 | 1,

    /** nearest transform-bearing ancestor, or null at a transform root. Maintained by
     *  `resolveTransformSubtree` / `resolveTransformChildren`, not derived: the read path
     *  hits it once per compose and `probe-parent-chase.ts` prices the walk at 1.20x by
     *  32k transforms. Typed `any` here and narrowed on the exported type, since a body
     *  cannot name the trait being inferred from it. */
    _parent: null as any,

    /** the transforms directly below this one, passthrough nodes already skipped. Kept in
     *  step with `_parent`. `markDescendants` walks this rather than `node.children`, which
     *  `profile-rig-world.ts` shows is the term that scales: three dependent loads per child
     *  through the node tree versus one straight to the transform. */
    _children: [] as any[],

    /** this transform's slot in `_parent._children`, or -1 when it has no parent. Godot's
     *  `index_in_parent`: without it, removal is an `indexOf` scan and detaching every child
     *  of a wide parent is O(n^2) (`probe-wide-fanout.ts`). */
    _childIndex: -1,
});

/** instance type for TransformTrait */
export type TransformTrait = Omit<TraitType<typeof TransformTrait>, '_parent' | '_children'> & {
    /** nearest transform-bearing ancestor, or null at a transform root. */
    _parent: TransformTrait | null;
    /** the transforms directly below this one, passthrough nodes skipped. */
    _children: TransformTrait[];
};

/* ── remote chase-latest translator ───────────────────────────────────────
 *
 * a non-owner transform's pose lands from the network at an irregular cadence
 * (threshold-gated, 5cm / ~1.1°). the unpack copies the newest value straight into
 * `t.position` / `t.quaternion` (the live target) and bumps a per-channel sequence.
 * the render-side translator (render/interpolation.ts) eases `current` toward that live
 * target over the observed send interval. no buffer, no render-behind clock — the target
 * is always the newest value, so a bad link can never freeze the entity on a stale pose;
 * it just eases at a slightly wrong rate and self-corrects on the next packet.
 *
 * position and quaternion are independent sync slices (a mover with static facing only
 * re-emits position), so each carries its own sequence, stamp, and ease timer. stamps
 * are the raw authoritative server time (`clock.serverLatest`) at unpack, NOT arrival
 * time, so the learned cadence is jitter-free.
 */

export type RemoteInterpolation = {
    /** eased render pose (`current`) and the ease's start pose (`old`) per channel. */
    positionOld: Vec3;
    positionCurrent: Vec3;
    quaternionOld: Quat;
    quaternionCurrent: Quat;
    /** ease duration (seconds), an EWMA of the observed send interval, per channel. */
    positionEaseDuration: number;
    quaternionEaseDuration: number;
    /** seconds elapsed into the current ease segment, per channel. */
    positionElapsed: number;
    quaternionElapsed: number;
    /** server stamp of the target the current segment is easing toward, per channel;
     *  0 until the first sync. the gap to `*PendingStamp` is the learned cadence. */
    positionStamp: number;
    quaternionStamp: number;
    /** server stamp carried by the most recent unpack, per channel (read on retarget). */
    positionPendingStamp: number;
    quaternionPendingStamp: number;
    /** unpack-bumped sequence vs the last one the render side retargeted on. a
     *  mismatch means a fresh pose landed and the ease should restart. */
    positionSequence: number;
    positionSeen: number;
    quaternionSequence: number;
    quaternionSeen: number;
    /** 0 until `current` has been seeded from a real pose (first frame / teleport). */
    initialized: 0 | 1;
};

function newRemoteInterpolation(): RemoteInterpolation {
    return {
        positionOld: vec3.create(),
        positionCurrent: vec3.create(),
        quaternionOld: quat.create(),
        quaternionCurrent: quat.create(),
        positionEaseDuration: 0,
        quaternionEaseDuration: 0,
        positionElapsed: 0,
        quaternionElapsed: 0,
        positionStamp: 0,
        quaternionStamp: 0,
        positionPendingStamp: 0,
        quaternionPendingStamp: 0,
        positionSequence: 0,
        positionSeen: 0,
        quaternionSequence: 0,
        quaternionSeen: 0,
        initialized: 0,
    };
}

/** lazily allocate the translator on the first remote pose. owner/local/static nodes
 *  never call this, so they carry a null field and pay nothing. */
export function ensureRemoteInterpolation(t: TransformTrait): RemoteInterpolation {
    if (t._remoteInterpolation === null) t._remoteInterpolation = newRemoteInterpolation();
    return t._remoteInterpolation;
}

/** record a freshly-unpacked remote position: stash the stamp and bump the sequence so
 *  the render side restarts its ease toward the new `t.position` target. */
export function noteRemotePosition(t: TransformTrait, time: number): void {
    const remote = ensureRemoteInterpolation(t);
    remote.positionPendingStamp = time;
    remote.positionSequence++;
}

/** record a freshly-unpacked remote quaternion (see `noteRemotePosition`). */
export function noteRemoteQuaternion(t: TransformTrait, time: number): void {
    const remote = ensureRemoteInterpolation(t);
    remote.quaternionPendingStamp = time;
    remote.quaternionSequence++;
}

/* ── controls (editor + persistence) ── */

/* ── the transform hierarchy ── */

/**
 * The transform hierarchy is the node hierarchy with the non-bearers contracted out: a
 * transform composes against the first bearer above it, however many plain nodes intervene.
 * It is derived on demand rather than materialised, so attaching, detaching and reparenting
 * a node maintain nothing.
 *
 * Measured before choosing this: real scenes run 99.9% bearer density with zero intervening
 * plain nodes (`bench/probe-gap-density.ts`), which is the density at which the walk costs
 * ~1.1x a stored pointer (`bench/probe-transform-contraction.ts`) and 92.6% of transforms
 * are roots whose stored pointer would have been null anyway.
 */

control(TransformTrait, 'position', {
    label: 'Position',
    schema: prop.vec3(),
    get: (t) => t.position,
    set: (t, v) => {
        vec3.copy(t.position, v);
        markTransformDirty(t);
    },
});

control(TransformTrait, 'quaternion', {
    label: 'Rotation',
    schema: prop.quaternion(),
    get: (t) => t.quaternion,
    set: (t, v) => {
        quat.copy(t.quaternion, v);
        markTransformDirty(t);
    },
});

control(TransformTrait, 'scale', {
    label: 'Scale',
    schema: prop.vec3(),
    get: (t) => t.scale,
    set: (t, v) => {
        vec3.copy(t.scale, v);
        markTransformDirty(t);
    },
});

sync(TransformTrait, 'teleport', {
    schema: pack.uint32(),
    pack: (t) => t.teleport,
    unpack: (v, t) => {
        t.teleport = v;
    },
});

/**
 * position + quaternion as two independent owner-authority slices, both emitted on
 * byte change (`diff`) and capped at `TRANSFORM_SEND_HZ` (core/clock, the same constant
 * the render-behind buffer sizes off). a resting body writes byte-stable
 * values (physics sleeps, controllers clamp to zero) so its slice goes silent, and
 * the settle-to-rest is just the last byte change — it lands like any other keyframe,
 * no separate "came to rest" signal needed. kept separate (not a combined pose tuple)
 * so a node whose position changes every tick but whose rotation is static, or vice
 * versa, only re-emits the slice that actually changed. `setPosition` /
 * `setQuaternion` dirty just their own slice; `markTransformDirty` (physics, animator,
 * compound/world writes) dirties both.
 *
 * receiving side copies the value into the live field (world caches invalidated for
 * matrix/raycast/debug readers) and, client-side, notes the arrival so the per-frame
 * remote chase-latest translator (`interpolate()`) restarts its ease toward the new
 * live target. the arrival stamp is the raw authoritative server time
 * (`clock.serverLatest`, refreshed per-tick by `server_clock`), NOT arrival time, so
 * the learned send cadence stays jitter-free. teleport edges are handled by the
 * sampler via the `teleport` counter.
 */
const transformPositionSync = sync(TransformTrait, 'position', {
    schema: pack.position(),
    pack: (t) => t.position,
    unpack: (p, t) => {
        vec3.copy(t.position, p);
        markWorldDirty(t);
        const runtime = t._node?.scene?.context;
        if (runtime?.client) noteRemotePosition(t, runtime.clock.serverLatest);
    },
    authority: 'owner',
    dirty: dirty.diff(), // any change to the packed pose; byte-stable at rest → silent
    rate: rate.hz(TRANSFORM_SEND_HZ), // cadence + chase rate derive from one constant (core/clock)
});

const transformQuaternionSync = sync(TransformTrait, 'quaternion', {
    schema: pack.quaternion(),
    pack: (t) => t.quaternion,
    unpack: (q, t) => {
        quat.copy(t.quaternion, q);
        markWorldDirty(t);
        const runtime = t._node?.scene?.context;
        if (runtime?.client) noteRemoteQuaternion(t, runtime.clock.serverLatest);
    },
    authority: 'owner',
    dirty: dirty.diff(), // matched to position
    rate: rate.hz(TRANSFORM_SEND_HZ), // matched to position
});

const transformScaleSync = sync(TransformTrait, 'scale', {
    schema: pack.scale(),
    pack: (t) => t.scale,
    unpack: (s, t) => {
        vec3.copy(t.scale, s);
        markTransformDirty(t);
    },
});

export function markTransformDirty(transform: TransformTrait): void {
    markTransformChanged(transform);
    // fire replication dirty bits unconditionally (cheap single bits, and
    // freshly-created traits start at _dirty=ALL so markTransformChanged's
    // early-out would otherwise swallow the first local write's emission,
    // mountRig hit this with bone TRS on first set). full write: every slice.
    transformPositionSync.dirty(transform);
    transformQuaternionSync.dirty(transform);
    transformScaleSync.dirty(transform);
}

/**
 * enroll/unenroll a node in the per-frame interpolation pass. mirrors
 * godot's `set_physics_interpolated`.
 *
 * on enable: flips `interpolate` flag, seeds prev pose from the current
 * local pose, and adds the transform to the per-room `interpolating` set,
 * which the per-frame `interpolate()` loop in `render/interpolation.ts`
 * iterates.
 *
 * on disable: flips the flag off, clears `_interpolated` (so visual getters
 * fall back to the world chain), and removes from the set.
 *
 * idempotent: re-enabling a node that is already on is a no-op; same for
 * disabling. nodes without TransformTrait are silently ignored.
 *
 * server-safe: `interpolating` exists on both sides but is never iterated
 * server-side. calling this from shared script code (onInit/onDispose) is
 * fine.
 */
export function setInterpolation(node: Node, on: boolean): void {
    const transform = getTrait(node, TransformTrait);
    if (!transform) return;
    if (on) {
        if (transform.interpolate) return;
        transform.interpolate = 1;
        transform.prevPosition = vec3.clone(transform.position);
        transform.prevQuaternion = quat.clone(transform.quaternion);
        // force the first interpolate() frame down the teleport branch so
        // it snaps `interpolatedWorld*` to the current pose instead of
        // chase-lerping from (0,0,0). matches godot's
        // `reset_physics_interpolation` cold-start guarantee.
        transform.lastTeleport = transform.teleport - 1;
        if (node.scene) node.scene.interpolating.add(transform);
    } else {
        if (!transform.interpolate) return;
        transform.interpolate = 0;
        transform._interpolated = 0;
        transform._correctionFrames = 0;
        if (node.scene) node.scene.interpolating.delete(transform);
    }
}

/**
 * re-seed prev pose from the node's current local TRS. mirrors godot's
 * `reset_physics_interpolation`, call after a hard snap / teleport /
 * authoritative state load where the prev pose would otherwise cause a
 * visual rubber-band on the next interpolate frame.
 *
 * no-op for nodes that aren't enrolled in interpolation.
 */
export function resetInterpolation(node: Node): void {
    const transform = getTrait(node, TransformTrait);
    if (!transform?.interpolate) return;
    vec3.copy(transform.prevPosition!, transform.position);
    quat.copy(transform.prevQuaternion!, transform.quaternion);
    // also force a teleport-edge snap on next interpolate() so the chase
    // path (if this transform is non-owner) re-seats interpolatedWorld*
    // instead of smearing across the discontinuity.
    transform.lastTeleport = transform.teleport - 1;
}

// ── local-space setters ─────────────────────────────────────────────────

/** set local position and mark dirty. only the position slice replicates. */
export function setPosition(transform: TransformTrait, position: Vec3): void {
    transform.position[0] = position[0];
    transform.position[1] = position[1];
    transform.position[2] = position[2];
    markTransformChanged(transform);
    transformPositionSync.dirty(transform);
}

/** set local quaternion and mark dirty. only the quaternion slice replicates. */
export function setQuaternion(transform: TransformTrait, quaternion: Quat): void {
    transform.quaternion[0] = quaternion[0];
    transform.quaternion[1] = quaternion[1];
    transform.quaternion[2] = quaternion[2];
    transform.quaternion[3] = quaternion[3];
    markTransformChanged(transform);
    transformQuaternionSync.dirty(transform);
}

/** set local scale and mark dirty. only the scale slice replicates. */
export function setScale(transform: TransformTrait, scale: Vec3): void {
    transform.scale[0] = scale[0];
    transform.scale[1] = scale[1];
    transform.scale[2] = scale[2];
    markTransformChanged(transform);
    transformScaleSync.dirty(transform);
}

/** set all local transform fields and mark dirty (single dirty pass). */
export function setTransform(transform: TransformTrait, position: Vec3, quaternion: Quat, scale: Vec3): void {
    transform.position[0] = position[0];
    transform.position[1] = position[1];
    transform.position[2] = position[2];
    transform.quaternion[0] = quaternion[0];
    transform.quaternion[1] = quaternion[1];
    transform.quaternion[2] = quaternion[2];
    transform.quaternion[3] = quaternion[3];
    transform.scale[0] = scale[0];
    transform.scale[1] = scale[1];
    transform.scale[2] = scale[2];
    markTransformDirty(transform);
}

// ── world-space getters (lazy recompute via dirty bitmask) ──────────────
//
// each getter: if its cache bit is set, recompute that piece (cheaply,
// from worldMatrix when possible), clear the bit, return the field.
// if TRANSFORM_DIRTY_WORLD_MATRIX is set, fall through to the full updateWorldTransform
// since worldMatrix is the source for all the others.

/**
 * walk the scene graph parent-first and clear all dirty flags by
 * recomputing world-space transforms. useful as a safety-net at
 * tick boundaries to guarantee everything is clean before interpolation.
 *
 * with lazy recompute in place, most world values will already be clean
 * (read during the tick). this just catches anything that was dirtied
 * but never read.
 */
export function computeWorldTransforms(nodes: SceneTree): void {
    traverse(nodes.root, (node: Node) => {
        const transform = getTrait(node, TransformTrait);
        if (!transform) return;
        updateWorldTransform(transform);
    });
}

// ── world↔local helpers ─────────────────────────────────────────────────

/**
 * set a node's local position such that its world position matches worldPos.
 * fast path when no transformed parent, just copies into t.position.
 * marks dirty after writing.
 */
export function setWorldPosition(transform: TransformTrait, worldPosition: Vec3): void {
    worldToLocalPosition(transform, worldPosition, transform.position);
    markTransformDirty(transform);
}

/**
 * set a node's local quaternion such that its world rotation matches worldQuat.
 * fast path when no transformed parent, just copies into t.quaternion.
 * marks dirty after writing.
 */
export function setWorldQuaternion(transform: TransformTrait, worldQuaternion: Quat): void {
    worldToLocalQuaternion(transform, worldQuaternion, transform.quaternion);
    markTransformDirty(transform);
}

/**
 * returns true if this node has a transformed parent (parent transform pointer is set).
 * used as a fast path check, if false, local === world and no conversion is needed.
 */
export function hasTransformedParent(transform: TransformTrait): boolean {
    return parentTransform(transform) !== null;
}

// ── collapse (premultiply anchor.local into descendants) ────────────────

const _collapseRotated: Vec3 = vec3.create();
const _collapseQuat: Quat = quat.create();

/**
 * compose `anchor.local` into each direct-child subtree's first-encountered
 * TransformTrait. used by the play-mode prefab bake to drop the anchor's
 * transform: after this call, each affected descendant's world pose is
 * unchanged, and the anchor's TransformTrait can be safely removed.
 *
 * for each direct child of `anchor`, DFS until a TransformTrait is found
 * and compose:
 *   newLocal = anchor.local ∘ childLocal
 *
 * subtrees with no TransformTrait are left untouched, they inherit the
 * anchor's parent transform once the anchor's transform is removed.
 *
 * callers are responsible for `removeTrait(anchor, TransformTrait)` and
 * any downstream sync (markAncestryChanged on descendants happens
 * automatically via removeTrait's child-pointer update).
 */
export function collapseTransformIntoChildren(anchor: Node): void {
    const at = getTrait(anchor, TransformTrait);
    if (!at) return;
    for (const child of anchor.children) {
        collapseFirstTransformBelow(child, at);
    }
}

function collapseFirstTransformBelow(node: Node, anchor: TransformTrait): void {
    const t = getTrait(node, TransformTrait);
    if (t) {
        composeLocalIntoChild(anchor, t);
        markTransformDirty(t);
        return;
    }
    for (const child of node.children) {
        collapseFirstTransformBelow(child, anchor);
    }
}

/**
 * child.local := anchor.local ∘ child.local (TRS compose).
 * pos: anchorPos + anchorQuat ⋅ (anchorScale ⊙ childPos)
 * quat: anchorQuat * childQuat
 * scale: anchorScale ⊙ childScale
 */
function composeLocalIntoChild(anchor: TransformTrait, child: TransformTrait): void {
    const ap = anchor.position;
    const aq = anchor.quaternion;
    const as = anchor.scale;

    // scale child.position component-wise by anchor.scale, then rotate by anchor.quat.
    _collapseRotated[0] = child.position[0] * as[0];
    _collapseRotated[1] = child.position[1] * as[1];
    _collapseRotated[2] = child.position[2] * as[2];
    vec3.transformQuat(_collapseRotated, _collapseRotated, aq);
    child.position[0] = ap[0] + _collapseRotated[0];
    child.position[1] = ap[1] + _collapseRotated[1];
    child.position[2] = ap[2] + _collapseRotated[2];

    quat.multiply(_collapseQuat, aq, child.quaternion);
    quat.copy(child.quaternion, _collapseQuat);

    child.scale[0] *= as[0];
    child.scale[1] *= as[1];
    child.scale[2] *= as[2];
}
