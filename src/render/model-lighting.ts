// per-room model lighting, samples voxel light once per model at its
// world-space origin and writes it into `ModelTrait.light`. Every mesh under
// the model shares this one value, so a rig's limbs stay consistently lit and
// a bone whose own world position clips into a solid voxel mid-animation
// doesn't pop dark.
//
// Sampling is unconditional (every model, every frame), `sampleVoxelLight`
// is a handful of voxel-grid lookups, far cheaper than walking each model's
// mesh subtree to decide visibility + a centroid. Off-screen models pay the
// sample; the meshes themselves are still frustum-culled downstream.

import { getVisualWorldMatrix } from '../api/transforms';
import { ModelTrait } from '../builtins/model';
import { TransformTrait } from '../builtins/transform';
import type { SceneTree } from '../core/scene/scene-tree';
import { query } from '../core/scene/scene-tree';
import { sampleVoxelLight } from '../core/voxels/light';
import type { Voxels } from '../core/voxels/voxels';

type LightingQuery = ReturnType<typeof query<[typeof ModelTrait, typeof TransformTrait]>>;

export type ModelLighting = {
    _query: LightingQuery;
};

export function init(sceneTree: SceneTree): ModelLighting {
    return { _query: query(sceneTree, [ModelTrait, TransformTrait]) };
}

export function update(ml: ModelLighting, voxels: Voxels): void {
    for (const [model, transform] of ml._query) {
        const m = getVisualWorldMatrix(transform);
        // Sample at the model-local sampleOffset transformed into world space
        // (origin + rotation/scale · offset). For the default zero offset this
        // collapses to the translation column m[12..14].
        const o = model.lightOffset;
        const sx = m[0]! * o[0] + m[4]! * o[1] + m[8]! * o[2] + m[12]!;
        const sy = m[1]! * o[0] + m[5]! * o[1] + m[9]! * o[2] + m[13]!;
        const sz = m[2]! * o[0] + m[6]! * o[1] + m[10]! * o[2] + m[14]!;
        sampleVoxelLight(voxels, sx, sy, sz, model.light);
    }
}
