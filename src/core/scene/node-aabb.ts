// node-aabb.ts — shared helpers for computing a node's mesh-or-voxel AABB,
// both in local space (for bind-pose envelopes, e.g. animator gating) and in
// world space (for broadphase shape sizing, grab tool, etc.).
//
// callers handle their own fallback when the subtree contributes no AABB.

import { type Box3, box3 } from 'mathcat';
import { getVisualWorldMatrix } from '../../api/transforms';
import { MeshTrait } from '../../builtins/mesh';
import { TransformTrait } from '../../builtins/transform';
import { VoxelMeshTrait } from '../../builtins/voxel-mesh';
import type { Resources } from '../resources';
import type { Node } from './nodes';
import { getTrait } from './nodes';

const _scratchLocal: Box3 = box3.create();
const _scratchWorld: Box3 = box3.create();

/**
 * write `node`'s own local-space mesh-or-voxel AABB into `out`. returns true
 * if the node carries a recognized aabb-producing trait (MeshTrait with a
 * resolvable handle entry, or VoxelMeshTrait with a populated VoxelModel).
 */
function nodeLocalAabb(node: Node, resources: Resources, out: Box3): boolean {
    const meshTrait = getTrait(node, MeshTrait);
    const meshId = meshTrait?.meshId;
    const handle = meshId ? resources.models.get(meshId.modelId)?.handle : null;
    const meshEntry = handle && meshId ? handle.meshes[meshId.meshName] : undefined;
    if (meshEntry) {
        box3.copy(out, meshEntry.aabb);
        return true;
    }
    const voxelMeshTrait = getTrait(node, VoxelMeshTrait);
    const model = voxelMeshTrait?.model;
    if (model && model.voxelCount > 0) {
        // mesh vertices are baked at boundsMin..boundsMax minus origin (see
        // VoxelMeshVisuals.meshAllChunks), so the local-space AABB is the
        // model's bounds shifted by -origin.
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

/**
 * walk `node` and its descendants, unioning each subtree node's mesh AABB
 * (transformed into world space by the node's interpolated world matrix)
 * into `out`. `out` must start empty (e.g. `box3.create()` then set to
 * +/-Infinity). returns true if at least one aabb was unioned.
 */
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
