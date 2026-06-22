// avatars-fallback.ts — the dev/edit/offline `ServerDriver.avatars` impl.
//
// `ServerDriver.avatars` is required, like `storage`: a deployed host sources
// real avatars from its backend, and kit dev / editor / offline supply this
// fallback — the same split as HTTP storage vs `createInMemoryStorageDriver`.
// It returns the engine's bundled avatars so NPCs get real variety offline.

import type { ServerDriver } from 'bongle/interface';
import { bundledAvatars } from '../core/player/bundled-avatars';

export function createFallbackAvatarsDriver(): ServerDriver['avatars'] {
    const batch = bundledAvatars.map((handle) => ({ source: 'bundled' as const, modelId: handle.modelId }));
    return { sample: async () => batch };
}
