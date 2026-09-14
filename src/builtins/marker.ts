import { type Vec4, vec4 } from 'math';
import { prop } from '../api/prop';
import { control, trait } from '../core/registry';
import type { TraitType } from '../core/scene/traits';
import type { MarkerVisualState } from '../render/markers/marker-visuals';

export type MarkerShape = 'none' | 'axes' | 'arrow' | 'cross';

/** an authored position: drawn as an icon at the node, and clickable, under an edit lens only. */
export const MarkerTrait = trait(
    'marker',
    {
        /** sprite id of the icon; 'auto' is the icon of the node's most specific trait, else the pin. */
        icon: 'auto',
        /** text above the icon; 'auto' is the node name, '' hides it. */
        label: 'auto',
        /** a world-size figure so orientation reads. */
        shape: 'none' as MarkerShape,
        /** world size of the pick box and the figure; the icon itself is screen-sized. */
        size: 0.5,
        /** false switches the marker off entirely: no card, no pick box; the editor clears it on placement ghosts. */
        enabled: true,
        tint: [1, 1, 1, 1] as Vec4,
        _state: null as MarkerVisualState | null,
    },
    { icon: 'kit:marker' },
);

export type MarkerTrait = TraitType<typeof MarkerTrait>;

control(MarkerTrait, 'enabled', {
    label: 'Enabled',
    schema: prop.boolean(),
    get: (t) => t.enabled,
    set: (t, v) => {
        t.enabled = v;
    },
});

control(MarkerTrait, 'label', {
    label: 'Label',
    schema: prop.string(),
    get: (t) => t.label,
    set: (t, v) => {
        t.label = v;
    },
});

control(MarkerTrait, 'shape', {
    label: 'Shape',
    schema: prop.enumeration(['none', 'axes', 'arrow', 'cross']),
    get: (t) => t.shape,
    set: (t, v) => {
        t.shape = v as MarkerShape;
    },
});

control(MarkerTrait, 'icon', {
    label: 'Icon',
    schema: prop.sprite(),
    get: (t) => t.icon,
    set: (t, v) => {
        t.icon = v;
    },
});

control(MarkerTrait, 'size', {
    label: 'Size',
    schema: prop.number({ min: 0.05, step: 0.05 }),
    get: (t) => t.size,
    set: (t, v) => {
        t.size = v;
    },
});

control(MarkerTrait, 'tint', {
    label: 'Tint',
    schema: prop.vec4(),
    get: (t) => t.tint,
    set: (t, v) => {
        vec4.copy(t.tint, v as Vec4);
    },
});
