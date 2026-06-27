// ShadowCasterTrait — flat dithered circular ground shadow under the node.
//
// Code-only: no control()/sync(). Pure client visual. Each frame the
// renderer raycasts straight down from the node's world position to the
// nearest top-facing voxel surface, then draws a dithered disc at the
// hit point. No transparency — dither density falls off with vertical
// distance so the shadow softens as the caster lifts off the ground.
//
// Quad orientation is hardcoded to world-XZ in shader; no per-instance
// basis needed (axis-aligned voxel tops are the only surfaces the
// raycast cares about). Multi-block clipping (ledges, stairs) is the
// lazy single-ray version — same fidelity as Minecraft's entity shadow.
//
// Render path lives in `render/shadows/shadow-visuals.ts`.

import { type TraitType, trait } from '../core/scene/traits';
import type { ShadowVisualState } from '../render/shadows/shadow-visuals';

export const ShadowCasterTrait = trait('shadow-caster', {
    /** disc radius in world units. */
    radius: 0.4,

    /** max distance the downward raycast searches for ground. also drives
     *  the dither fade: at distance 0 the shadow is solid, at maxDistance
     *  it dithers out to nothing. */
    maxDistance: 4,

    /** renderer-internal allocation state; populated lazily by
     *  `ShadowVisuals` on first sight, cleared on dispose. mirrors
     *  `SpriteTrait._state`. */
    _state: null as ShadowVisualState | null,
});

export type ShadowCasterTrait = TraitType<typeof ShadowCasterTrait>;
