// ModelTrait, an inherited-visibility group: one flag covering every mesh at or
// below this node. Meshes resolve their group via the renderers'
// `Up(ModelTrait)` query term, which the scene tree keeps live across
// reparenting and trait add/remove.
//
// Sits wherever the group boundary belongs: the rig root for animated models,
// the model root for static multi-mesh, or the mesh node itself for single-mesh
// things (`Up` counts the node itself).
//
// Lifecycle: `cloneModel` installs ModelTrait on the clone root, and the
// Animator (when present) installs one on its node.
//
// Lighting is NOT here. Every visual samples the GPU light volume itself at its
// own anchor (`voxel-light-sample.ts`), so there is no light value to group and
// no anchor to configure.

import { trait } from '../core/registry';
import type { TraitType } from '../core/scene/traits';

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
});

export type ModelTrait = TraitType<typeof ModelTrait>;
