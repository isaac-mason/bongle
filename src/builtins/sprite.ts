import type { Vec4 } from 'math';
import { trait } from '../core/registry';
import type { TraitType } from '../core/scene/traits';
import type { SpriteHandle } from '../core/sprites/sprites';
import type { SpriteVisualState } from '../render/sprites/sprite-visuals';

export type SpriteMode = 'world' | 'billboard' | 'y-billboard';

export const SpriteTrait = trait('sprite', {
    /** sprite handle to render, null renders nothing. Stable for the module lifetime, a safe lookup key into `SpriteResources.frames`. */
    sprite: null as SpriteHandle | null,

    /** quad orientation, same value space as CanvasTrait. */
    mode: 'billboard' as SpriteMode,

    /** quad width in source pixels, multiplied by `worldScale` for world units. */
    width: 16,
    /** quad height in source pixels. */
    height: 16,
    /** world units per source pixel. Default 1/16 keeps a 16px sprite at 1 world unit wide (one voxel). */
    worldScale: 1 / 16,

    /** anchor at sprite center vs top-left, matching CanvasTrait. */
    center: true,

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

    /** whether this sprite renders; the slot stays allocated when false. Client-only. */
    visible: true,

    /** version counter, bumped by setters when tint/light/glow change so the renderer re-uploads only on mismatch. */
    _version: 0,

    /** renderer-internal allocation state, populated lazily by `SpriteVisuals` on first sight, cleared on dispose. */
    _state: null as SpriteVisualState | null,
});

export type SpriteTrait = TraitType<typeof SpriteTrait>;
