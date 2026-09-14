import { type Mat4, mat4 } from 'math';
import { type Box3, box3 } from 'math/shapes';
import { getVisualWorldMatrix } from '../../api/transforms';
import { MeshTrait } from '../../builtins/mesh';
import { TransformTrait } from '../../builtins/transform';
import { VoxelMeshTrait } from '../../builtins/voxel-mesh';
import { registry } from '../registry';
import type { Resources } from '../resources';
import type { Node } from './scene-tree';
import { getTrait } from './scene-tree';

const _scratchLocal: Box3 = box3.create();
const _scratchWorld: Box3 = box3.create();

/** Writes `node`'s own local-space mesh-or-voxel AABB into `out`. Returns true if the node carries a recognized aabb-producing trait. */
function nodeLocalAabb(node: Node, resources: Resources, out: Box3): boolean {
    const meshTrait = getTrait(node, MeshTrait);
    const meshId = meshTrait?.meshId;
    const handle = meshId ? resources.models.get(meshId.modelId)?.def : null;
    const meshEntry = handle && meshId ? handle.meshes[meshId.meshName] : undefined;
    if (meshEntry) {
        box3.copy(out, meshEntry.aabb);
        return true;
    }
    return voxelMeshLocalAabb(node, out);
}

/** Writes `node`'s own local-space VoxelMeshTrait AABB into `out`. Returns false when the node has no trait or its model is empty. */
function voxelMeshLocalAabb(node: Node, out: Box3): boolean {
    const model = getTrait(node, VoxelMeshTrait)?.model;
    if (!model || model.voxelCount === 0) return false;
    // Mesh vertices are baked at boundsMin..boundsMax minus origin, so the local-space AABB is the model's bounds shifted by -origin.
    const ox = model.origin[0];
    const oy = model.origin[1];
    const oz = model.origin[2];
    const min = model.boundsMin;
    const max = model.boundsMax;
    box3.set(out, min[0] - ox, min[1] - oy, min[2] - oz, max[0] - ox, max[1] - oy, max[2] - oz);
    return true;
}

/** Walks `node` and its descendants, unioning each subtree node's mesh AABB (transformed into world space) into `out`. `out` must start empty. Returns true if at least one AABB was unioned. */
export function unionSubtreeWorldAabb(node: Node, resources: Resources, out: Box3): boolean {
    let found = false;
    const transform = getTrait(node, TransformTrait);
    if (transform && nodeLocalAabb(node, resources, _scratchLocal)) {
        box3.transformMat4(_scratchWorld, _scratchLocal, getVisualWorldMatrix(transform));
        box3.union(out, out, _scratchWorld);
        found = true;
    }
    for (const child of node.children) {
        if (unionSubtreeWorldAabb(child, resources, out)) found = true;
    }
    return found;
}

/**
 * Writes `node`'s own local-space AABB into `out`, resolving MeshTrait boxes from the
 * codegen'd model registry instead of `Resources`, so it works on a detached tree with no
 * runtime and no loaded payload. Models registered at runtime (uploaded avatars) aren't in
 * the registry and resolve nothing here.
 */
function nodeLocalAabbFromRegistry(node: Node, out: Box3): boolean {
    const meshId = getTrait(node, MeshTrait)?.meshId;
    const meshEntry = meshId ? registry.models.byId.get(meshId.modelId)?.meshes[meshId.meshName] : undefined;
    if (meshEntry) {
        box3.copy(out, meshEntry.aabb);
        return true;
    }
    return voxelMeshLocalAabb(node, out);
}

/** Per-depth accumulated matrices for `unionSubtreeLocalAabb`, grown on demand so a recursive walk allocates nothing after the first deep tree. */
const _accumPool: Mat4[] = [];
const _childTrs: Mat4 = mat4.create();
const _scratchChild: Box3 = box3.create();

function accumMatrix(depth: number): Mat4 {
    let m = _accumPool[depth];
    if (m === undefined) {
        m = mat4.create();
        _accumPool[depth] = m;
    }
    return m;
}

/**
 * Unions `root`'s subtree mesh AABBs into `out`, expressed in `root`-local space: each
 * descendant's box is transformed by its TRS chain up to (but excluding) `root`, so the
 * result is independent of where `root` sits in the world. `out` must start empty. Pairs
 * with `unionSubtreeWorldAabb` (same walk, world space); this one is for detached trees,
 * e.g. sizing a freshly cloned model before it's attached.
 */
export function unionSubtreeLocalAabb(root: Node, out: Box3): boolean {
    mat4.identity(accumMatrix(0));
    return unionLocalAabb(root, 0, out);
}

function unionLocalAabb(node: Node, depth: number, out: Box3): boolean {
    const accum = accumMatrix(depth);
    let found = false;
    if (nodeLocalAabbFromRegistry(node, _scratchLocal)) {
        box3.transformMat4(_scratchChild, _scratchLocal, accum);
        box3.union(out, out, _scratchChild);
        found = true;
    }
    for (const child of node.children) {
        const transform = getTrait(child, TransformTrait);
        const childAccum = accumMatrix(depth + 1);
        if (transform) {
            mat4.fromRotationTranslationScale(_childTrs, transform.quaternion, transform.position, transform.scale);
            mat4.multiply(childAccum, accum, _childTrs);
        } else {
            mat4.copy(childAccum, accum);
        }
        if (unionLocalAabb(child, depth + 1, out)) found = true;
    }
    return found;
}
