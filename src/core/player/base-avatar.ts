import { asset } from '../../api/asset';
import { model } from '../registry';

/** Stable id for the builtin avatar. Imported by the service to short-
 *  circuit the resolve endpoint (it returns `{ modelId: BUILTIN_BASE_AVATAR_ID }`
 *  without a clientUrl/serverUrl since the engine already has it). */
export const BUILTIN_BASE_AVATAR_ID = 'builtin:avatar' as const;

export const baseAvatar = model(BUILTIN_BASE_AVATAR_ID, {
    name: 'Player',
    // asset lives under lib/avatars/base/ alongside the other bundled avatars.
    src: asset('../../../avatars/base/player.glb', import.meta.url),
});
