// public engine surface, what user scripts import as `bongle`.
//
// re-exports the two project-facing layers:
//   - `./api/*`, helper modules (transforms, scene-graph, rpc, ...)
//   - `./builtins/*`, engine-shipped traits (TransformTrait, CameraTrait, ...)
//
// engine internals must NOT import from this file. they reach into
// `./api/<helper>` or `./builtins/<trait>` directly. this rule keeps the
// graph acyclic: builtins depend on api helpers, this file depends on both,
// but neither depends on this file.

export * as aabbBody from './api/aabb-body';
export * from './api/animation';
export * from './api/audio';
export * from './api/avatars';
export * from './api/blocks';
export * as chat from './api/chat';
export { client } from './api/client';
export { clientToUser } from './api/clients';
export * from './api/debug';
export { env } from './api/env';
export * from './api/environment';
export * from './api/input';
export * from './api/lighting';
export * from './api/matchmaking';
export * from './api/mobile';
export * from './api/touch-controls';
export * from './api/models';
export * from './api/nav';
export * from './api/pack';
export * from './api/particles';
export * from './api/physics';
export { platform } from './api/platform';
export * from './api/pov';
export * from './api/prefabs';
export * from './api/prop';
export * as rooms from './api/rooms';
export * from './api/rpc';
export * from './api/scene-graph';
export * from './api/scenes';
export * from './api/scripts';
export * from './api/sounds';
export * from './api/sprites';
export { gameStorage, userStorage } from './api/storage';
export * from './api/traits';
export * from './api/transforms';
export * from './api/use';
export * from './builtins/aabb-body';

export * from './builtins/animator';
export * from './builtins/audio-listener';
export * from './builtins/camera';
export * from './builtins/canvas';
export * from './builtins/character';
export * from './builtins/character-controller';
export * from './builtins/contacts';
export * from './builtins/extruded-sprite';
export * from './builtins/fly-controller';
export * from './builtins/html';
export * from './builtins/mesh';
export * from './builtins/orbit-controller';
export * from './builtins/player';
export * from './builtins/player-controller';
export * from './builtins/rigid-body';
export * from './builtins/shadow-caster';
export * from './builtins/sprite';
export * from './builtins/transform';
export * from './builtins/voxel-mesh';
export * from './builtins/world';
export { UILayer } from './client/ui-layers';
export type { Avatar } from './core/avatar/avatar';
