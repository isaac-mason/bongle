// SpriteTrait, textured quad sampled from the engine-global sprite atlas.
//
// Mirrors `CanvasTrait`'s shape (mode/width/height/worldScale/center),
// only the pixel source differs: `CanvasTrait` paints into a per-instance
// OffscreenCanvas, `SpriteTrait` samples a uvRect of the shared
// `SpriteResources.atlas`. The three quad orientations (`'billboard'`,
// `'y-billboard'`, `'world'`) collapse into one trait per the same
// precedent.
//
// Code-only: no `control()`, no `sync()`. Persist + replication are
// out-of-scope for v1; if they're ever needed, the spriteId is the
// stable wire surface (the handle itself is module-eval state).
//
// Render path lives in `render/sprites/sprite-visuals.ts`. Flipbook
// playback is `fps`-driven; the trait carries no playback enum (no
// lifetime → no `'stretch'`, no natural `'once'` trigger), so the only
// sensible behaviour is loop. Single-frame sprites ignore `fps`.

import type { Vec4 } from 'mathcat';
import { type TraitType, trait } from '../core/scene/traits';
import type { SpriteHandle } from '../core/sprites/sprites';
import type { SpriteVisualState } from '../render/sprites/sprite-visuals';

export type SpriteMode = 'world' | 'billboard' | 'y-billboard';

export const SpriteTrait = trait('sprite', {
    /** the sprite handle to render. defaults to null (renders nothing
     *  until set). reference is stable for the module lifetime, so
     *  `trait.sprite.spriteId` is a safe lookup key into
     *  `SpriteResources.frames`. */
    sprite: null as SpriteHandle | null,

    /** quad orientation. same value space as CanvasTrait. */
    mode: 'billboard' as SpriteMode,

    /** quad width in source pixels. multiplied by `worldScale` for world units. */
    width: 16,
    /** quad height in source pixels. */
    height: 16,
    /** world units per source pixel. default 1/16 keeps a 16px sprite at
     *  1 world unit wide (one voxel). */
    worldScale: 1 / 16,

    /** anchor at sprite center vs top-left, matching CanvasTrait. */
    center: true,

    /** flipbook playback rate. ignored when the sprite has a single frame.
     *  loops forever; no playback enum (see file header). */
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
     * auto-sampled each frame by `SpriteVisuals` from the room's voxel
     * light grid at the node's world position, same composition as
     * `MeshTrait.light`. ignored when `unlit` is true.
     */
    light: [0, 0, 0, 0] as Vec4,

    /** emissive glow intensity 0-1. added to final color. client-only. */
    glow: 0,

    /**
     * skip voxel + sun lighting entirely; render the texture flat.
     * default `true` so existing sprites keep their flat look; flip to
     * `false` to opt into the mesh-style lighting pipeline. client-only.
     */
    unlit: true,

    /**
     * minimum voxel-light floor 0-1. applied as
     * `voxelLight = max(voxelLight, vec3(litMin))` so a sprite stays
     * readable in dim areas without going fully unlit. ignored when
     * `unlit` is true. 0 = no floor (default). client-only.
     */
    litMin: 0,

    /**
     * screen-door fade 0-1. 0 = solid (default), 1 = fully invisible.
     * Fragments drop via `discard` against an interleaved-gradient
     * threshold, stays in the opaque pipeline, no sort/blend. Pixelly,
     * not smooth alpha. client-only.
     */
    dither: 0,

    /**
     * whether this sprite renders. false = skip; the slot stays
     * allocated so toggling is cheap. client-only.
     */
    visible: true,

    /**
     * version counter, bumped by setters when tint/light/glow change so
     * the renderer can re-upload only on mismatch. mirrors
     * `MeshTrait._version`.
     */
    _version: 0,

    /** renderer-internal allocation state; populated lazily by `SpriteVisuals`
     *  on first sight, cleared on dispose. fast-path lookup avoids a per-frame
     *  Map probe. mirrors `MeshTrait._state`'s pattern. includes the
     *  frustum-cull entry (see `SpriteVisualState.cull`). */
    _state: null as SpriteVisualState | null,
});

export type SpriteTrait = TraitType<typeof SpriteTrait>;
