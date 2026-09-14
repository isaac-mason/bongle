import { type TraitType } from '../core/scene/traits';
import { trait } from '../core/registry';
import type { ShadowVisualState } from '../render/shadows/shadow-visuals';

export const ShadowCasterTrait = trait('shadow-caster', {
    /** disc radius in world units. */
    radius: 0.4,

    /** max distance the downward raycast searches for ground; also drives the dither fade to nothing. */
    maxDistance: 4,

    /** renderer-internal allocation state, populated lazily by `ShadowVisuals` on first sight, cleared on dispose. */
    _state: null as ShadowVisualState | null,
});

export type ShadowCasterTrait = TraitType<typeof ShadowCasterTrait>;
