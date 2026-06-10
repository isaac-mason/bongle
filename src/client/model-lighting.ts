// per-room model lighting — samples voxel light once per model at its
// world-space origin and writes it into `ModelTrait.light`. Every mesh under
// the model shares this one value, so a rig's limbs stay consistently lit and
// a bone whose own world position clips into a solid voxel mid-animation
// doesn't pop dark.
//
// Sampling is unconditional (every model, every frame) — `sampleVoxelLight`
// is a handful of voxel-grid lookups, far cheaper than walking each model's
// mesh subtree to decide visibility + a centroid. Off-screen models pay the
// sample; the meshes themselves are still frustum-culled downstream.

import { ModelTrait } from '../builtins/model';
import { TransformTrait } from '../builtins/transform';
import { getVisualWorldMatrix } from '../api/transforms';
import type { Nodes } from '../core/scene/nodes';
import { query } from '../core/scene/nodes';
import { sampleVoxelLight } from '../core/voxels/light';
import type { Voxels } from '../core/voxels/voxels';

type LightingQuery = ReturnType<typeof query<[typeof ModelTrait, typeof TransformTrait]>>;

export type ModelLighting = {
    _query: LightingQuery;
};

export function init(sg: Nodes): ModelLighting {
    return { _query: query(sg, [ModelTrait, TransformTrait]) };
}

export function update(ml: ModelLighting, voxels: Voxels): void {
    for (const [model, transform] of ml._query) {
        const m = getVisualWorldMatrix(transform);
        sampleVoxelLight(voxels, m[12]!, m[13]!, m[14]!, model.light);
    }
}
