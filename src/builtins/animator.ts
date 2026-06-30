// AnimatorTrait, name-keyed animation playback for a rig of TransformTraits.
//
// the runtime (sampling, blending, action lifecycle) lives in
// core/scene/animator.ts; this file is just the trait def. user-facing
// surface is re-exported as a single `Animation` namespace in
// api/animation.ts (clip, play, stop, crossFadeTo, tick, ...).

import type { AnimatorState } from '../api/animation';
import { type TraitType, trait } from '../core/scene/traits';

export const AnimatorTrait = trait('animator', {
    /**
     * runtime-only blend state.
     * lazily allocated on first tick or first `Animation.clip(...)` call.
     */
    _state: null as AnimatorState | null,

    /**
     * Participate in animation LOD: at low projected pixel coverage, the
     * animator samples less often (every 2/4/8 frames) and holds pose
     * between samples. Bone positions are stale-but-bounded.
     *
     * Set false for rigs whose bone positions drive gameplay (hit
     * detection on a weapon bone, attached colliders, raycasts against
     * skeleton). Defaults true, most rigs are visuals-only.
     */
    lod: true,
});

export type AnimatorTrait = TraitType<typeof AnimatorTrait>;
