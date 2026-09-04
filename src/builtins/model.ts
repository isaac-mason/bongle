// ModelTrait, a lighting group: one shared voxel-light value for every mesh
// at or below this node. `ModelLighting` samples once per frame at this node's
// origin plus `lightOffset` and writes it here; meshes resolve their group via
// the renderers' `Up(ModelTrait)` query term, which the scene tree keeps live
// across reparenting and trait add/remove.
//
// Grouping is optional and is the granularity knob for model lighting. With a
// ModelTrait, a rig's limbs share one sample, so a bone whose world position
// clips into a solid voxel mid-animation can't pop dark, and the whole model
// costs one sample. Without one, each mesh is its own lighting unit and samples
// at its own AABB centre — inside its geometry by construction, no anchor to
// configure — which gives a multi-part model a real gradient at the cost of one
// sample per mesh.
//
// Sits wherever the group boundary belongs: the rig root for animated models,
// the model root for static multi-mesh, or the mesh node itself for single-mesh
// things (`Up` counts the node itself, so a node carrying both MeshTrait and
// ModelTrait resolves to its own).
//
// Lifecycle: `cloneModel` installs ModelTrait on the clone root, and the
// Animator (when present) installs one on its node, so meshes under a rig
// share one light value.
//
// Standalone visuals (sprite, extruded-sprite, shadow) do NOT install a
// ModelTrait. They sample light themselves (sprite/extruded) or don't
// need it (shadow). Only the mesh renderers read from ModelTrait.

import type { Vec3, Vec4 } from 'math';
import { type TraitType, trait } from '../core/scene/traits';

export const ModelTrait = trait('model', {
    /**
     * Visibility for every mesh under this model, the inherited half of the pair whose local
     * half is `MeshTrait.visible`. A renderer skips a mesh when either is false, so hiding a
     * character is one write here rather than a walk that stomps each mesh's own flag (and
     * forgets what it was). Mirrors Godot's `Node3D.visible` / `is_visible_in_tree()` split,
     * except the ancestor is already resolved into the render query's tuple, so nothing has
     * to walk.
     */
    visible: true,

    /**
     * Voxel light contribution [sky, r, g, b] sampled by `ModelLighting.update`
     * once per frame at the model's sample point (origin + `lightOffset`).
     * Meshes under this ModelTrait read this directly instead of sampling
     * at their own world position, keeps lighting consistent across a
     * rig's limbs and stops individual bone meshes from popping dark when
     * their world position clips into a solid voxel. Defaults to full-bright
     * so the first frame before sampling doesn't render the model black.
     */
    light: (() => [1, 1, 1, 1] as Vec4) as () => Vec4,

    /**
     * Where to sample voxel light, as a model-local offset from this node's
     * origin (transformed by the node's world matrix before sampling).
     *
     * `cloneModel` seeds it to the centre of the clone's own mesh AABBs, so
     * the sample lands inside the body rather than at the origin, which for a
     * model authored standing on y=0 is the floor block under it. Assign it to
     * override: a character's rig root is at its feet, so `CharacterTrait`
     * sets `[0, ~0.9, 0]` to sample from the torso centre. The zero default
     * survives only on a `ModelTrait` added to a node by hand, which samples
     * at the node origin.
     */
    lightOffset: (() => [0, 0, 0] as Vec3) as () => Vec3,
});

export type ModelTrait = TraitType<typeof ModelTrait>;
