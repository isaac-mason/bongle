// builtin:avatar, canonical 6bone player avatar shipped with the engine.
//
// Registers via the same `model()` API as user-declared models: the
// `asset('./…', import.meta.url)` form lets the .glb live alongside this
// module and resolve relative to it wherever the engine is installed; the
// pipeline reads the resolved path. No bespoke manifest, no engine-side build
// step.
//
// Two roles per plan-avatars.md:
//   1. Fallback avatar, players whose `modelId` doesn't resolve to a
//      published custom avatar render as this one.
//   2. Locomotion-clip fallback, `CharacterTrait` resolves each
//      reserved name (`idle`, `walk`, …) against the equipped avatar's
//      handle first, then against `baseAvatar.animations` second.
//
// Codegen runs at the bongle asset-pipeline pass and populates
// `baseAvatar.scene/nodes/meshes/animations` synchronously at module
// eval, `CharacterTrait` can read these without an `ensureModel` race.

import { asset } from '../../api/asset';
import { model } from '../models/models';

/** Stable id for the builtin avatar. Imported by the service to short-
 *  circuit the resolve endpoint (it returns `{ modelId: BUILTIN_BASE_AVATAR_ID }`
 *  without a clientUrl/serverUrl since the engine already has it). */
export const BUILTIN_BASE_AVATAR_ID = 'builtin:avatar' as const;

export const baseAvatar = model(BUILTIN_BASE_AVATAR_ID, {
    name: 'Player',
    // asset lives under lib/avatars/base/ alongside the other bundled avatars.
    src: asset('../../../avatars/base/player.glb', import.meta.url),
});
