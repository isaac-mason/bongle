/**
 * public animation api — single namespace fronting the animator runtime.
 *
 *   import { Animation, AnimationAction, AnimatorTrait } from 'bongle';
 *   const a = Animation.clip(animator, wizard.animations.idle);
 *   Animation.play(a);
 *   Animation.crossFadeTo(a, walk, 0.3);
 */

export type { AnimationAction, AnimatorState } from '../core/scene/animation';
export * as Animation from '../core/scene/animation';
