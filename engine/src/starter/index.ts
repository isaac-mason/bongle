// `bongle/starter` — a free baseline of blocks, textures, models and
// sounds. Each subsystem is re-exported as its own namespace so usage
// is uniform across kinds:
//
//   import { blocks, blockTextures, models, sounds, sprites, blockSoundPresets, particlePresets } from 'bongle/starter';
//
//   blocks.stone
//   blockTextures.grassTop
//   models.spark
//   sounds.chestOpen
//   sprites.smoke
//   blockSoundPresets.grass
//   particlePresets.smoke('puff', { sprite: sprites.smoke })
//
// Namespace property access lets bundlers (with `sideEffects: false`
// in this package's package.json) tree-shake declarations a game
// doesn't reference.

export * as blocks from './blocks';
export * as blockTextures from './block-textures';
export * as models from './models';
export * as sounds from './sounds';
export * as sprites from './sprites';
export * as blockSoundPresets from './block-sound-presets';
export * as particlePresets from './particle-presets';
