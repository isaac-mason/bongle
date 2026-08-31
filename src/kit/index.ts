// `bongle/kit`, a free baseline of blocks, textures, models and
// sounds. Each subsystem is re-exported as its own namespace so usage
// is uniform across kinds:
//
//   import { blocks, blockTextures, models, sounds, sprites, blockSoundPresets, particlePresets } from 'bongle/kit';
//
//   blocks.stone
//   blockTextures.grassTop
//   models.spark
//   sounds.chestOpen
//   sprites.smoke
//   blockSoundPresets.grass
//   particlePresets.smoke('puff', { sprite: sprites.smoke })
//
// Each area is re-exported by its PUBLIC subpath, not a relative path,
// so the lib build can keep the areas external and leave this barrel a
// live re-export. A bundled `export * as` materializes the namespace as
// an object literal naming every declaration, which pins all of kit.
//
// A game that imports the area directly gets per-declaration
// tree-shaking today:
//
//   import * as blocks from 'bongle/kit/blocks';
//
// Reaching it through this barrel still works, but until a bundler can
// resolve member reads through a re-exported namespace it keeps kit
// whole.

export * as blockSoundPresets from 'bongle/kit/block-sound-presets';
export * as blockTextures from 'bongle/kit/block-textures';
export * as blocks from 'bongle/kit/blocks';
export * as models from 'bongle/kit/models';
export * as particlePresets from 'bongle/kit/particle-presets';
export * as sounds from 'bongle/kit/sounds';
export * as sprites from 'bongle/kit/sprites';
