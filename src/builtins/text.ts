import { type Vec4, vec4 } from 'math';
import { control, trait } from '../core/registry';
import { prop } from '../core/scene/prop';
import type { TraitType } from '../core/scene/traits';
import type { SpriteOcclusion } from '../render/sprites/sprite-resources';
import type { TextVisualState } from '../render/text/text-visuals';
import type { SpriteMode } from './sprite';

export type TextAlign = 'left' | 'center' | 'right';

/** a run of the kit's pixel font drawn in the world, one sprite instance per character. */
export const TextTrait = trait(
    'text',
    {
        /** printable ASCII; anything else draws as `?`, and newlines start a new line. */
        text: '',

        /** quad orientation, same value space as SpriteTrait and CanvasTrait. */
        mode: 'billboard' as SpriteMode,

        /** world units per font pixel. Default 1/16 makes a character one sixteenth of a block wide. */
        worldScale: 1 / 16,

        /** which end of the run sits on the node. */
        align: 'center' as TextAlign,

        /** what hides it: `'world'` is depth-tested like any solid, `'none'` draws over the world (nametags). Client-only. */
        occlusion: 'world' as SpriteOcclusion,

        /** per-instance tint [r, g, b, a]: rgb is the recolour target, a the intensity. Client-only. */
        tint: [1, 1, 1, 1] as Vec4,

        /** transient overlay [r, g, b, a], applied as `mix(surface, rgb, a)` over the tint but under lighting. Client-only. */
        flash: [0, 0, 0, 0] as Vec4,

        /** emissive glow intensity 0-1, added to final color. Client-only. */
        glow: 0,

        /** skip voxel + sun lighting entirely, render the glyphs flat. Client-only. */
        unlit: true,

        /** minimum voxel-light floor 0-1. Ignored when `unlit`. Client-only. */
        litMin: 0,

        /** screen-door fade 0-1, fragments drop via `discard`. Client-only. */
        dither: 0,

        /** whether this run renders; the slots stay allocated when false. Client-only. */
        visible: true,

        /** renderer-internal allocation state, populated lazily by `TextVisuals` on first sight, cleared on dispose. */
        _state: null as TextVisualState | null,
    },
    { icon: 'kit:icon:canvas' },
);

export type TextTrait = TraitType<typeof TextTrait>;

control(TextTrait, 'text', {
    label: 'Text',
    schema: prop.string(),
    get: (t) => t.text,
    set: (t, v) => {
        t.text = v;
    },
});

control(TextTrait, 'align', {
    label: 'Align',
    schema: prop.enumeration(['left', 'center', 'right']),
    get: (t) => t.align,
    set: (t, v) => {
        t.align = v as TextAlign;
    },
});

control(TextTrait, 'mode', {
    label: 'Mode',
    schema: prop.enumeration(['world', 'billboard', 'y-billboard']),
    get: (t) => t.mode,
    set: (t, v) => {
        t.mode = v as SpriteMode;
    },
});

control(TextTrait, 'worldScale', {
    label: 'World scale',
    schema: prop.number({ min: 0 }),
    get: (t) => t.worldScale,
    set: (t, v) => {
        t.worldScale = v;
    },
});

control(TextTrait, 'occlusion', {
    label: 'Occlusion',
    schema: prop.enumeration(['world', 'none']),
    get: (t) => t.occlusion,
    set: (t, v) => {
        t.occlusion = v as SpriteOcclusion;
    },
});

control(TextTrait, 'tint', {
    label: 'Tint',
    schema: prop.vec4(),
    get: (t) => t.tint,
    set: (t, v) => {
        vec4.copy(t.tint, v as Vec4);
    },
});

control(TextTrait, 'glow', {
    label: 'Glow',
    schema: prop.number({ min: 0, max: 1, step: 0.05 }),
    get: (t) => t.glow,
    set: (t, v) => {
        t.glow = v;
    },
});

control(TextTrait, 'unlit', {
    label: 'Unlit',
    schema: prop.boolean(),
    get: (t) => t.unlit,
    set: (t, v) => {
        t.unlit = v;
    },
});

control(TextTrait, 'litMin', {
    label: 'Light floor',
    schema: prop.number({ min: 0, max: 1, step: 0.05 }),
    get: (t) => t.litMin,
    set: (t, v) => {
        t.litMin = v;
    },
});

control(TextTrait, 'dither', {
    label: 'Dither',
    schema: prop.number({ min: 0, max: 1, step: 0.05 }),
    get: (t) => t.dither,
    set: (t, v) => {
        t.dither = v;
    },
});

control(TextTrait, 'visible', {
    label: 'Visible',
    schema: prop.boolean(),
    get: (t) => t.visible,
    set: (t, v) => {
        t.visible = v;
    },
});
