import { type Mat4, mat4 } from 'math';
import { type Box3, box3 } from 'math/shapes';
import { getVisualWorldMatrix } from '../api/transforms';
import { MeshTrait } from '../builtins/mesh';
import { TransformTrait } from '../builtins/transform';
import { VoxelMeshTrait } from '../builtins/voxel-mesh';
import type { Resources } from '../core/resources';
import type { Node } from '../core/scene/scene-tree';
import { getTrait } from '../core/scene/scene-tree';

const _scratchLocal: Box3 = box3.create();
const _scratchWorld: Box3 = box3.create();

/** returns true if the node carries a recognized aabb-producing trait (MeshTrait with a
 *  resolvable handle entry, or VoxelMeshTrait with a populated VoxelModel). */
function nodeLocalAabb(node: Node, resources: Resources, out: Box3): boolean {
    const meshTrait = getTrait(node, MeshTrait);
    const meshId = meshTrait?.meshId;
    const handle = meshId ? resources.models.get(meshId.modelId)?.def : null;
    const meshEntry = handle && meshId ? handle.meshes[meshId.meshName] : undefined;
    if (meshEntry) {
        box3.copy(out, meshEntry.aabb);
        return true;
    }
    const voxelMeshTrait = getTrait(node, VoxelMeshTrait);
    const model = voxelMeshTrait?.model;
    if (model && model.voxelCount > 0) {
        // mesh vertices are baked at boundsMin..boundsMax minus origin (VoxelMeshVisuals.meshAllChunks).
        const ox = model.origin[0];
        const oy = model.origin[1];
        const oz = model.origin[2];
        const min = model.boundsMin;
        const max = model.boundsMax;
        box3.set(out, min[0] - ox, min[1] - oy, min[2] - oz, max[0] - ox, max[1] - oy, max[2] - oz);
        return true;
    }
    return false;
}

const _invRoot: Mat4 = mat4.create();
const _toRoot: Mat4 = mat4.create();

/** the subtree's bounds in `node`'s own frame, so a box drawn through its world matrix rotates and scales with it. */
export function unionSubtreeLocalAabb(node: Node, resources: Resources, out: Box3): boolean {
    const transform = getTrait(node, TransformTrait);
    if (!transform) return false;
    if (!mat4.invert(_invRoot, getVisualWorldMatrix(transform))) return false;
    return unionIntoFrame(node, resources, _invRoot, out);
}

function unionIntoFrame(node: Node, resources: Resources, invRoot: Mat4, out: Box3): boolean {
    let found = false;
    const transform = getTrait(node, TransformTrait);
    if (transform && nodeLocalAabb(node, resources, _scratchLocal)) {
        mat4.multiply(_toRoot, invRoot, getVisualWorldMatrix(transform));
        box3.transformMat4(_scratchWorld, _scratchLocal, _toRoot);
        box3.union(out, out, _scratchWorld);
        found = true;
    }
    for (const child of node.children) {
        if (unionIntoFrame(child, resources, invRoot, out)) found = true;
    }
    return found;
}

/** `out` must start empty (`box3.create()` then set to +/-Infinity). returns true if at least one aabb was unioned. */
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
