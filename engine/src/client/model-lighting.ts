// per-room model lighting — samples voxel light once per visible model at
// the world-space centroid of its sibling `BoundsTrait.aabbLocal`, and
// writes it into `ModelTrait.light`. Runs after `Visibility.update`, so
// `bounds.visible` gates the work — off-screen models pay nothing.
//
// Sampling per-model (rather than per-mesh) means every mesh under a
// model shares one lighting value. Limbs whose own world position clips
// into a solid voxel mid-animation no longer pop dark — the centroid is
// inside the model's AABB by construction, which on a humanoid rig lands
// somewhere around the torso.
//
// Convention: ModelTrait + BoundsTrait live on the same node. Lighting
// queries both as a triple with TransformTrait.
//
// Consumers: `model-visuals` reads `state.model.light` per-instance when
// the mesh's nearest `ModelTrait` ancestor is present, and falls back to
// a per-mesh world-position sample only for hand-built mesh hierarchies
// without a `ModelTrait` (dev-warned).

import { type Box3, box3, vec3, type Vec3 } from 'mathcat';
import { BoundsTrait } from '../builtins/bounds';
import { ModelTrait } from '../builtins/model';
import { TransformTrait } from '../builtins/transform';
import { getVisualWorldMatrix } from '../api/transforms';
import type { Nodes } from '../core/scene/nodes';
import { query } from '../core/scene/nodes';
import { sampleVoxelLight } from '../core/voxels/light';
import type { Voxels } from '../core/voxels/voxels';

type LightingQuery = ReturnType<typeof query<[typeof ModelTrait, typeof BoundsTrait, typeof TransformTrait]>>;

export type ModelLighting = {
    _query: LightingQuery;
};

export function init(sg: Nodes): ModelLighting {
    return { _query: query(sg, [ModelTrait, BoundsTrait, TransformTrait]) };
}

const _localCenter: Vec3 = [0, 0, 0];
const _worldCenter: Vec3 = [0, 0, 0];

function isEmptyAabb(b: Box3): boolean {
    return b[0] > b[3] || b[1] > b[4] || b[2] > b[5];
}

export function update(ml: ModelLighting, voxels: Voxels): void {
    for (const [model, bounds, transform] of ml._query) {
        // skip culled models. also skip empty-AABB models — `box3.center`
        // of an empty box gives NaN, which would propagate through the
        // sample into `model.light` and render the rig black. Empty AABB
        // means the producer (Animator / cloneModel) hasn't seeded a real
        // envelope yet; the default `model.light = [1,1,1,1]` carries until
        // it does.
        if (!bounds.visible) continue;
        if (isEmptyAabb(bounds.aabbLocal)) continue;
        box3.center(_localCenter, bounds.aabbLocal);
        vec3.transformMat4(_worldCenter, _localCenter, getVisualWorldMatrix(transform));
        sampleVoxelLight(voxels, _worldCenter[0], _worldCenter[1], _worldCenter[2], model.light);
    }
}
