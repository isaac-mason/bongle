// BoundsTrait — the cull primitive. A local-space AABB + a `visible` bit
// the Visibility system writes once per frame after frustum culling.
// Lives on any node that wants to participate in cull: model roots,
// standalone sprites/extruded-sprites, hand-built nodes, DIY visuals.
//
// Carries:
//   - `aabbLocal` + `_seedAabb` + `_version` + `_visLeaf` — the local-space
//     AABB used by the Visibility system to cull this thing as a single
//     logical unit. Every write to `aabbLocal` must bump `_version` so
//     Visibility refreshes the corresponding DBVT leaf.
//   - `visible` + `_lastVisibleWritten` — frustum cull result. Consumers
//     read `visible` to skip per-frame work (light samples, pose writes,
//     indirect-draw indexCount, raycasts).
//
// Lifecycle:
//   - `cloneModel` installs a BoundsTrait on the clone root, seeding
//     `aabbLocal` + `_seedAabb` from the model handle's precomputed
//     subtree AABB.
//   - The Animator (when present) overwrites `aabbLocal` with its envelope
//     on init / clip-set change, bumping `_version`. On dispose it restores
//     from `_seedAabb`.
//   - Sprite / extruded-sprite visuals install one on alloc, sized from
//     the primitive's local bounds; shadow visuals install nothing
//     (consume sibling/ancestor only).
//   - Scripts / VFX may overwrite for custom bounds.
//
// The Visibility system queries `[BoundsTrait, TransformTrait]`,
// maintains a DBVT keyed by trait, and flips `visible` once per frame via
// frustum cull. Empty AABB leaves (min > max) are treated as
// always-invisible — see visibility.ts.
//
// Producers must write real bounds before the trait is useful; the
// default empty `Box3` is just so a freshly-constructed trait is at
// least addressable.

import { type Box3, box3 } from 'mathcat';
import { type TraitType, trait } from '../core/scene/traits';

export const BoundsTrait = trait('bounds', {
    /**
     * Local-space AABB of this cullable. Written by the producer that
     * created the trait (cloneModel / animator / factory / script).
     * Every write must bump `_version` so the Visibility system refreshes
     * the corresponding DBVT leaf.
     */
    aabbLocal: () => box3.create(),

    /** Bumped on every `aabbLocal` write. Visibility tracks last seen. */
    _version: 0,

    /**
     * Immutable seed value from the trait's installer. Producers that
     * overwrite `aabbLocal` (typically an Animator) may restore from this
     * seed on dispose so the trait outlives its writer correctly.
     */
    _seedAabb: () => box3.create(),

    /** DBVT leaf index in the room's Visibility. -1 until first added. */
    _visLeaf: -1,

    /**
     * Set by `Visibility.update` each frame for traits inside the camera
     * frustum. Consumers (mesh-visuals, sprite-visuals, shadow-visuals,
     * animator gate, ModelLighting) read this to skip work for off-screen
     * things.
     *
     * Defaults to `true` so contexts without a Visibility pass (server tick,
     * offline renderer, freshly-spawned traits before the first cull) treat
     * the thing as visible by default; Visibility resets to `false` each
     * frame before its frustum walk.
     */
    visible: true,

    /**
     * Last `visible` value written into any GPU-side mirror (e.g. the
     * InstanceInfo.visible u32 in ModelVisuals). Lets consumers detect
     * transitions and only re-upload on flip. 0/1 rather than bool so
     * it maps directly to the u32 it backs.
     */
    _lastVisibleWritten: 0,

    /**
     * Squared camera distance to AABB center, written by the Visibility
     * system every frame this trait is visible. Read by animation LOD to
     * compute coverage (`_extentSq / _distSq`). 0 = never been visible yet
     * (treat as closest fidelity for the first sample frame).
     */
    _distSq: 0,

    /**
     * Squared diagonal extent of `aabbLocal`, written alongside `_distSq`
     * by the Visibility system. Coverage ranking is `_extentSq / _distSq`
     * — monotonic with projected pixel size for a given fov, no sqrt or
     * projection math needed.
     */
    _extentSq: 0,
});

export type BoundsTrait = TraitType<typeof BoundsTrait>;
