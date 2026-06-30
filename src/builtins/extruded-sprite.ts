// ExtrudedSpriteTrait, pixel-extruded 3D mesh sampled from the sprite
// atlas. The "MC item/generated" look: each opaque pixel in the union
// silhouette across the sprite's frames becomes a unit-pixel cube,
// sampled per-pixel from the current frame's atlas region.
//
// Sibling of `SpriteTrait` rather than a `mode` on it, extrusion is a
// genuinely different rendering primitive (mesh, not quad), not just a
// different quad orientation.
//
// Geometry is lazily baked on first render (per
// `render/sprites/sprite-extrusion.ts`), cached on `SpriteResources`
// keyed by `spriteId`, and shared across instances. Depth is applied
// per-instance via `mesh.scale[2]` at draw time, so changing `depth`
// never invalidates the bake.
//
// Code-only: no `control()`, no `sync()`. Same reasoning as
// `SpriteTrait`, sprite handle is module-eval state, persist + sync
// are out-of-scope for v1.
//
// Render path: `render/sprites/extruded-sprite-visuals.ts`. Flipbook
// playback is `fps`-driven and loops; single-frame sprites ignore
// `fps` (parallel to `SpriteTrait`).

import type { Vec4 } from 'mathcat';
import { type TraitType, trait } from '../core/scene/traits';
import type { SpriteHandle } from '../core/sprites/sprites';
import type { ExtrudedSpriteVisualState } from '../render/sprites/extruded-sprite-visuals';

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
     *  frame. loops forever, no playback enum (same shape as
     *  `SpriteTrait`). */
    fps: 8,

    /** per-instance tint [r, g, b, a]: rgb is the recolour target, a the
     *  intensity (0 = untouched, 1 = full, lightness-preserving). never
     *  changes coverage. default [1,1,1,1] = untinted. client-only. */
    tint: [1, 1, 1, 1] as Vec4,

    /** transient overlay [r, g, b, a]: rgb is the colour, a the strength,
     *  applied as `mix(surface, rgb, a)` over the tint but under lighting.
     *  [0,0,0,0] = none (default). client-only. */
    flash: [0, 0, 0, 0] as Vec4,

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
     * screen-door fade 0-1. 0 = solid (default), 1 = fully invisible.
     * Fragments drop via `discard` against an interleaved-gradient
     * threshold, stays in the opaque pipeline, no sort/blend. client-only.
     */
    dither: 0,

    /**
     * whether this extruded sprite renders. false = skip; the slot stays
     * allocated so toggling is cheap. client-only.
     */
    visible: true,

    /**
     * version counter, bumped by setters when tint/light/glow change so
     * the renderer can re-upload only on mismatch.
     */
    _version: 0,

    /** renderer-owned per-instance state. fast-path lookup, the
     *  ExtrudedSpriteVisuals per-frame loop reads this directly instead
     *  of a Map probe. mirrors `SpriteTrait._state` + `MeshTrait._state`.
     *  includes the frustum-cull entry (see `ExtrudedSpriteVisualState.cull`). */
    _state: null as ExtrudedSpriteVisualState | null,
});

export type ExtrudedSpriteMeshTrait = TraitType<typeof ExtrudedSpriteMeshTrait>;
