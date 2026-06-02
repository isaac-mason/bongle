/**
 * Thin `particle()` wrappers bundling a curated `particleUpdate.*` motion
 * fn with a sensible `playback` default. Discoverability anchor on top of
 * the engine vocabulary — drop one in for one-line authoring of common
 * visual fx:
 *
 *   import { particlePresets } from 'bongle/starter';
 *
 *   const Puff   = particlePresets.smoke('puff',   { sprite: SmokeSprite });
 *   const Ember  = particlePresets.spark('ember',  { sprite: EmberSprite });
 *   const Flake  = particlePresets.snow('flake',   { sprite: SnowSprite });
 *   const Drop   = particlePresets.rain('drop',    { sprite: RainSprite });
 *   const Motes  = particlePresets.dust('motes',   { sprite: MoteSprite });
 *
 * Each preset returns the `ParticleHandle` from the underlying `particle()`
 * call — pass it straight to `spawnParticle(ctx, handle, pos)`.
 *
 * Drop to `particle()` directly when you want a non-default `playback`/
 * `fps` or want to compose a custom `update` fn from `particleUpdate.*`
 * primitives — presets carry no data-rich knobs because none exist
 * (motion lives inside the update fn, which is the swap point).
 *
 * Lives in starter (not engine core) for the same reason `block-sound-
 * presets.ts` does: the engine exposes the primitives (`particle()`,
 * `particleUpdate.*`), starter curates ergonomic bundles. Tree-shaking
 * drops any preset a game doesn't reference.
 */

import {
    type ParticleHandle,
    particle,
    particleUpdate,
    type SpriteHandle,
} from 'bongle';

// `fps` only matters for 'loop' / 'once' on multi-frame flipbook sprites;
// single-frame sprites degenerate to "show frame 0" regardless. Defaults
// are tuned for the common case of small (4-8 frame) pixel-art flipbooks.
type PresetOpts = { sprite: SpriteHandle; fps?: number };

export const smoke = (id: string, { sprite }: PresetOpts): ParticleHandle =>
    particle(id, { sprite, playback: 'stretch', update: particleUpdate.smoke });

export const spark = (id: string, { sprite, fps = 24 }: PresetOpts): ParticleHandle =>
    particle(id, { sprite, playback: 'loop', fps, update: particleUpdate.spark });

export const snow = (id: string, { sprite, fps = 8 }: PresetOpts): ParticleHandle =>
    particle(id, { sprite, playback: 'loop', fps, update: particleUpdate.snow });

export const rain = (id: string, { sprite, fps = 12 }: PresetOpts): ParticleHandle =>
    particle(id, { sprite, playback: 'loop', fps, update: particleUpdate.rain });

export const dust = (id: string, { sprite }: PresetOpts): ParticleHandle =>
    particle(id, { sprite, playback: 'stretch', update: particleUpdate.dust });
