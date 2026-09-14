import { type ParticleHandle, particle, particleUpdate, type SpriteHandle } from 'bongle';

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
