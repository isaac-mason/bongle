import type { AnimatorState } from '../api/animation';
import { type TraitType } from '../core/scene/traits';
import { trait } from '../core/registry';

export const AnimatorTrait = trait('animator', {
    /** runtime-only blend state, lazily allocated on first tick or first `Animation.clip(...)` call. */
    _state: null as AnimatorState | null,

    /**
     * participates in animation LOD: at low projected pixel coverage, the animator samples less
     * often and holds pose between samples. Set false for rigs whose bone positions drive gameplay
     * (hit detection, attached colliders, raycasts against skeleton).
     */
    lod: true,
});

export type AnimatorTrait = TraitType<typeof AnimatorTrait>;
