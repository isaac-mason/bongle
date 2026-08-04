# Changelog

Notable changes to `bongle`. Newest first; dates are `YYYY-MM-DD`.

Will change to a semver changelog in future once `bongle` is on npm.

## 2026-08-04

- `blockPreset.*` factories now take a single options object that mirrors
  `block()`'s shape, with the geometry `textures` as a field, instead of a
  separate positional `textures` argument. Cube-shaped presets also accept a
  bare texture as shorthand for "all faces".

  To update, fold the old second argument into the options object under a
  `textures` key:

  ```ts
  // before
  blockPreset.cube('kit:stone', { all: { texture: tex.stone } }, { name: 'Stone', sounds });
  blockPreset.slab('kit:stone_slab', { all: { texture: tex.stone } });

  // after (bare texture = all faces)
  blockPreset.cube('kit:stone', { name: 'Stone', textures: tex.stone, sounds });
  blockPreset.slab('kit:stone_slab', { textures: tex.stone });

  // per-face maps, columns and doors pass their map as the `textures` value
  blockPreset.column('kit:oak_log', { name: 'Oak Log', textures: { end, side }, sounds });
  ```

  Each preset has a named options type (`CubePresetOptions`, `LeavesPresetOptions`,
  ...) if you want to annotate call sites.

- added `blocks.woolLightBlue` (`kit:wool_light_blue`), completing all 16 Minecraft
  wool colors.
