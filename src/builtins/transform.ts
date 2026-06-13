/**
 * core transform system — world transform computation for the scene
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
 * `client/interpolation.ts` — interpolation is a rendering concern and
 * only meaningful client-side.
 */

import type { Mat4, Quat, Vec3 } from 'mathcat';
import { mat4, quat, vec3 } from 'mathcat';
import type { Node, Nodes } from '../core/scene/nodes';
import { getTrait } from '../core/scene/nodes';
import { pack } from '../core/scene/pack';
import { prop } from '../core/scene/prop';
import { control, sync, type TraitType, trait } from '../core/scene/traits';
import { traverse } from '../core/scene/traverse';

// ── dirty bitmask ───────────────────────────────────────────────────────
//
// godot-style: one int field, one bit per derived cache. setters set the
// minimal bits; getters check + clear bits as they recompute. lets the
// animator's publishToTraits stamp "worldMatrix fresh, world TRS deferred"
// without growing the trait shape with extra bool fields.
//
// bits live on TransformTrait._dirty (typed `number` in the trait body).
//   TRANSFORM_DIRTY_WORLD_MATRIX  — t.worldMatrix stale vs local TRS / ancestors
//   TRANSFORM_DIRTY_WORLD_TRS     — t.worldPosition/Quaternion/Scale stale vs worldMatrix
//   TRANSFORM_DIRTY_INTERPOLATED_MATRIX — t.interpolatedWorldMatrix stale vs local TRS / ancestor visual
//   TRANSFORM_DIRTY_INTERPOLATED_TRS    — t.interpolatedWorldPosition/Quaternion/Scale stale vs
//                                   t.interpolatedWorldMatrix (set by paths that
//                                   write interpolatedWorldMatrix without mirroring
//                                   the decomposed TRS — e.g. publishToTraits
//                                   or `interpolate()`'s nested-Interp branch).

export const TRANSFORM_DIRTY_WORLD_MATRIX = 1;
export const TRANSFORM_DIRTY_WORLD_TRS = 2;
export const TRANSFORM_DIRTY_INTERPOLATED_TRS = 4;
export const TRANSFORM_DIRTY_INTERPOLATED_MATRIX = 8;
export const TRANSFORM_DIRTY_ALL =
    TRANSFORM_DIRTY_WORLD_MATRIX |
    TRANSFORM_DIRTY_WORLD_TRS |
    TRANSFORM_DIRTY_INTERPOLATED_TRS |
    TRANSFORM_DIRTY_INTERPOLATED_MATRIX;

// ── trait definition ────────────────────────────────────────────────────

/**
 * spatial transform for a node. persisted to scene files, replicated
 * over the network.
 *
 * position/quaternion/scale are **local-space** (relative to parent).
 * they are what the user edits in the inspector, what gets persisted,
 * and what gets synced over the network. write via setPosition/
 * setQuaternion/setScale to trigger dirty-flag propagation.
 *
 * external writes (net sync, scene unpack, editor inspector) bypass the
 * setters and instead route through control.set / sync.unpack callbacks
 * — copy in-place, then markDirty. keeps the Vec3/Quat reference stable
 * for code that caches it.
 *
 * world-space values (worldPosition, worldQuaternion, worldScale,
 * worldMatrix) are computed lazily — read via getWorldPosition/
 * getWorldMatrix/etc which recompute on demand if dirty.
 *
 * visual values (interpolatedWorldPosition, interpolatedWorldQuaternion,
 * interpolatedWorldScale, interpolatedWorldMatrix) are world-space, computed
 * lazily for rendering. they parallel the world chain but compose
 * from `parent.interpolatedWorldMatrix` instead of `parent.worldMatrix`,
 * so interpolation writes upstream automatically flow down through
 * descendants. renderers read via getVisualWorld* — see below.
 */
export const TransformTrait = trait('transform', {
    // ── local-space (persisted + synced) ─────────────────────────────
    position: vec3.create(),
    quaternion: quat.create(),
    scale: vec3.fromValues(1, 1, 1),

    /** sync-only teleport counter. when it changes, client snaps instead of lerping. */
    teleport: 0,

    // ── computed world-space (runtime-only, lazy recompute) ───────────
    worldPosition: vec3.create(),
    worldQuaternion: quat.create(),
    worldScale: vec3.fromValues(1, 1, 1),
    worldMatrix: mat4.create(),

    // ── visual world-space (runtime-only, lazy recompute) ─────────────
    // parallel chain to worldMatrix used by all rendering consumers.
    // composes from `parent.interpolatedWorldMatrix * local`, so interpolation
    // writes (or animator publishToTraits) at any ancestor flow down
    // through descendants without any per-descendant flag check. for a
    // node with no interpolation influence in its ancestry, interpolatedWorldMatrix
    // recomputes to the same value as worldMatrix.
    interpolatedWorldPosition: vec3.create(),
    interpolatedWorldQuaternion: quat.create(),
    interpolatedWorldScale: vec3.fromValues(1, 1, 1),
    interpolatedWorldMatrix: mat4.create(),

    /** last seen teleport counter for snap detection */
    lastTeleport: 0,

    // points to the nearest ancestor's TransformTrait instance, or null.
    // typed as `any` to break the self-referential type cycle in the trait body;
    // call sites that read this field cast to `TransformTrait | null`.
    _parent: null as any,

    // dirty bitmask (godot-style); see TRANSFORM_DIRTY_* above.
    // starts at TRANSFORM_DIRTY_ALL so first read computes everything.
    _dirty: TRANSFORM_DIRTY_ALL,

    // sticky bit: 1 once this node's interpolatedWorld* has been touched by an
    // interpolation pass (directly, or as a descendant of an Interp node).
    // mirrors godot's `fti_global_xform_interp_set`. when 0, visual
    // getters short-circuit to the world chain. set inside `interpolate()`
    // and during `markInterpolatedDescendantsDirty`'s walk; cleared by
    // `setInterpolation(node, false)`.
    _interpolated: 0 as 0 | 1,

    // ── interpolation participation (set via setInterpolation API) ────
    /** sticky flag: does this node currently want interpolation? toggled
     *  by `setInterpolation(node, on)`. enrolls this transform in the
     *  `_interpolating` set on Nodes — per-frame iterate target. */
    interpolate: 0 as 0 | 1,
    /** local pose at the start of the current fixed tick. seeded by
     *  `setInterpolation(true)` / `resetInterpolation` and refreshed by
     *  `snapshot()` drain. only meaningful for owner-driven (fixed-step)
     *  transforms; remote-driven transforms render via chase-lerp
     *  against `position` and don't read these fields. */
    prevPosition: vec3.create(),
    prevQuaternion: quat.create(),

    // ── prediction-correction blend state (predicted physics bodies) ──
    /** frames remaining in an active correction blend; 0 when idle */
    _correctionFrames: 0,
    _correctionTarget: vec3.create(),
    _correctionTargetQuat: quat.create(),

    /** monotonic counter bumped on world-changing transitions */
    _version: 0,
});

/** instance type for TransformTrait */
export type TransformTrait = TraitType<typeof TransformTrait>;

/* ── controls (editor + persistence) ── */

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

/* ── syncs (replication) ── */

sync(TransformTrait, 'teleport', {
    schema: pack.uint32(),
    pack: (t) => t.teleport,
    unpack: (v, t) => {
        t.teleport = v;
    },
});

/**
 * position + quaternion as two independent owner-authority slices, both
 * movement-rate gated. kept separate (not a combined pose tuple) so a node
 * whose position changes every tick but whose rotation is static — or vice
 * versa — only re-emits the slice that actually changed. `setPosition` /
 * `setQuaternion` dirty just their own slice; `markTransformDirty` (physics,
 * animator, compound/world writes) dirties both.
 *
 * receiving side copies the value and invalidates world caches — the per-frame
 * `interpolate()` chase-lerps `interpolatedWorld*` toward the freshly-landed
 * pose, with a teleport edge handled via the `teleport` counter. no snapshot
 * buffer, no prev seeding.
 */
const transformPositionSync = sync(TransformTrait, 'position', {
    schema: pack.position(),
    pack: (t) => t.position,
    unpack: (p, t) => {
        vec3.copy(t.position, p);
        markWorldDirty(t);
    },
    authority: 'owner',
    rate: 'movement',
});

const transformQuaternionSync = sync(TransformTrait, 'quaternion', {
    schema: pack.quaternion(),
    pack: (t) => t.quaternion,
    unpack: (q, t) => {
        quat.copy(t.quaternion, q);
        markWorldDirty(t);
    },
    authority: 'owner',
    rate: 'movement',
});

const transformScaleSync = sync(TransformTrait, 'scale', {
    schema: pack.scale(),
    pack: (t) => t.scale,
    unpack: (s, t) => {
        vec3.copy(t.scale, s);
        markTransformDirty(t);
    },
});

/**
 * mark a transform and all its descendant transforms as fully dirty.
 * early-outs if the node is already maximally dirty (invariant: if a
 * node is fully dirty, its entire subtree is also fully dirty). walks
 * through descendants without a TransformTrait so transforms further
 * down still get marked.
 *
 * also bumps `_version` on the transition to dirty so consumers
 * (renderers, etc.) can cheaply detect "matrix changed since last upload".
 */
// mark a transform changed for world-recompute + interpolation snapshot +
// descendant invalidation, WITHOUT flagging any replication sync. callers pair
// this with the specific `transform*Sync.dirty(t)` for the slice they wrote.
function markTransformChanged(t: TransformTrait): void {
    // always enqueue for snapshot — even when _dirty is already maxed,
    // the node may have moved again this tick and prev snapshot needs to
    // catch the new pose.
    const node = t._node;
    if (node && node.nodes) node.nodes._transformDirty.add(t);
    if (t._dirty === TRANSFORM_DIRTY_ALL) return;
    t._dirty = TRANSFORM_DIRTY_ALL;
    t._version++;
    markDescendants(t._node);
}

export function markTransformDirty(t: TransformTrait): void {
    markTransformChanged(t);
    // fire replication dirty bits unconditionally (cheap single bits, and
    // freshly-created traits start at _dirty=ALL so markTransformChanged's
    // early-out would otherwise swallow the first local write's emission —
    // mountRig hit this with bone TRS on first set). full write: every slice.
    transformPositionSync.dirty(t);
    transformQuaternionSync.dirty(t);
    transformScaleSync.dirty(t);
}

/**
 * mark world transform caches dirty without triggering the snapshot
 * enqueue or replication-dirty flags. used by the buffered (remote-
 * driven) pose unpack: `position`/`quaternion` changed so any consumer
 * of world values (physics queries, audio, GPU upload, descendant
 * compose) needs the same invalidation `markTransformDirty` does — but
 * NOT the `_transformDirty` enqueue (which would copy position→prev on
 * the next snapshot and stomp the buffered path's irrelevant prev) and
 * NOT the pose/scale dirty bits (we're not the owner; we don't re-emit).
 */
export function markWorldDirty(t: TransformTrait): void {
    if (t._dirty === TRANSFORM_DIRTY_ALL) return;
    t._dirty = TRANSFORM_DIRTY_ALL;
    t._version++;
    if (t._node) markDescendants(t._node);
}

function markDescendants(node: Node): void {
    for (const child of node.children) {
        const ct = getTrait(child, TransformTrait);
        if (ct) {
            if (ct._dirty !== TRANSFORM_DIRTY_ALL) {
                ct._dirty = TRANSFORM_DIRTY_ALL;
                ct._version++;
                // no pose/scaleSync.dirty here — descendants' local TRS is
                // unchanged, only their world. replication is local-only.
                markDescendants(child);
            }
        } else {
            markDescendants(child);
        }
    }
}

/**
 * mark a subtree dirty because its *ancestry* changed (reparent, or an
 * ancestor's TransformTrait was added/removed) — `parent transform`
 * pointers shifted but local TRS values didn't.
 *
 * unlike `markDirty`, this:
 *   - has no "already maximally dirty" early-out — `_version` must bump
 *     unconditionally so consumers gated on `_version` (e.g. editor
 *     body-sync) catch the world-matrix change even when the node was
 *     already dirty from a prior local write this frame.
 *   - does NOT flag pose/scaleSync dirty — local TRS is unchanged, so
 *     replication doesn't need to retransmit. structural reparenting is
 *     replicated separately by the scene-graph layer.
 */
export function markAncestryChanged(node: Node): void {
    const t = getTrait(node, TransformTrait);
    if (t) {
        t._dirty = TRANSFORM_DIRTY_ALL;
        t._version++;
    }
    for (const child of node.children) {
        markAncestryChanged(child);
    }
}

// ── scratch mats/vecs (reused to avoid allocation) ──────────────────────

const _invParent: Mat4 = mat4.create();

// reusable walk stack for updateWorldTransform's iterative ancestor walk.
// non-reentrant — safe because updateWorldTransform never calls anything
// that re-enters it before returning.
const _walkStack: TransformTrait[] = [];

// separate stack for updateInterpolatedWorldTransform so the visual walk can
// call updateWorldTransform mid-walk (needed when the boundary parent is
// non-interpolated and its worldMatrix needs refreshing before compose).
const _interpolatedWalkStack: TransformTrait[] = [];

// ── lazy world recompute ────────────────────────────────────────────────

/**
 * compose one node's worldMatrix from its current local TRS and the
 * (assumed-fresh) parent.worldMatrix. clears TRANSFORM_DIRTY_WORLD_MATRIX;
 * the root branch also clears TRANSFORM_DIRTY_WORLD_TRS since worldP/Q/S
 * are seeded directly. caller must ensure parent.worldMatrix is fresh.
 *
 * the per-node compose is hand-inlined: quat→matrix expansion and
 * parent*local multiply are written directly here rather than calling
 * mat4.fromRotationTranslationScale + mat4.multiply, which:
 *   - eliminates the intermediate `_localMat` scratch
 *   - exploits the affine invariant (bottom row [0 0 0 1]) so the multiply
 *     touches 12 of 16 result cells with 36 mults instead of 64
 *   - is a hot path during skeleton compose and per-frame model rendering
 *
 * called by both `updateWorldTransform`'s lazy walk-up-then-down loop and
 * the animator's eager forward-DFS compose at the end of `tickAnimator`.
 */
export function composeWorldMatrix(n: TransformTrait): void {
    const parent = n._parent as TransformTrait | null;

    const q = n.quaternion;
    const p = n.position;
    const s = n.scale;
    const qx = q[0];
    const qy = q[1];
    const qz = q[2];
    const qw = q[3];
    const px = p[0];
    const py = p[1];
    const pz = p[2];
    const sx = s[0];
    const sy = s[1];
    const sz = s[2];

    // quat → 3x3 rotation, multiplied by per-axis scale.
    const x2 = qx + qx;
    const y2 = qy + qy;
    const z2 = qz + qz;
    const xx = qx * x2;
    const xy = qx * y2;
    const xz = qx * z2;
    const yy = qy * y2;
    const yz = qy * z2;
    const zz = qz * z2;
    const wx = qw * x2;
    const wy = qw * y2;
    const wz = qw * z2;

    // local matrix components (only the 9 nonzero rotation/scale cells
    // and 3 translation cells; the rest are 0/1 by affine invariant).
    const l0 = (1 - (yy + zz)) * sx;
    const l1 = (xy + wz) * sx;
    const l2 = (xz - wy) * sx;
    const l4 = (xy - wz) * sy;
    const l5 = (1 - (xx + zz)) * sy;
    const l6 = (yz + wx) * sy;
    const l8 = (xz + wy) * sz;
    const l9 = (yz - wx) * sz;
    const l10 = (1 - (xx + yy)) * sz;

    const worldMatrix = n.worldMatrix;

    if (parent === null) {
        // root: world = local. seed worldP/Q/S directly (no decompose).
        n.worldPosition[0] = px;
        n.worldPosition[1] = py;
        n.worldPosition[2] = pz;
        n.worldQuaternion[0] = qx;
        n.worldQuaternion[1] = qy;
        n.worldQuaternion[2] = qz;
        n.worldQuaternion[3] = qw;
        n.worldScale[0] = sx;
        n.worldScale[1] = sy;
        n.worldScale[2] = sz;

        worldMatrix[0] = l0;
        worldMatrix[1] = l1;
        worldMatrix[2] = l2;
        worldMatrix[3] = 0;
        worldMatrix[4] = l4;
        worldMatrix[5] = l5;
        worldMatrix[6] = l6;
        worldMatrix[7] = 0;
        worldMatrix[8] = l8;
        worldMatrix[9] = l9;
        worldMatrix[10] = l10;
        worldMatrix[11] = 0;
        worldMatrix[12] = px;
        worldMatrix[13] = py;
        worldMatrix[14] = pz;
        worldMatrix[15] = 1;

        // worldP/Q/S already fresh.
        n._dirty &= ~(TRANSFORM_DIRTY_WORLD_MATRIX | TRANSFORM_DIRTY_WORLD_TRS);
    } else {
        // affine multiply: world = parent.world * local. caller guarantees
        // parent.worldMatrix is fresh. both matrices are affine (bottom row
        // [0 0 0 1]) — exploit to skip the bottom-row computations and the
        // L[3]/L[7]/L[11]/L[15] cancellations.
        const pm = parent.worldMatrix;
        const p00 = pm[0];
        const p01 = pm[1];
        const p02 = pm[2];
        const p10 = pm[4];
        const p11 = pm[5];
        const p12 = pm[6];
        const p20 = pm[8];
        const p21 = pm[9];
        const p22 = pm[10];
        const p30 = pm[12];
        const p31 = pm[13];
        const p32 = pm[14];

        worldMatrix[0] = p00 * l0 + p10 * l1 + p20 * l2;
        worldMatrix[1] = p01 * l0 + p11 * l1 + p21 * l2;
        worldMatrix[2] = p02 * l0 + p12 * l1 + p22 * l2;
        worldMatrix[3] = 0;
        worldMatrix[4] = p00 * l4 + p10 * l5 + p20 * l6;
        worldMatrix[5] = p01 * l4 + p11 * l5 + p21 * l6;
        worldMatrix[6] = p02 * l4 + p12 * l5 + p22 * l6;
        worldMatrix[7] = 0;
        worldMatrix[8] = p00 * l8 + p10 * l9 + p20 * l10;
        worldMatrix[9] = p01 * l8 + p11 * l9 + p21 * l10;
        worldMatrix[10] = p02 * l8 + p12 * l9 + p22 * l10;
        worldMatrix[11] = 0;
        worldMatrix[12] = p00 * px + p10 * py + p20 * pz + p30;
        worldMatrix[13] = p01 * px + p11 * py + p21 * pz + p31;
        worldMatrix[14] = p02 * px + p12 * py + p22 * pz + p32;
        worldMatrix[15] = 1;

        // worldP/Q/S deferred (lazy decompose on read).
        n._dirty = (n._dirty & ~TRANSFORM_DIRTY_WORLD_MATRIX) | TRANSFORM_DIRTY_WORLD_TRS;
    }
}

/**
 * ensure world-space values are up to date. iteratively walks up to the
 * first clean ancestor (or root), then composes back down the chain via
 * `composeWorldMatrixInline`.
 */
function updateWorldTransform(t: TransformTrait): void {
    if (!(t._dirty & TRANSFORM_DIRTY_WORLD_MATRIX)) return;

    // walk up, collecting the dirty chain; stop at the first clean
    // ancestor (or root). stack[length-1] is the topmost dirty ancestor;
    // stack[0] is `t`. iterative form avoids JS function-call overhead
    // for deep skeletons.
    const stack = _walkStack;
    let cursor: TransformTrait | null = t;
    while (cursor !== null && cursor._dirty & TRANSFORM_DIRTY_WORLD_MATRIX) {
        stack.push(cursor);
        cursor = cursor._parent as TransformTrait | null;
    }

    for (let i = stack.length - 1; i >= 0; i--) {
        composeWorldMatrix(stack[i]!);
    }
    stack.length = 0;
}

// ── lazy visual recompute ───────────────────────────────────────────────
//
// parallel chain to the world recompute above. composes from
// `parent.interpolatedWorldMatrix` instead of `parent.worldMatrix`, so any
// upstream write (interpolation pass, animator publishToTraits) flows
// through descendants automatically. for a node with no Interp ancestry,
// interpolatedWorldMatrix recomputes to the same value as worldMatrix, just
// via a separate buffer.

/**
 * compose one node's interpolatedWorldMatrix from its current local TRS and the
 * (assumed-fresh) parent.interpolatedWorldMatrix. clears
 * TRANSFORM_DIRTY_INTERPOLATED_MATRIX; the root branch also clears
 * TRANSFORM_DIRTY_INTERPOLATED_TRS since interpolatedWorld P/Q/S are seeded directly.
 * caller must ensure parent.interpolatedWorldMatrix is fresh.
 */
export function composeInterpolatedWorldMatrix(n: TransformTrait): void {
    const parent = n._parent as TransformTrait | null;

    const q = n.quaternion;
    const p = n.position;
    const s = n.scale;
    const qx = q[0];
    const qy = q[1];
    const qz = q[2];
    const qw = q[3];
    const px = p[0];
    const py = p[1];
    const pz = p[2];
    const sx = s[0];
    const sy = s[1];
    const sz = s[2];

    const x2 = qx + qx;
    const y2 = qy + qy;
    const z2 = qz + qz;
    const xx = qx * x2;
    const xy = qx * y2;
    const xz = qx * z2;
    const yy = qy * y2;
    const yz = qy * z2;
    const zz = qz * z2;
    const wx = qw * x2;
    const wy = qw * y2;
    const wz = qw * z2;

    const l0 = (1 - (yy + zz)) * sx;
    const l1 = (xy + wz) * sx;
    const l2 = (xz - wy) * sx;
    const l4 = (xy - wz) * sy;
    const l5 = (1 - (xx + zz)) * sy;
    const l6 = (yz + wx) * sy;
    const l8 = (xz + wy) * sz;
    const l9 = (yz - wx) * sz;
    const l10 = (1 - (xx + yy)) * sz;

    const interpolatedWorldMatrix = n.interpolatedWorldMatrix;

    if (parent === null) {
        n.interpolatedWorldPosition[0] = px;
        n.interpolatedWorldPosition[1] = py;
        n.interpolatedWorldPosition[2] = pz;
        n.interpolatedWorldQuaternion[0] = qx;
        n.interpolatedWorldQuaternion[1] = qy;
        n.interpolatedWorldQuaternion[2] = qz;
        n.interpolatedWorldQuaternion[3] = qw;
        n.interpolatedWorldScale[0] = sx;
        n.interpolatedWorldScale[1] = sy;
        n.interpolatedWorldScale[2] = sz;

        interpolatedWorldMatrix[0] = l0;
        interpolatedWorldMatrix[1] = l1;
        interpolatedWorldMatrix[2] = l2;
        interpolatedWorldMatrix[3] = 0;
        interpolatedWorldMatrix[4] = l4;
        interpolatedWorldMatrix[5] = l5;
        interpolatedWorldMatrix[6] = l6;
        interpolatedWorldMatrix[7] = 0;
        interpolatedWorldMatrix[8] = l8;
        interpolatedWorldMatrix[9] = l9;
        interpolatedWorldMatrix[10] = l10;
        interpolatedWorldMatrix[11] = 0;
        interpolatedWorldMatrix[12] = px;
        interpolatedWorldMatrix[13] = py;
        interpolatedWorldMatrix[14] = pz;
        interpolatedWorldMatrix[15] = 1;

        n._dirty &= ~(TRANSFORM_DIRTY_INTERPOLATED_MATRIX | TRANSFORM_DIRTY_INTERPOLATED_TRS);
    } else {
        // source from parent's visual chain if parent participates in
        // interpolation; otherwise the visual chain is not maintained
        // above this point, so use parent.worldMatrix (which the caller
        // — `updateInterpolatedWorldTransform` — has refreshed at the boundary).
        const pm = parent._interpolated ? parent.interpolatedWorldMatrix : parent.worldMatrix;
        const p00 = pm[0];
        const p01 = pm[1];
        const p02 = pm[2];
        const p10 = pm[4];
        const p11 = pm[5];
        const p12 = pm[6];
        const p20 = pm[8];
        const p21 = pm[9];
        const p22 = pm[10];
        const p30 = pm[12];
        const p31 = pm[13];
        const p32 = pm[14];

        interpolatedWorldMatrix[0] = p00 * l0 + p10 * l1 + p20 * l2;
        interpolatedWorldMatrix[1] = p01 * l0 + p11 * l1 + p21 * l2;
        interpolatedWorldMatrix[2] = p02 * l0 + p12 * l1 + p22 * l2;
        interpolatedWorldMatrix[3] = 0;
        interpolatedWorldMatrix[4] = p00 * l4 + p10 * l5 + p20 * l6;
        interpolatedWorldMatrix[5] = p01 * l4 + p11 * l5 + p21 * l6;
        interpolatedWorldMatrix[6] = p02 * l4 + p12 * l5 + p22 * l6;
        interpolatedWorldMatrix[7] = 0;
        interpolatedWorldMatrix[8] = p00 * l8 + p10 * l9 + p20 * l10;
        interpolatedWorldMatrix[9] = p01 * l8 + p11 * l9 + p21 * l10;
        interpolatedWorldMatrix[10] = p02 * l8 + p12 * l9 + p22 * l10;
        interpolatedWorldMatrix[11] = 0;
        interpolatedWorldMatrix[12] = p00 * px + p10 * py + p20 * pz + p30;
        interpolatedWorldMatrix[13] = p01 * px + p11 * py + p21 * pz + p31;
        interpolatedWorldMatrix[14] = p02 * px + p12 * py + p22 * pz + p32;
        interpolatedWorldMatrix[15] = 1;

        // visual TRS deferred (lazy decompose on read).
        n._dirty = (n._dirty & ~TRANSFORM_DIRTY_INTERPOLATED_MATRIX) | TRANSFORM_DIRTY_INTERPOLATED_TRS;
    }
}

/**
 * ensure interpolatedWorld values are up to date — mirror of
 * `updateWorldTransform`, using the visual dirty bit and visual chain.
 *
 * walks up only through interpolated ancestors; stops at the first clean
 * interpolated ancestor OR the first non-interpolated ancestor. when the
 * boundary parent is non-interpolated, refreshes its worldMatrix so the
 * compose-down loop can source from it (see `composeInterpolatedWorldMatrix`
 * nested branch).
 *
 * caller (the getters) guarantees `t._interpolated === 1`, so the topmost
 * stacked node is always an Interp participant.
 */
export function updateInterpolatedWorldTransform(t: TransformTrait): void {
    if (!(t._dirty & TRANSFORM_DIRTY_INTERPOLATED_MATRIX)) return;

    const stack = _interpolatedWalkStack;
    let cursor: TransformTrait | null = t;
    while (cursor?._interpolated && cursor._dirty & TRANSFORM_DIRTY_INTERPOLATED_MATRIX) {
        stack.push(cursor);
        cursor = cursor._parent as TransformTrait | null;
    }

    // boundary parent (cursor) is null, a clean interp ancestor, or a
    // non-interp ancestor. only the non-interp case needs setup: ensure
    // its worldMatrix is fresh so the nested-compose branch can read it.
    // updateWorldTransform uses the separate _walkStack — safe to call.
    if (cursor !== null && !cursor._interpolated && cursor._dirty & TRANSFORM_DIRTY_WORLD_MATRIX) {
        updateWorldTransform(cursor);
    }

    for (let i = stack.length - 1; i >= 0; i--) {
        composeInterpolatedWorldMatrix(stack[i]!);
    }
    stack.length = 0;
}

/**
 * mark `node`'s descendant TransformTraits visual-dirty and flag them as
 * participating in interpolation. used by `interpolate()`: when an Interp
 * ancestor's interpolatedWorldMatrix is written, descendants need to recompose
 * visually on next read AND need their `_interpolated` bit set so reader
 * short-circuits flip to the visual chain.
 *
 * does NOT touch the world dirty bits — sim-side worldMatrix chain is
 * independent and stays valid.
 *
 * unlike `markDescendants`, this walk has no "already dirty" early-out:
 * newly-attached subtrees may already be dirty (from creation) but their
 * `_interpolated` bit hasn't been set yet, so we must keep recursing.
 * descendant counts under Interp roots are small (player rigs, attached
 * props) — the unconditional walk is fine.
 */
export function markInterpolatedDescendantsDirty(node: Node): void {
    for (const child of node.children) {
        const ct = getTrait(child, TransformTrait);
        if (ct) {
            ct._dirty |= TRANSFORM_DIRTY_INTERPOLATED_MATRIX | TRANSFORM_DIRTY_INTERPOLATED_TRS;
            ct._interpolated = 1;
            ct._version++;
        }
        markInterpolatedDescendantsDirty(child);
    }
}

// ── interpolation opt-in API ────────────────────────────────────────────
//
// mirrors godot's `set_physics_interpolated` / `reset_physics_interpolation`.
// participation is explicit: callers opt nodes in via `setInterpolation`,
// which seeds prev = current immediately so the first render frame blends
// from the actual pose, not from (0,0,0). without this, snapshot() doesn't
// run until the next fixed tick, and any render in between would lerp from
// the default vec3.create() — visually a teleport-from-origin.

/**
 * enroll/unenroll a node in the per-frame interpolation pass. mirrors
 * godot's `set_physics_interpolated`.
 *
 * on enable: flips `interpolate` flag, seeds prev pose from the current
 * local pose, and adds the transform to the per-room `_interpolating` set
 * — which the per-frame `interpolate()` loop in `client/interpolation.ts`
 * iterates.
 *
 * on disable: flips the flag off, clears `_interpolated` (so visual getters
 * fall back to the world chain), and removes from the set.
 *
 * idempotent: re-enabling a node that is already on is a no-op; same for
 * disabling. nodes without TransformTrait are silently ignored.
 *
 * server-safe: `_interpolating` exists on both sides but is never iterated
 * server-side. calling this from shared script code (onInit/onDispose) is
 * fine.
 */
export function setInterpolation(node: Node, on: boolean): void {
    const t = getTrait(node, TransformTrait);
    if (!t) return;
    if (on) {
        if (t.interpolate) return;
        t.interpolate = 1;
        vec3.copy(t.prevPosition, t.position);
        quat.copy(t.prevQuaternion, t.quaternion);
        // force the first interpolate() frame down the teleport branch so
        // it snaps `interpolatedWorld*` to the current pose instead of
        // chase-lerping from (0,0,0). matches godot's
        // `reset_physics_interpolation` cold-start guarantee.
        t.lastTeleport = t.teleport - 1;
        if (node.nodes) node.nodes._interpolating.add(t);
    } else {
        if (!t.interpolate) return;
        t.interpolate = 0;
        t._interpolated = 0;
        t._correctionFrames = 0;
        if (node.nodes) node.nodes._interpolating.delete(t);
    }
}

/**
 * re-seed prev pose from the node's current local TRS. mirrors godot's
 * `reset_physics_interpolation` — call after a hard snap / teleport /
 * authoritative state load where the prev pose would otherwise cause a
 * visual rubber-band on the next interpolate frame.
 *
 * no-op for nodes that aren't enrolled in interpolation.
 */
export function resetInterpolation(node: Node): void {
    const t = getTrait(node, TransformTrait);
    if (!t?.interpolate) return;
    vec3.copy(t.prevPosition, t.position);
    quat.copy(t.prevQuaternion, t.quaternion);
    // also force a teleport-edge snap on next interpolate() so the chase
    // path (if this transform is non-owner) re-seats interpolatedWorld*
    // instead of smearing across the discontinuity.
    t.lastTeleport = t.teleport - 1;
}

// ── local-space setters ─────────────────────────────────────────────────

/** set local position and mark dirty. only the position slice replicates. */
export function setPosition(t: TransformTrait, v: Vec3): void {
    t.position[0] = v[0];
    t.position[1] = v[1];
    t.position[2] = v[2];
    markTransformChanged(t);
    transformPositionSync.dirty(t);
}

/** set local quaternion and mark dirty. only the quaternion slice replicates. */
export function setQuaternion(t: TransformTrait, q: Quat): void {
    t.quaternion[0] = q[0];
    t.quaternion[1] = q[1];
    t.quaternion[2] = q[2];
    t.quaternion[3] = q[3];
    markTransformChanged(t);
    transformQuaternionSync.dirty(t);
}

/** set local scale and mark dirty. only the scale slice replicates. */
export function setScale(t: TransformTrait, v: Vec3): void {
    t.scale[0] = v[0];
    t.scale[1] = v[1];
    t.scale[2] = v[2];
    markTransformChanged(t);
    transformScaleSync.dirty(t);
}

/** set all local transform fields and mark dirty (single dirty pass). */
export function setTransform(t: TransformTrait, pos: Vec3, rot: Quat, scale: Vec3): void {
    t.position[0] = pos[0];
    t.position[1] = pos[1];
    t.position[2] = pos[2];
    t.quaternion[0] = rot[0];
    t.quaternion[1] = rot[1];
    t.quaternion[2] = rot[2];
    t.quaternion[3] = rot[3];
    t.scale[0] = scale[0];
    t.scale[1] = scale[1];
    t.scale[2] = scale[2];
    markTransformDirty(t);
}

// ── world-space getters (lazy recompute via dirty bitmask) ──────────────
//
// each getter: if its cache bit is set, recompute that piece (cheaply,
// from worldMatrix when possible), clear the bit, return the field.
// if TRANSFORM_DIRTY_WORLD_MATRIX is set, fall through to the full updateWorldTransform
// since worldMatrix is the source for all the others.

/** get world-space position, decomposing from worldMatrix if needed. */
export function getWorldPosition(t: TransformTrait): Vec3 {
    if (t._dirty & TRANSFORM_DIRTY_WORLD_MATRIX) updateWorldTransform(t);
    if (t._dirty & TRANSFORM_DIRTY_WORLD_TRS) {
        mat4.decompose(t.worldQuaternion, t.worldPosition, t.worldScale, t.worldMatrix);
        t._dirty &= ~TRANSFORM_DIRTY_WORLD_TRS;
    }
    return t.worldPosition;
}

/** get world-space quaternion, decomposing from worldMatrix if needed. */
export function getWorldQuaternion(t: TransformTrait): Quat {
    if (t._dirty & TRANSFORM_DIRTY_WORLD_MATRIX) updateWorldTransform(t);
    if (t._dirty & TRANSFORM_DIRTY_WORLD_TRS) {
        mat4.decompose(t.worldQuaternion, t.worldPosition, t.worldScale, t.worldMatrix);
        t._dirty &= ~TRANSFORM_DIRTY_WORLD_TRS;
    }
    return t.worldQuaternion;
}

/** get world-space scale, decomposing from worldMatrix if needed. */
export function getWorldScale(t: TransformTrait): Vec3 {
    if (t._dirty & TRANSFORM_DIRTY_WORLD_MATRIX) updateWorldTransform(t);
    if (t._dirty & TRANSFORM_DIRTY_WORLD_TRS) {
        mat4.decompose(t.worldQuaternion, t.worldPosition, t.worldScale, t.worldMatrix);
        t._dirty &= ~TRANSFORM_DIRTY_WORLD_TRS;
    }
    return t.worldScale;
}

/** get world matrix, recomputing if dirty. */
export function getWorldMatrix(t: TransformTrait): Mat4 {
    if (t._dirty & TRANSFORM_DIRTY_WORLD_MATRIX) updateWorldTransform(t);
    return t.worldMatrix;
}

// ── visual-space getters ───────────────────────────────────────────────
//
// renderer reads come through here. mirrors godot's
// `get_global_transform_interpolated()` fallback pattern: when `_interpolated`
// is 0, the node has never been touched by interpolation, so interpolatedWorld*
// is meaningless and we return the world chain instead. when 1, we go
// through the lazy visual chain (`updateInterpolatedWorldTransform`) which composes
// from `parent.interpolatedWorldMatrix * local`.

/** get the world matrix to render with — visual chain if interpolated, world otherwise. */
export function getVisualWorldMatrix(t: TransformTrait): Mat4 {
    if (!t._interpolated) return getWorldMatrix(t);
    if (t._dirty & TRANSFORM_DIRTY_INTERPOLATED_MATRIX) updateInterpolatedWorldTransform(t);
    return t.interpolatedWorldMatrix;
}

/** get visual world-space position, lazy-decomposing if deferred. */
export function getVisualWorldPosition(t: TransformTrait): Vec3 {
    if (!t._interpolated) return getWorldPosition(t);
    if (t._dirty & TRANSFORM_DIRTY_INTERPOLATED_MATRIX) updateInterpolatedWorldTransform(t);
    if (t._dirty & TRANSFORM_DIRTY_INTERPOLATED_TRS) {
        mat4.decompose(t.interpolatedWorldQuaternion, t.interpolatedWorldPosition, t.interpolatedWorldScale, t.interpolatedWorldMatrix);
        t._dirty &= ~TRANSFORM_DIRTY_INTERPOLATED_TRS;
    }
    return t.interpolatedWorldPosition;
}

/** get visual world-space quaternion, lazy-decomposing if deferred. */
export function getVisualWorldQuaternion(t: TransformTrait): Quat {
    if (!t._interpolated) return getWorldQuaternion(t);
    if (t._dirty & TRANSFORM_DIRTY_INTERPOLATED_MATRIX) updateInterpolatedWorldTransform(t);
    if (t._dirty & TRANSFORM_DIRTY_INTERPOLATED_TRS) {
        mat4.decompose(t.interpolatedWorldQuaternion, t.interpolatedWorldPosition, t.interpolatedWorldScale, t.interpolatedWorldMatrix);
        t._dirty &= ~TRANSFORM_DIRTY_INTERPOLATED_TRS;
    }
    return t.interpolatedWorldQuaternion;
}

/** get visual world-space scale, lazy-decomposing if deferred. */
export function getVisualWorldScale(t: TransformTrait): Vec3 {
    if (!t._interpolated) return getWorldScale(t);
    if (t._dirty & TRANSFORM_DIRTY_INTERPOLATED_MATRIX) updateInterpolatedWorldTransform(t);
    if (t._dirty & TRANSFORM_DIRTY_INTERPOLATED_TRS) {
        mat4.decompose(t.interpolatedWorldQuaternion, t.interpolatedWorldPosition, t.interpolatedWorldScale, t.interpolatedWorldMatrix);
        t._dirty &= ~TRANSFORM_DIRTY_INTERPOLATED_TRS;
    }
    return t.interpolatedWorldScale;
}

// ── batch computeWorldTransforms ────────────────────────────────────────

/**
 * walk the scene graph parent-first and clear all dirty flags by
 * recomputing world-space transforms. useful as a safety-net at
 * tick boundaries to guarantee everything is clean before interpolation.
 *
 * with lazy recompute in place, most world values will already be clean
 * (read during the tick). this just catches anything that was dirtied
 * but never read.
 */
export function computeWorldTransforms(nodes: Nodes): void {
    traverse(nodes.root, (node: Node) => {
        const t = getTrait(node, TransformTrait);
        if (!t) return;
        updateWorldTransform(t);
    });
}

// ── world↔local helpers ─────────────────────────────────────────────────

/**
 * convert a world-space position to local-space for a node.
 * fast path: if no transformed parent, world === local — just copies.
 */
export function worldToLocalPosition(t: TransformTrait, worldPos: Vec3, out: Vec3): Vec3 {
    const parent = t._parent as TransformTrait | null;
    if (parent === null) {
        if (out !== worldPos) vec3.copy(out, worldPos);
        return out;
    }
    mat4.invert(_invParent, getWorldMatrix(parent));
    // transform point by inverse parent matrix
    const x = worldPos[0];
    const y = worldPos[1];
    const z = worldPos[2];
    const m = _invParent;
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    return out;
}

const _worldToLocalQuaternion_parentQuat: Quat = quat.create();
const _worldToLocalQuaternion_invParentQuat: Quat = quat.create();

/**
 * convert a world-space quaternion to local-space for a node.
 * fast path: if no transformed parent, world === local — just copies.
 */
export function worldToLocalQuaternion(t: TransformTrait, worldQuat: Quat, out: Quat): Quat {
    const parent = t._parent as TransformTrait | null;
    if (parent === null) {
        if (out !== worldQuat) quat.copy(out, worldQuat);
        return out;
    }
    // extract parent's world rotation and invert it
    mat4.getRotation(_worldToLocalQuaternion_parentQuat, getWorldMatrix(parent));
    quat.invert(_worldToLocalQuaternion_invParentQuat, _worldToLocalQuaternion_parentQuat);
    // local = inverse(parentRot) * worldRot
    quat.multiply(out, _worldToLocalQuaternion_invParentQuat, worldQuat);
    return out;
}

/**
 * set a node's local position such that its world position matches worldPos.
 * fast path when no transformed parent — just copies into t.position.
 * marks dirty after writing.
 */
export function setWorldPosition(t: TransformTrait, worldPos: Vec3): void {
    worldToLocalPosition(t, worldPos, t.position);
    markTransformDirty(t);
}

/**
 * set a node's local quaternion such that its world rotation matches worldQuat.
 * fast path when no transformed parent — just copies into t.quaternion.
 * marks dirty after writing.
 */
export function setWorldQuaternion(t: TransformTrait, worldQuat: Quat): void {
    worldToLocalQuaternion(t, worldQuat, t.quaternion);
    markTransformDirty(t);
}

/**
 * returns true if this node has a transformed parent (parent transform pointer is set).
 * used as a fast path check — if false, local === world and no conversion is needed.
 */
export function hasTransformedParent(t: TransformTrait): boolean {
    return t._parent !== null;
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
 * subtrees with no TransformTrait are left untouched — they inherit the
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

