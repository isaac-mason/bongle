import type { Vec4 } from 'math';
import { trait } from '../core/registry';
import type { TraitType } from '../core/scene/traits';
import type { SpriteHandle } from '../core/sprites/sprites';
import type { ExtrudedSpriteVisualState } from '../render/sprites/extruded-sprite-visuals';

export const ExtrudedSpriteMeshTrait = trait('extruded-sprite-mesh', {
    /** sprite handle to extrude + render, null renders nothing. */
    sprite: null as SpriteHandle | null,

    /** extrusion depth in source pixels. 1 = one-voxel-thick slab. */
    depth: 1,

    /** world units per source pixel, applied to width, height and depth so the mesh stays voxel-aligned. */
    worldScale: 1 / 16,

    /** flipbook playback rate; ignored for single-frame sprites. Loops forever. */
    fps: 8,

    /** per-instance tint [r, g, b, a]: rgb is the recolour target, a the intensity (0 = untouched, 1 = full, lightness-preserving). Client-only. */
    tint: [1, 1, 1, 1] as Vec4,

    /** transient overlay [r, g, b, a], applied as `mix(surface, rgb, a)` over the tint but under lighting. [0,0,0,0] = none. Client-only. */
    flash: [0, 0, 0, 0] as Vec4,

    /** emissive glow intensity 0-1, added to final color. Client-only. */
    glow: 0,

    /** skip voxel + sun lighting entirely, render the texture flat. Client-only. */
    unlit: true,

    /** minimum voxel-light floor 0-1, `voxelLight = max(voxelLight, vec3(litMin))`. Ignored when `unlit`. Client-only. */
    litMin: 0,

    /** screen-door fade 0-1, fragments drop via `discard` against an interleaved-gradient threshold. Stays in the opaque pipeline. Client-only. */
    dither: 0,

    /** whether this extruded sprite renders; the slot stays allocated when false. Client-only. */
    visible: true,

    /** version counter, bumped by setters when tint/light/glow change so the renderer re-uploads only on mismatch. */
    _version: 0,

    /** renderer-owned per-instance state; the per-frame loop reads this directly instead of a Map probe. */
    _state: null as ExtrudedSpriteVisualState | null,
});

export type ExtrudedSpriteMeshTrait = TraitType<typeof ExtrudedSpriteMeshTrait>;
