// api/scenes.ts, user-facing scene resource api.
//
// `scene('penguin')` declares a scene resource at module scope. returns a
// stable `SceneHandle` whose `node`/`voxels`/`version` fields are mutated
// in place by the engine when the scene loads or reloads. user code holds
// the handle reference permanently and reads through it; closures over
// `EnemyScene.node` are valid forever, readers compare `version` to detect
// change.
//
// scene options control which side(s) load the resource:
//   scene('penguin')                          // both sides (default)
//   scene('navmesh', { client: false })       // server-only
//   scene('hud_overlay', { server: false })   // client-only
//
// the file is read on the server when `server: true`; the server pushes
// the scene to clients when `client: true`. on the side that doesn't load
// the scene, the handle stays empty (`version: 0`, empty node, null voxels).

import type { SceneHandle, SceneOptions } from '../core/scene/scene-handle';

export { scene } from '../core/registry';
export { cloneVoxels, copyVoxels } from '../core/voxels/voxels';
export type { SceneHandle, SceneOptions };
