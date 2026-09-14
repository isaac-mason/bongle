/**
 * core/scene/transform.ts, the transform runtime: parent graph, dirty-flag
 * invalidation, and lazy world/visual matrix composition.
 *
 * Split from `builtins/transform.ts` so that importing the transform RUNTIME
 * does not execute a `trait()` declaration. `scene-tree.ts` needs this runtime
 * (transform roots, region indexing, reparent invalidation), and anything the
 * registry imports must be free of module-scope declarations — otherwise a
 * declaration runs before the registry's own stores exist.
 *
 * So the line is: DERIVING structure lives here; AUTHORING lives in
 * `builtins/transform.ts` alongside the trait declaration, its controls and
 * syncs, and every setter (the setters need the sync handles the declaration
 * creates). `builtins/transform.ts` re-exports this file's surface, so callers
 * keep importing transform functions from one place.
 *
 * position/quaternion/scale are **local-space** (relative to parent). World
 * values are computed lazily via dirty-flag propagation: a local write marks
 * the node and its descendants dirty; a world read recomputes on demand.
 */

import type { Mat4, Quat, Vec3 } from 'math';
import { mat4, quat, vec3 } from 'math';
import type { TransformTrait } from '../../builtins/transform';
import { traitSlots } from '../registry';
import { toChunkCoord } from '../voxels/voxels';
import type { Node, SceneTree } from './scene-tree';
import { markNodeDirty } from './scene-tree';

/**
 * The transform trait's runtime slot. Read through the registry rather than
 * off the trait handle: the handle lives in `builtins/transform.ts`, and
 * importing that module would run its `trait()` declaration — the exact thing
 * this split exists to avoid. The slot is assigned when the trait is declared,
 * which is always before any of these functions can run.
 */
export function transformSlot(): number {
    return traitSlots.transform!;
}

export const TRANSFORM_DIRTY_WORLD_MATRIX = 1;
export const TRANSFORM_DIRTY_WORLD_TRS = 2;
export const TRANSFORM_DIRTY_INTERPOLATED_TRS = 4;
export const TRANSFORM_DIRTY_INTERPOLATED_MATRIX = 8;
export const TRANSFORM_DIRTY_WORLD_CHUNK = 16;
export const TRANSFORM_DIRTY_ALL =
    TRANSFORM_DIRTY_WORLD_MATRIX |
    TRANSFORM_DIRTY_WORLD_TRS |
    TRANSFORM_DIRTY_INTERPOLATED_TRS |
    TRANSFORM_DIRTY_INTERPOLATED_MATRIX |
    TRANSFORM_DIRTY_WORLD_CHUNK;

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
 * setters and instead route through control.set / sync.unpack callbacks,
 * copy in-place, then markDirty. keeps the Vec3/Quat reference stable
 * for code that caches it.
 *
 * world-space values (worldPosition, worldQuaternion, worldScale,
 * worldMatrix) are computed lazily, read via getWorldPosition/
 * getWorldMatrix/etc which recompute on demand if dirty.
 *
 * visual values (interpolatedWorldPosition, interpolatedWorldQuaternion,
 * interpolatedWorldScale, interpolatedWorldMatrix) are world-space, computed
 * lazily for rendering. they parallel the world chain but compose
 * from `parent.interpolatedWorldMatrix` instead of `parent.worldMatrix`,
 * so interpolation writes upstream automatically flow down through
 * descendants. renderers read via getVisualWorld*, see below.
 */
/** allocate the visual pose. Every path that sets `_interpolated = 1` calls this, which is what
 *  lets the readers behind that flag treat the four fields as present. */
export function ensureInterpolatedPose(transform: TransformTrait): void {
    if (transform.interpolatedWorldMatrix !== null) return;
    transform.interpolatedWorldPosition = vec3.create();
    transform.interpolatedWorldQuaternion = quat.create();
    transform.interpolatedWorldScale = vec3.fromValues(1, 1, 1);
    transform.interpolatedWorldMatrix = mat4.create();
}

/** nearest transform at or above `node`, or null when there is none. */
function nearestTransformAt(node: Node | null): TransformTrait | null {
    for (let cur = node; cur !== null; cur = cur.parent) {
        const t = cur.traits[transformSlot()] as TransformTrait | undefined;
        if (t !== undefined) return t;
    }
    return null;
}

/** the transform `transform` composes against: the nearest one strictly above its node. */
export function parentTransform(transform: TransformTrait): TransformTrait | null {
    return transform._parent;
}

/** swap-pop `child` out of `parent._children`. */
function removeTransformChild(parent: TransformTrait, child: TransformTrait): void {
    const children = parent._children;
    const index = child._childIndex;
    const last = children.length - 1;
    // the index is authoritative, but stay defensive: a stale one would corrupt the list.
    if (index < 0 || index > last || children[index] !== child) return;
    if (index !== last) {
        const moved = children[last]!;
        children[index] = moved;
        moved._childIndex = index;
    }
    children.pop();
    child._childIndex = -1;
}

/** re-point one transform, keeping both child lists in step. Invalidation is the caller's
 *  job, so a subtree walk dirties once rather than once per re-pointed bearer. */
function setTransformParent(own: TransformTrait, next: TransformTrait | null): void {
    const prev = own._parent;
    if (prev === next) return;
    if (prev !== null) removeTransformChild(prev, own);
    own._parent = next;
    if (next !== null) {
        own._childIndex = next._children.length;
        next._children.push(own);
    }
}

/**
 * Re-point the transforms at the top of `node`'s subtree at `inherited`, stopping at each
 * bearer: below one, transforms already point at it and nothing above changed that.
 */
function retargetTransforms(node: Node, inherited: TransformTrait | null): void {
    const own = node.traits[transformSlot()] as TransformTrait | undefined;
    if (own !== undefined) {
        setTransformParent(own, inherited);
        return;
    }
    const children = node.children;
    for (let i = 0; i < children.length; i++) retargetTransforms(children[i]!, inherited);
}

/* ── syncs (replication) ── */

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
export function markTransformChanged(transform: TransformTrait): void {
    // enqueue for the interpolation snapshot, even when _dirty is already maxed: the node
    // may have moved again this tick and prev needs to catch the new pose.
    //
    // Gated on `interpolate` at the ENQUEUE, not at the drain, which is Godot's
    // `notify_transform`: only a node that asked for transform notifications joins
    // `xform_change_list`. `snapshot` skips `!interpolate` anyway, so enqueueing them was a
    // hash insert per moved transform per frame for something immediately discarded. A
    // transform that starts interpolating later seeds its own prev in `setInterpolation`,
    // so nothing depends on having been enqueued beforehand.
    if (transform.interpolate) transform._movedSinceSnapshot = 1;
    if (transform._dirty === TRANSFORM_DIRTY_ALL) return;
    transform._dirty = TRANSFORM_DIRTY_ALL;
    transform._version++;
    markDescendants(transform);
}

/**
 * mark world transform caches dirty without triggering the snapshot
 * enqueue or replication-dirty flags. used by the buffered (remote-
 * driven) pose unpack: `position`/`quaternion` changed so any consumer
 * of world values (physics queries, audio, GPU upload, descendant
 * compose) needs the same invalidation `markTransformDirty` does, but
 * NOT the `_movedSinceSnapshot` flag (which would copy position→prev on
 * the next snapshot and stomp the buffered path's irrelevant prev) and
 * NOT the pose/scale dirty bits (we're not the owner; we don't re-emit).
 */
export function markWorldDirty(transform: TransformTrait): void {
    if (transform._dirty === TRANSFORM_DIRTY_ALL) return;
    transform._dirty = TRANSFORM_DIRTY_ALL;
    transform._version++;
    markDescendants(transform);
}

/** Mark every transform below `transform` world-dirty, over the maintained child list. */
function markDescendants(transform: TransformTrait): void {
    const children = transform._children;
    for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        // a transform already maximally dirty has an equally dirty subtree; prune.
        if (child._dirty === TRANSFORM_DIRTY_ALL) continue;
        // descendants' local TRS is unchanged, only their world, so no sync dirty here.
        child._dirty = TRANSFORM_DIRTY_ALL;
        child._version++;
        markDescendants(child);
    }
}

/** drop a transform that is leaving the tree, so nothing keeps walking or ticking it. */
export function releaseTransform(sceneTree: SceneTree | null, transform: TransformTrait): void {
    if (transform._parent !== null) removeTransformChild(transform._parent, transform);
    transform._parent = null;
    if (sceneTree !== null) {
        sceneTree.interpolating.delete(transform);
    }
}

/**
 * Mark a subtree dirty because its *ancestry* changed (reparent, or an ancestor's
 * TransformTrait was added/removed): what each transform composes against shifted, but
 * local TRS values didn't.
 *
 * Nothing is stored to repair, but the cached world values are stale and must be dropped.
 * Unlike `markTransformChanged`, this:
 *   - has no "already maximally dirty" early-out, `_version` must bump unconditionally so
 *     consumers gated on `_version` (e.g. editor body-sync) catch the world-matrix change
 *     even when the node was already dirty from a prior local write this frame.
 *   - does NOT flag pose/scaleSync dirty, local TRS is unchanged, so replication doesn't
 *     need to retransmit. Structural reparenting is replicated separately by the
 *     scene-graph layer.
 *
 * `topmost` tracks whether we are still above the first bearer on this branch: those are
 * the transforms whose `isTransformRoot` status can have flipped, which the AOI index keys
 * on, so they get a replication revisit as well.
 */
function invalidateFrom(node: Node, scene: SceneTree | null, topmost: boolean): void {
    const transform = node.traits[transformSlot()] as TransformTrait | undefined;
    if (transform !== undefined) {
        transform._dirty = TRANSFORM_DIRTY_ALL;
        transform._version++;
        if (topmost && scene !== null) markNodeDirty(scene, node);
        topmost = false;
    }
    const children = node.children;
    for (let i = 0; i < children.length; i++) invalidateFrom(children[i]!, scene, topmost);
}

/**
 * `node`'s ancestry changed (attach, detach, reparent). `movedFrom` is the old parent of an
 * already-live node: when it contracted to the same transform, nothing inside the subtree
 * composes differently, so two climbs replace a whole descent.
 */
export function invalidateTransformAncestry(node: Node, movedFrom?: Node | null): void {
    const inherited = nearestTransformAt(node.parent);
    if (movedFrom !== undefined && movedFrom !== null && nearestTransformAt(movedFrom) === inherited) return;
    retargetTransforms(node, inherited);
    invalidateFrom(node, node.scene, true);
}

/** a transform was added to or removed from `node` itself, so its descendants compose anew. */
export function invalidateTransformChildren(node: Node): void {
    const scene = node.scene;
    const own = node.traits[transformSlot()] as TransformTrait | undefined;
    // `node`'s own transform-root status flips too: it just gained or lost the trait.
    if (scene !== null && own !== undefined) markNodeDirty(scene, node);
    if (own !== undefined) setTransformParent(own, nearestTransformAt(node.parent));
    const inherited = own ?? nearestTransformAt(node.parent);
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
        retargetTransforms(children[i]!, inherited);
        invalidateFrom(children[i]!, scene, true);
    }
}

// ── scratch mats/vecs (reused to avoid allocation) ──────────────────────

const _invParent = mat4.create();

// reusable walk stack for updateWorldTransform's iterative ancestor walk.
// non-reentrant, safe because updateWorldTransform never calls anything
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
export function composeWorldMatrix(transform: TransformTrait, parent: TransformTrait | null): void {
    const q = transform.quaternion;
    const p = transform.position;
    const s = transform.scale;
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

    const worldMatrix = transform.worldMatrix;

    if (parent === null) {
        // root: world = local. seed worldP/Q/S directly (no decompose).
        transform.worldPosition[0] = px;
        transform.worldPosition[1] = py;
        transform.worldPosition[2] = pz;
        transform.worldQuaternion[0] = qx;
        transform.worldQuaternion[1] = qy;
        transform.worldQuaternion[2] = qz;
        transform.worldQuaternion[3] = qw;
        transform.worldScale[0] = sx;
        transform.worldScale[1] = sy;
        transform.worldScale[2] = sz;

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
        transform._dirty &= ~(TRANSFORM_DIRTY_WORLD_MATRIX | TRANSFORM_DIRTY_WORLD_TRS);
    } else {
        // affine multiply: world = parent.world * local. caller guarantees
        // parent.worldMatrix is fresh. both matrices are affine (bottom row
        // [0 0 0 1]), exploit to skip the bottom-row computations and the
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
        transform._dirty = (transform._dirty & ~TRANSFORM_DIRTY_WORLD_MATRIX) | TRANSFORM_DIRTY_WORLD_TRS;
    }
}

/**
 * ensure world-space values are up to date. iteratively walks up to the
 * first clean ancestor (or root), then composes back down the chain via
 * `composeWorldMatrixInline`.
 */
export function updateWorldTransform(transform: TransformTrait): void {
    if (!(transform._dirty & TRANSFORM_DIRTY_WORLD_MATRIX)) return;

    // walk up, collecting the dirty chain; stop at the first clean
    // ancestor (or root). stack[length-1] is the topmost dirty ancestor;
    // stack[0] is `t`. iterative form avoids JS function-call overhead
    // for deep skeletons.
    const stack = _walkStack;
    let cursor: TransformTrait | null = transform;
    while (cursor !== null && cursor._dirty & TRANSFORM_DIRTY_WORLD_MATRIX) {
        stack.push(cursor);
        cursor = parentTransform(cursor);
    }

    // the stack IS the chain, so `stack[i + 1]` is `stack[i]`'s parent; only the topmost
    // needs `cursor`, the first clean ancestor the walk stopped at. No second resolve.
    const top = stack.length - 1;
    for (let i = top; i >= 0; i--) {
        composeWorldMatrix(stack[i]!, i === top ? cursor : stack[i + 1]!);
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
export function composeInterpolatedWorldMatrix(transform: TransformTrait, parent: TransformTrait | null): void {
    const q = transform.quaternion;
    const p = transform.position;
    const s = transform.scale;

    // Translation-only local (identity rotation, unit scale): the parent's 3x3 passes
    // through untouched and only the translation column composes. Skips both the
    // quaternion-to-basis derivation below and the 3x3 concatenation, 54 multiplies down
    // to 9. Every shipped avatar is 100% translation-only at rest and ~65% of its
    // transforms stay that way while running (`probe-identity-fraction.mjs`), because
    // only the bones an animation or `applyLimb` rotates leave the case.
    //
    // Read inline rather than cached on a flag: the animator writes `t.quaternion` in
    // place through `AnimatorTrait.boneQuat`, so a flag would have to be maintained at
    // every publish point and would be silently wrong the day one is missed. These six
    // comparisons read the exact values the compose is about to use.
    if (parent !== null && q[0] === 0 && q[1] === 0 && q[2] === 0 && s[0] === 1 && s[1] === 1 && s[2] === 1) {
        const pm = parent._interpolated ? parent.interpolatedWorldMatrix! : parent.worldMatrix;
        const out = transform.interpolatedWorldMatrix!;
        const lx = p[0];
        const ly = p[1];
        const lz = p[2];
        const p00 = pm[0]!;
        const p01 = pm[1]!;
        const p02 = pm[2]!;
        const p10 = pm[4]!;
        const p11 = pm[5]!;
        const p12 = pm[6]!;
        const p20 = pm[8]!;
        const p21 = pm[9]!;
        const p22 = pm[10]!;
        out[0] = p00;
        out[1] = p01;
        out[2] = p02;
        out[3] = 0;
        out[4] = p10;
        out[5] = p11;
        out[6] = p12;
        out[7] = 0;
        out[8] = p20;
        out[9] = p21;
        out[10] = p22;
        out[11] = 0;
        out[12] = p00 * lx + p10 * ly + p20 * lz + pm[12]!;
        out[13] = p01 * lx + p11 * ly + p21 * lz + pm[13]!;
        out[14] = p02 * lx + p12 * ly + p22 * lz + pm[14]!;
        out[15] = 1;
        transform._dirty = (transform._dirty & ~TRANSFORM_DIRTY_INTERPOLATED_MATRIX) | TRANSFORM_DIRTY_INTERPOLATED_TRS;
        return;
    }
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

    const interpolatedWorldMatrix = transform.interpolatedWorldMatrix!;

    if (parent === null) {
        const interpolatedWorldPosition = transform.interpolatedWorldPosition!;
        const interpolatedWorldQuaternion = transform.interpolatedWorldQuaternion!;
        const interpolatedWorldScale = transform.interpolatedWorldScale!;
        interpolatedWorldPosition[0] = px;
        interpolatedWorldPosition[1] = py;
        interpolatedWorldPosition[2] = pz;
        interpolatedWorldQuaternion[0] = qx;
        interpolatedWorldQuaternion[1] = qy;
        interpolatedWorldQuaternion[2] = qz;
        interpolatedWorldQuaternion[3] = qw;
        interpolatedWorldScale[0] = sx;
        interpolatedWorldScale[1] = sy;
        interpolatedWorldScale[2] = sz;

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

        transform._dirty &= ~(TRANSFORM_DIRTY_INTERPOLATED_MATRIX | TRANSFORM_DIRTY_INTERPOLATED_TRS);
    } else {
        // source from parent's visual chain if parent participates in
        // interpolation; otherwise the visual chain is not maintained
        // above this point, so use parent.worldMatrix (which the caller,
        // `updateInterpolatedWorldTransform`, has refreshed at the boundary).
        const pm = parent._interpolated ? parent.interpolatedWorldMatrix! : parent.worldMatrix;
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
        transform._dirty = (transform._dirty & ~TRANSFORM_DIRTY_INTERPOLATED_MATRIX) | TRANSFORM_DIRTY_INTERPOLATED_TRS;
    }
}

/**
 * ensure interpolatedWorld values are up to date, mirror of
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
export function updateInterpolatedWorldTransform(transform: TransformTrait): void {
    if (!(transform._dirty & TRANSFORM_DIRTY_INTERPOLATED_MATRIX)) return;

    const stack = _interpolatedWalkStack;
    let cursor: TransformTrait | null = transform;
    while (cursor?._interpolated && cursor._dirty & TRANSFORM_DIRTY_INTERPOLATED_MATRIX) {
        stack.push(cursor);
        cursor = parentTransform(cursor);
    }
    const boundary = cursor;

    // boundary parent (cursor) is null, a clean interp ancestor, or a
    // non-interp ancestor. only the non-interp case needs setup: ensure
    // its worldMatrix is fresh so the nested-compose branch can read it.
    // updateWorldTransform uses the separate _walkStack, safe to call.
    if (cursor !== null && !cursor._interpolated && cursor._dirty & TRANSFORM_DIRTY_WORLD_MATRIX) {
        updateWorldTransform(cursor);
    }

    const top = stack.length - 1;
    for (let i = top; i >= 0; i--) {
        composeInterpolatedWorldMatrix(stack[i]!, i === top ? boundary : stack[i + 1]!);
    }
    stack.length = 0;
}

/**
 * compose the interpolated world matrix for every descendant of an interp root, top-down.
 *
 * called by `concatenate()` once `interpolate()` has written the root's own visual pose,
 * and once every writer of a descendant local has run, so every
 * parent is composed before its children and no node ever walks up to find a fresh
 * ancestor. `composeInterpolatedWorldMatrix` clears INTERPOLATED_MATRIX and defers
 * INTERPOLATED_TRS, so the getters read straight out of the cache; the visual TRS still
 * decomposes lazily for the readers that ask for it.
 *
 * this is a sweep rather than the dirty-marking the sim chain uses because the two have
 * different odds: a node is under an interp root precisely because it is being rendered,
 * so marking it dirty only to have the renderer read it back the same frame pays for the
 * bookkeeping twice, once to set the bit and once for the read's walk up to the nearest
 * clean ancestor. Sweeping costs one compose per node and nothing else. The sim chain
 * keeps marking, where a moved subtree genuinely may go unread.
 *
 * a local TRS change after this runs re-dirties that node to TRANSFORM_DIRTY_ALL, so a
 * bone posed later in the frame still recomposes lazily on read.
 *
 * does NOT touch the world dirty bits; the sim-side worldMatrix chain is independent.
 */
export function sweepInterpolatedDescendants(parent: TransformTrait): void {
    const children = parent._children;
    for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        // `_interpolated` flips the getters over to the visual chain, and must be set
        // before composing the child's own children, which source from it.
        ensureInterpolatedPose(child);
        child._interpolated = 1;
        child._version++;
        composeInterpolatedWorldMatrix(child, parent);
        sweepInterpolatedDescendants(child);
    }
}

// ── interpolation opt-in API ────────────────────────────────────────────
//
// mirrors godot's `set_physics_interpolated` / `reset_physics_interpolation`.
// participation is explicit: callers opt nodes in via `setInterpolation`,
// which seeds prev = current immediately so the first render frame blends
// from the actual pose, not from (0,0,0). without this, snapshot() doesn't
// run until the next fixed tick, and any render in between would lerp from
// the default vec3.create(), visually a teleport-from-origin.

/** world-space position, read from the matrix translation; leaves the TRS decompose deferred. */
export function getWorldPosition(transform: TransformTrait): Vec3 {
    if (transform._dirty & TRANSFORM_DIRTY_WORLD_MATRIX) updateWorldTransform(transform);
    if (transform._dirty & TRANSFORM_DIRTY_WORLD_TRS) {
        const m = transform.worldMatrix;
        const worldPosition = transform.worldPosition;
        worldPosition[0] = m[12];
        worldPosition[1] = m[13];
        worldPosition[2] = m[14];
    }
    return transform.worldPosition;
}

/**
 * get the integer chunk coord (cx,cy,cz) containing this transform's world
 * position. lazy: recomputes from worldPosition only when the WORLD_CHUNK bit
 * is set (every world-transform invalidation re-flags it), so a stationary
 * transform computes it once and a never-queried transform never computes it
 * at all. the returned Vec3 is the cached instance, do not mutate.
 */
export function getWorldChunk(transform: TransformTrait): Vec3 {
    let worldChunk = transform.worldChunk;
    if (worldChunk === null) {
        worldChunk = vec3.create();
        transform.worldChunk = worldChunk;
    }
    if (transform._dirty & TRANSFORM_DIRTY_WORLD_CHUNK) {
        const p = getWorldPosition(transform);
        worldChunk[0] = toChunkCoord(Math.floor(p[0]));
        worldChunk[1] = toChunkCoord(Math.floor(p[1]));
        worldChunk[2] = toChunkCoord(Math.floor(p[2]));
        transform._dirty &= ~TRANSFORM_DIRTY_WORLD_CHUNK;
    }
    return worldChunk;
}

/** get world-space quaternion, decomposing from worldMatrix if needed. */
export function getWorldQuaternion(transform: TransformTrait): Quat {
    if (transform._dirty & TRANSFORM_DIRTY_WORLD_MATRIX) updateWorldTransform(transform);
    if (transform._dirty & TRANSFORM_DIRTY_WORLD_TRS) {
        mat4.decompose(transform.worldQuaternion, transform.worldPosition, transform.worldScale, transform.worldMatrix);
        transform._dirty &= ~TRANSFORM_DIRTY_WORLD_TRS;
    }
    return transform.worldQuaternion;
}

/** get world-space scale, decomposing from worldMatrix if needed. */
export function getWorldScale(transform: TransformTrait): Vec3 {
    if (transform._dirty & TRANSFORM_DIRTY_WORLD_MATRIX) updateWorldTransform(transform);
    if (transform._dirty & TRANSFORM_DIRTY_WORLD_TRS) {
        mat4.decompose(transform.worldQuaternion, transform.worldPosition, transform.worldScale, transform.worldMatrix);
        transform._dirty &= ~TRANSFORM_DIRTY_WORLD_TRS;
    }
    return transform.worldScale;
}

/** get world matrix, recomputing if dirty. */
export function getWorldMatrix(transform: TransformTrait): Mat4 {
    if (transform._dirty & TRANSFORM_DIRTY_WORLD_MATRIX) updateWorldTransform(transform);
    return transform.worldMatrix;
}

// ── visual-space getters ───────────────────────────────────────────────
//
// renderer reads come through here. mirrors godot's
// `get_global_transform_interpolated()` fallback pattern: when `_interpolated`
// is 0, the node has never been touched by interpolation, so interpolatedWorld*
// is meaningless and we return the world chain instead. when 1, we go
// through the lazy visual chain (`updateInterpolatedWorldTransform`) which composes
// from `parent.interpolatedWorldMatrix * local`.

/** get the world matrix to render with, visual chain if interpolated, world otherwise. */
export function getVisualWorldMatrix(transform: TransformTrait): Mat4 {
    if (!transform._interpolated) return getWorldMatrix(transform);
    if (transform._dirty & TRANSFORM_DIRTY_INTERPOLATED_MATRIX) updateInterpolatedWorldTransform(transform);
    return transform.interpolatedWorldMatrix!;
}

/** visual world-space position, read from the matrix translation. */
export function getVisualWorldPosition(transform: TransformTrait): Vec3 {
    if (!transform._interpolated) return getWorldPosition(transform);
    if (transform._dirty & TRANSFORM_DIRTY_INTERPOLATED_MATRIX) updateInterpolatedWorldTransform(transform);
    if (transform._dirty & TRANSFORM_DIRTY_INTERPOLATED_TRS) {
        const m = transform.interpolatedWorldMatrix!;
        const interpolatedWorldPosition = transform.interpolatedWorldPosition!;
        interpolatedWorldPosition[0] = m[12];
        interpolatedWorldPosition[1] = m[13];
        interpolatedWorldPosition[2] = m[14];
    }
    return transform.interpolatedWorldPosition!;
}

/** get visual world-space quaternion, lazy-decomposing if deferred. */
export function getVisualWorldQuaternion(transform: TransformTrait): Quat {
    if (!transform._interpolated) return getWorldQuaternion(transform);
    if (transform._dirty & TRANSFORM_DIRTY_INTERPOLATED_MATRIX) updateInterpolatedWorldTransform(transform);
    if (transform._dirty & TRANSFORM_DIRTY_INTERPOLATED_TRS) {
        mat4.decompose(
            transform.interpolatedWorldQuaternion!,
            transform.interpolatedWorldPosition!,
            transform.interpolatedWorldScale!,
            transform.interpolatedWorldMatrix!,
        );
        transform._dirty &= ~TRANSFORM_DIRTY_INTERPOLATED_TRS;
    }
    return transform.interpolatedWorldQuaternion!;
}

/** get visual world-space scale, lazy-decomposing if deferred. */
export function getVisualWorldScale(transform: TransformTrait): Vec3 {
    if (!transform._interpolated) return getWorldScale(transform);
    if (transform._dirty & TRANSFORM_DIRTY_INTERPOLATED_MATRIX) updateInterpolatedWorldTransform(transform);
    if (transform._dirty & TRANSFORM_DIRTY_INTERPOLATED_TRS) {
        mat4.decompose(
            transform.interpolatedWorldQuaternion!,
            transform.interpolatedWorldPosition!,
            transform.interpolatedWorldScale!,
            transform.interpolatedWorldMatrix!,
        );
        transform._dirty &= ~TRANSFORM_DIRTY_INTERPOLATED_TRS;
    }
    return transform.interpolatedWorldScale!;
}

// ── batch computeWorldTransforms ────────────────────────────────────────

/**
 * convert a world-space position to local-space for a node.
 * fast path: if no transformed parent, world === local, just copies.
 */
export function worldToLocalPosition(t: TransformTrait, worldPosition: Vec3, out: Vec3): Vec3 {
    const parent = parentTransform(t);
    if (parent === null) {
        if (out !== worldPosition) vec3.copy(out, worldPosition);
        return out;
    }
    mat4.invert(_invParent, getWorldMatrix(parent));
    // transform point by inverse parent matrix
    const x = worldPosition[0];
    const y = worldPosition[1];
    const z = worldPosition[2];
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
 * fast path: if no transformed parent, world === local, just copies.
 */
export function worldToLocalQuaternion(transform: TransformTrait, worldQuaternion: Quat, out: Quat): Quat {
    const parent = parentTransform(transform);
    if (parent === null) {
        if (out !== worldQuaternion) quat.copy(out, worldQuaternion);
        return out;
    }
    // extract parent's world rotation and invert it
    mat4.getRotation(_worldToLocalQuaternion_parentQuat, getWorldMatrix(parent));
    quat.invert(_worldToLocalQuaternion_invParentQuat, _worldToLocalQuaternion_parentQuat);
    // local = inverse(parentRot) * worldRot
    quat.multiply(out, _worldToLocalQuaternion_invParentQuat, worldQuaternion);
    return out;
}
