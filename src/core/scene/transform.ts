// position/quaternion/scale are local-space; world values are computed lazily via dirty-flag propagation

import type { Mat4, Quat, Vec3 } from 'math';
import { mat4, quat, vec3 } from 'math';
import type { TransformTrait } from '../../builtins/transform';
import { traitSlots } from '../registry';
import { toChunkCoord } from '../voxels/voxels';
import type { Node, SceneTree } from './scene-tree';
import { markNodeDirty } from './scene-tree';

/** Read through the registry rather than the trait handle in `builtins/transform.ts`, to avoid importing that module. */
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

/** Allocates the visual pose; every path that sets `_interpolated = 1` calls this first. */
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

/** re-point one transform, keeping both child lists in step; invalidation is the caller's job. */
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

/** Re-point the transforms at the top of `node`'s subtree at `inherited`, stopping at each bearer. */
function retargetTransforms(node: Node, inherited: TransformTrait | null): void {
    const own = node.traits[transformSlot()] as TransformTrait | undefined;
    if (own !== undefined) {
        setTransformParent(own, inherited);
        return;
    }
    const children = node.children;
    for (let i = 0; i < children.length; i++) retargetTransforms(children[i]!, inherited);
}

/** Marks a transform changed for world-recompute, interpolation snapshot, and descendant invalidation; callers separately dirty the specific sync slice they wrote. */
export function markTransformChanged(transform: TransformTrait): void {
    if (transform.interpolate) transform._movedSinceSnapshot = 1;
    if (transform._dirty === TRANSFORM_DIRTY_ALL) return;
    transform._dirty = TRANSFORM_DIRTY_ALL;
    transform._version++;
    markDescendants(transform);
}

/** Marks world transform caches dirty without the snapshot enqueue or replication-dirty flags; used by the buffered remote-driven pose unpack. */
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

/** Marks a subtree dirty because its ancestry changed; `topmost` tracks whether we're still above the first bearer, whose isTransformRoot status may have flipped. */
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

/** `node`'s ancestry changed (attach, detach, reparent); skips the descent when `movedFrom` composed to the same transform. */
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

const _invParent = mat4.create();

// non-reentrant scratch stack for updateWorldTransform's iterative ancestor walk
const _walkStack: TransformTrait[] = [];

// separate stack since updateInterpolatedWorldTransform can call updateWorldTransform mid-walk
const _interpolatedWalkStack: TransformTrait[] = [];

/** Composes one node's worldMatrix from its local TRS and the assumed-fresh parent.worldMatrix; hand-inlined, exploiting the affine invariant to skip the bottom row. */
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

    const worldMatrix = transform.worldMatrix;

    if (parent === null) {
        // root: world = local, seed worldP/Q/S directly
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

        transform._dirty &= ~(TRANSFORM_DIRTY_WORLD_MATRIX | TRANSFORM_DIRTY_WORLD_TRS);
    } else {
        // affine multiply: world = parent.world * local, skipping the bottom-row cells
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

/** Ensures world-space values are up to date: walks up to the first clean ancestor, then composes back down the chain. */
export function updateWorldTransform(transform: TransformTrait): void {
    if (!(transform._dirty & TRANSFORM_DIRTY_WORLD_MATRIX)) return;

    // iterative walk avoids function-call overhead for deep skeletons; stack[0] is `transform`, stack[length-1] the topmost dirty ancestor
    const stack = _walkStack;
    let cursor: TransformTrait | null = transform;
    while (cursor !== null && cursor._dirty & TRANSFORM_DIRTY_WORLD_MATRIX) {
        stack.push(cursor);
        cursor = parentTransform(cursor);
    }

    const top = stack.length - 1;
    for (let i = top; i >= 0; i--) {
        composeWorldMatrix(stack[i]!, i === top ? cursor : stack[i + 1]!);
    }
    stack.length = 0;
}

// parallel chain to the world recompute above, composing from parent.interpolatedWorldMatrix so an upstream write flows through descendants automatically

/** Composes one node's interpolatedWorldMatrix from its local TRS and the assumed-fresh parent.interpolatedWorldMatrix. */
export function composeInterpolatedWorldMatrix(transform: TransformTrait, parent: TransformTrait | null): void {
    const q = transform.quaternion;
    const p = transform.position;
    const s = transform.scale;

    // translation-only local: the parent's 3x3 passes through untouched, only the translation column composes (~65% of live transforms qualify)
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
        // sources from the parent's visual chain if it participates in interpolation, otherwise parent.worldMatrix
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

        transform._dirty = (transform._dirty & ~TRANSFORM_DIRTY_INTERPOLATED_MATRIX) | TRANSFORM_DIRTY_INTERPOLATED_TRS;
    }
}

/** Ensures interpolatedWorld values are up to date, mirror of updateWorldTransform over the visual dirty bit and chain; caller guarantees `_interpolated === 1`. */
export function updateInterpolatedWorldTransform(transform: TransformTrait): void {
    if (!(transform._dirty & TRANSFORM_DIRTY_INTERPOLATED_MATRIX)) return;

    const stack = _interpolatedWalkStack;
    let cursor: TransformTrait | null = transform;
    while (cursor?._interpolated && cursor._dirty & TRANSFORM_DIRTY_INTERPOLATED_MATRIX) {
        stack.push(cursor);
        cursor = parentTransform(cursor);
    }
    const boundary = cursor;

    // a non-interpolated boundary parent needs its worldMatrix refreshed first
    if (cursor !== null && !cursor._interpolated && cursor._dirty & TRANSFORM_DIRTY_WORLD_MATRIX) {
        updateWorldTransform(cursor);
    }

    const top = stack.length - 1;
    for (let i = top; i >= 0; i--) {
        composeInterpolatedWorldMatrix(stack[i]!, i === top ? boundary : stack[i + 1]!);
    }
    stack.length = 0;
}

/** Composes the interpolated world matrix for every descendant of an interp root, top-down; called by `concatenate()` after the root's own visual pose is written. */
export function sweepInterpolatedDescendants(parent: TransformTrait): void {
    const children = parent._children;
    for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        // must set _interpolated before composing the child's own children, which source from it
        ensureInterpolatedPose(child);
        child._interpolated = 1;
        child._version++;
        composeInterpolatedWorldMatrix(child, parent);
        sweepInterpolatedDescendants(child);
    }
}

// interpolation participation is explicit: callers opt nodes in via setInterpolation, which seeds prev = current so the first render frame doesn't teleport from origin

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

/** Integer chunk coord (cx,cy,cz) containing this transform's world position; returned Vec3 is the cached instance, do not mutate. */
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

// renderer reads come through the getters below: when `_interpolated` is 0 the node was never touched by interpolation, so we fall back to the world chain

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

/** Converts a world-space position to local-space for a node. */
export function worldToLocalPosition(t: TransformTrait, worldPosition: Vec3, out: Vec3): Vec3 {
    const parent = parentTransform(t);
    if (parent === null) {
        if (out !== worldPosition) vec3.copy(out, worldPosition);
        return out;
    }
    mat4.invert(_invParent, getWorldMatrix(parent));
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

/** Converts a world-space quaternion to local-space for a node. */
export function worldToLocalQuaternion(transform: TransformTrait, worldQuaternion: Quat, out: Quat): Quat {
    const parent = parentTransform(transform);
    if (parent === null) {
        if (out !== worldQuaternion) quat.copy(out, worldQuaternion);
        return out;
    }
    mat4.getRotation(_worldToLocalQuaternion_parentQuat, getWorldMatrix(parent));
    quat.invert(_worldToLocalQuaternion_invParentQuat, _worldToLocalQuaternion_parentQuat);
    quat.multiply(out, _worldToLocalQuaternion_invParentQuat, worldQuaternion);
    return out;
}
