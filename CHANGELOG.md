# Changelog

Notable changes to `bongle`. Newest first; dates are `YYYY-MM-DD`.

Will change to a semver changelog in future once `bongle` is on npm.

## 2026-08-17

- feat!: **breaking** - rename the module-scope `matchmaking()` launch API to
  `config()`, and reshape its options. The player cap moves under a `server`
  field, which also gains a `false` arm for client-only games (no server runs).

  ```ts
  // before
  matchmaking({ maxPlayers: 8 });

  // after
  config({ server: { maxPlayers: 8 } });

  // new: client-only game, no server runs
  config({ server: false });
  ```

  Omitting the call still defaults to multiplayer with a cap of 32.

- feat!: **breaking** - the math dependency `mathcat` is now published as `math`.
  Update imports; the API is unchanged.

  ```ts
  // before
  import { vec3, quat } from 'mathcat';
  import type { Box3 } from 'mathcat/shapes';

  // after
  import { vec3, quat } from 'math';
  import type { Box3 } from 'math/shapes';
  ```

## 2026-08-11

- feat!: **breaking** - rename the script context's scene tree from `ctx.nodes`
  to `ctx.scene` (`ctx.node` stays the bound node). The gpucat render scenes also
  move off `ctx.client.scene` to `ctx.client.render.scene` (with `overlayScene`
  now alongside it under `render`).

## 2026-08-09

- feat!: **breaking** - rename PrefabApplyContext `root` to `scene` 

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
