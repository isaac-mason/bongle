import { type Vec4, vec4 } from 'math';
import { control, registry, trait } from '../core/registry';
import { prop } from '../core/scene/prop';
import type { TraitType } from '../core/scene/traits';
import type { SpriteHandle } from '../core/sprites/sprites';
import type { SpriteOcclusion } from '../render/sprites/sprite-resources';
import type { SpriteVisualState } from '../render/sprites/sprite-visuals';

export type SpriteMode = 'world' | 'billboard' | 'y-billboard';

export const SpriteTrait = trait(
    'sprite',
    {
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

        /** what hides it: `'world'` is depth-tested like any solid, `'none'` draws over the world (nametags, markers). Client-only. */
        occlusion: 'world' as SpriteOcclusion,

        /** whether this sprite renders; the slot stays allocated when false. Client-only. */
        visible: true,

        /** version counter, bumped by setters when tint/light/glow change so the renderer re-uploads only on mismatch. */
        _version: 0,

        /** renderer-internal allocation state, populated lazily by `SpriteVisuals` on first sight, cleared on dispose. */
        _state: null as SpriteVisualState | null,
    },
    { icon: 'kit:icon:sprite' },
);

export type SpriteTrait = TraitType<typeof SpriteTrait>;

export type { SpriteOcclusion };

control(SpriteTrait, 'sprite', {
    label: 'Sprite',
    schema: prop.sprite(),
    get: (t) => t.sprite?.def.spriteId ?? '',
    set: (t, v) => {
        t.sprite = v === '' ? null : (registry.sprites.handles.get(v) ?? null);
    },
});

control(SpriteTrait, 'mode', {
    label: 'Mode',
    schema: prop.enumeration(['world', 'billboard', 'y-billboard']),
    get: (t) => t.mode,
    set: (t, v) => {
        t.mode = v as SpriteMode;
    },
});

control(SpriteTrait, 'width', {
    label: 'Width',
    schema: prop.number({ min: 1, step: 1 }),
    get: (t) => t.width,
    set: (t, v) => {
        t.width = v;
    },
});

control(SpriteTrait, 'height', {
    label: 'Height',
    schema: prop.number({ min: 1, step: 1 }),
    get: (t) => t.height,
    set: (t, v) => {
        t.height = v;
    },
});

control(SpriteTrait, 'worldScale', {
    label: 'World scale',
    schema: prop.number({ min: 0 }),
    get: (t) => t.worldScale,
    set: (t, v) => {
        t.worldScale = v;
    },
});

control(SpriteTrait, 'center', {
    label: 'Centered',
    schema: prop.boolean(),
    get: (t) => t.center,
    set: (t, v) => {
        t.center = v;
    },
});

control(SpriteTrait, 'fps', {
    label: 'FPS',
    schema: prop.number({ min: 0, step: 1 }),
    get: (t) => t.fps,
    set: (t, v) => {
        t.fps = v;
    },
});

control(SpriteTrait, 'occlusion', {
    label: 'Occlusion',
    schema: prop.enumeration(['world', 'none']),
    get: (t) => t.occlusion,
    set: (t, v) => {
        t.occlusion = v as SpriteOcclusion;
    },
});

control(SpriteTrait, 'tint', {
    label: 'Tint',
    schema: prop.vec4(),
    get: (t) => t.tint,
    set: (t, v) => {
        vec4.copy(t.tint, v as Vec4);
    },
});

control(SpriteTrait, 'glow', {
    label: 'Glow',
    schema: prop.number({ min: 0, max: 1, step: 0.05 }),
    get: (t) => t.glow,
    set: (t, v) => {
        t.glow = v;
    },
});

control(SpriteTrait, 'unlit', {
    label: 'Unlit',
    schema: prop.boolean(),
    get: (t) => t.unlit,
    set: (t, v) => {
        t.unlit = v;
    },
});

control(SpriteTrait, 'litMin', {
    label: 'Light floor',
    schema: prop.number({ min: 0, max: 1, step: 0.05 }),
    get: (t) => t.litMin,
    set: (t, v) => {
        t.litMin = v;
    },
});

control(SpriteTrait, 'dither', {
    label: 'Dither',
    schema: prop.number({ min: 0, max: 1, step: 0.05 }),
    get: (t) => t.dither,
    set: (t, v) => {
        t.dither = v;
    },
});

control(SpriteTrait, 'visible', {
    label: 'Visible',
    schema: prop.boolean(),
    get: (t) => t.visible,
    set: (t, v) => {
        t.visible = v;
    },
});
