// cull.ts — the per-renderable frustum-cull entry.
//
// A `CullState` lives on each renderer's per-instance render-state object
// (`MeshVisualState.cull`, `SpriteVisualState.cull`, …), so frustum culling
// is part of an impl's rendering state, derived automatically from geometry
// it already knows. There is no cull trait and no model-level cull state:
// the cull primitive is a renderable thing with a box, nothing more.
//
// Ownership split:
//   - the owning visual system fills `aabb` (local-space) from its geometry
//     and bumps `version` when that box changes (mesh swap, sprite resize,
//     extrusion re-bake), and registers/unregisters the entry with the
//     room's Visibility culler.
//   - the Visibility culler owns `leaf` (its DBVT slot) and writes the
//     per-frame results `visible` / `distSq` / `extentSq`.

import { type Box3, box3 } from 'mathcat';

/** per-renderable cull bookkeeping, one per renderable instance, held on its
 *  render-state object. defaults are "unregistered + visible" so a
 *  freshly-spawned thing renders until the culler has a real leaf for it
 *  (and so server / offline ticks, which run no cull, treat it visible).
 *
 *  This is the whole cull abstraction: a renderable thing with a box. A
 *  model isn't a cullable, its meshes are — consumers that want a model-level
 *  answer (animator gate/LOD, per-model lighting) fold their own meshes'
 *  `CullState`s inline. */
export type CullState = {
    /** DBVT leaf index in the room's Visibility; -1 until registered. */
    leaf: number;
    /** local-space AABB. world AABB = `aabb × node world matrix`. written by
     *  the owning visual system from its own geometry/dims. */
    aabb: Box3;
    /** bumped by the owning system on every `aabb` write; Visibility tracks
     *  the last value it saw to know when to refit the leaf. */
    version: number;
    /** frustum + distance cull result, written by Visibility each frame.
     *  consumers read this to skip off-screen work. */
    visible: boolean;
    /** squared camera distance to the leaf's world-AABB center, written by
     *  Visibility every frame the leaf is visible. animation LOD input. */
    distSq: number;
    /** squared world-space diagonal extent of the leaf, written alongside
     *  `distSq`. coverage = `extentSq / distSq` (∝ projected pixel size). */
    extentSq: number;
};

export function createCullState(): CullState {
    return { leaf: -1, aabb: box3.create(), version: 0, visible: true, distSq: 0, extentSq: 0 };
}
