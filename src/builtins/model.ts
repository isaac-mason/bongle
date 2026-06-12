// ModelTrait — the shared voxel-light home for everything rendered under
// this node. `ModelLighting` samples voxel light once per frame at the
// centroid of the model's visible meshes and writes it here; every MeshTrait
// in the subtree reads it via `findModelAncestor`.
//
// Sampling per-model (rather than per-mesh) keeps lighting consistent
// across a rig's limbs — bones whose own world position clips into a
// solid voxel mid-animation don't pop dark, because the centroid is by
// construction inside the model body.
//
// Sits on the model-instance root (rig root for animated models, model
// root for static multi-mesh, or the mesh node itself for single-mesh
// things). Meshes walk parents from their own node to find the nearest
// ancestor ModelTrait; the mesh batched renderer requires one.
//
// Lifecycle: `cloneModel` installs ModelTrait on the clone root, and the
// Animator (when present) installs one on its node, so meshes under a rig
// share one light value.
//
// Standalone visuals (sprite, extruded-sprite, shadow) do NOT install a
// ModelTrait. They sample light themselves (sprite/extruded) or don't
// need it (shadow). Only the mesh batched renderer reads from ModelTrait.

import { type TraitType, trait } from '../core/scene/traits';
import type { Vec3, Vec4 } from 'mathcat';

export const ModelTrait = trait('model', {
    /**
     * Voxel light contribution [sky, r, g, b] sampled by `ModelLighting.update`
     * once per frame at the model's sample point (origin + `lightOffset`).
     * Meshes under this ModelTrait read this directly instead of sampling
     * at their own world position — keeps lighting consistent across a
     * rig's limbs and stops individual bone meshes from popping dark when
     * their world position clips into a solid voxel. Defaults to full-bright
     * so the first frame before sampling doesn't render the model black.
     */
    light: (() => [1, 1, 1, 1] as Vec4) as () => Vec4,

    /**
     * Where to sample voxel light, as a model-local offset from this node's
     * origin (transformed by the node's world matrix before sampling).
     * Defaults to the origin itself — correct for static meshes whose origin
     * sits inside the body. Models whose origin is on the surface rather than
     * the interior set this so the sample lands inside the body: a character's
     * rig root is at its feet, so it sets `[0, ~0.9, 0]` to sample from the
     * torso center instead of the floor it's standing on.
     */
    lightOffset: (() => [0, 0, 0] as Vec3) as () => Vec3,
});

export type ModelTrait = TraitType<typeof ModelTrait>;
