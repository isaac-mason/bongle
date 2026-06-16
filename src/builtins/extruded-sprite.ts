// ExtrudedSpriteTrait — pixel-extruded 3D mesh sampled from the sprite
// atlas. The "MC item/generated" look: each opaque pixel in the union
// silhouette across the sprite's frames becomes a unit-pixel cube,
// sampled per-pixel from the current frame's atlas region.
//
// Sibling of `SpriteTrait` rather than a `mode` on it — extrusion is a
// genuinely different rendering primitive (mesh, not quad), not just a
// different quad orientation.
//
// Geometry is lazily baked on first render (per
// `client/sprites/sprite-extrusion.ts`), cached on `SpriteResources`
// keyed by `spriteId`, and shared across instances. Depth is applied
// per-instance via `mesh.scale[2]` at draw time, so changing `depth`
// never invalidates the bake.
//
// Code-only: no `control()`, no `sync()`. Same reasoning as
// `SpriteTrait` — sprite handle is module-eval state, persist + sync
// are out-of-scope for v1.
//
// Render path: `client/sprites/extruded-sprite-visuals.ts`. Flipbook
// playback is `fps`-driven and loops; single-frame sprites ignore
// `fps` (parallel to `SpriteTrait`).

import type { Vec4 } from 'mathcat';
import type { ExtrudedSpriteVisualState } from '../client/sprites/extruded-sprite-visuals';
import { type TraitType, trait } from '../core/scene/traits';
import type { SpriteHandle } from '../core/sprites/sprites';

export const ExtrudedSpriteMeshTrait = trait('extruded-sprite-mesh', {
    /** the sprite handle to extrude + render. defaults to null
     *  (renders nothing until set). */
    sprite: null as SpriteHandle | null,

    /** extrusion depth in source pixels. 1 = one-voxel-thick slab,
     *  matching MC item/generated. higher values give a chunkier look. */
    depth: 1,

    /** world units per source pixel. matches `SpriteTrait`'s default and
     *  the MC 1px = 1/16 block convention. Applied to all three axes
     *  (width, height, depth) so the mesh stays voxel-aligned. */
    worldScale: 1 / 16,

    /** flipbook playback rate. ignored when the sprite has a single
     *  frame. loops forever — no playback enum (same shape as
     *  `SpriteTrait`). */
    fps: 8,

    /** per-instance tint [r, g, b, a]: the shader mixes the albedo toward `rgb`
     *  by `a` (mesh-style), so `a = 0` means no tint regardless of rgb. default
     *  [0,0,0,0] = untinted — leaves the sprite's own texture colour. client-only. */
    tint: [0, 0, 0, 0] as Vec4,

    /**
     * voxel-light contribution [sky, r, g, b], each 0-1. client-only.
     * auto-sampled each frame from the room's voxel light grid at the
     * node's world position. mirrors `MeshTrait.light`.
     */
    light: [0, 0, 0, 0] as Vec4,

    /** emissive glow intensity 0-1. added to final color. client-only. */
    glow: 0,

    /**
     * skip voxel + sun lighting entirely; render the texture flat.
     * default `true` so existing extruded sprites keep their flat look;
     * flip to `false` to opt into mesh-style lighting. client-only.
     */
    unlit: true,

    /**
     * minimum voxel-light floor 0-1. applied as
     * `voxelLight = max(voxelLight, vec3(litMin))`. ignored when `unlit`
     * is true. 0 = no floor (default). client-only.
     */
    litMin: 0,

    /**
     * whether this extruded sprite renders. false = skip; the slot stays
     * allocated so toggling is cheap. client-only.
     */
    visible: true,

    /**
     * version counter — bumped by setters when tint/light/glow change so
     * the renderer can re-upload only on mismatch.
     */
    _version: 0,

    /** renderer-owned per-instance state. fast-path lookup — the
     *  ExtrudedSpriteVisuals per-frame loop reads this directly instead
     *  of a Map probe. mirrors `SpriteTrait._state` + `MeshTrait._state`.
     *  includes the frustum-cull entry (see `ExtrudedSpriteVisualState.cull`). */
    _state: null as ExtrudedSpriteVisualState | null,
});

export type ExtrudedSpriteMeshTrait = TraitType<typeof ExtrudedSpriteMeshTrait>;
