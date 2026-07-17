// editor/realms/server/avatars.ts — the editor's `ServerDriver.avatars`, the browser
// counterpart to src/server/avatars-fallback.ts (which is node-gated). Same
// engine's example avatars under lib/avatars/, discovered + served by vite
// (`import.meta.glob` + `?url`) instead of read off disk. Same runtime-avatar
// path as prod: served as plain `.glb`, fetched + gltfUnpack'd by the engine.

import type { ResolvedAvatar, ServerDriver } from 'bongle/interface';
import { RIG_TYPE_6BONE } from '../../../src/core/avatar/rig';

// vite emits each avatar glb as an asset and gives us its served URL.
const AVATAR_URLS = import.meta.glob('../avatars/*/*.glb', {
    eager: true,
    query: '?url',
    import: 'default',
}) as Record<string, string>;

// avatar dir → public modelId (matches the node fallback's ids). Excludes
// `base` (the builtin fallback avatar, not a sample to dress NPCs in).
const MODEL_IDS: Record<string, string> = {
    boy: 'avatar:boy',
    girl: 'avatar:girl',
    blindfoldedpenguin: 'avatar:penguin',
    pigeon: 'avatar:pigeon',
};

export function createEditorAvatarsDriver(): ServerDriver['avatars'] {
    const batch: ResolvedAvatar[] = [];
    for (const [path, url] of Object.entries(AVATAR_URLS)) {
        const dir = /avatars\/([^/]+)\//.exec(path)?.[1];
        const modelId = dir ? MODEL_IDS[dir] : undefined;
        if (!modelId) continue;
        // client + server fetch the same same-origin vite URL.
        batch.push({ source: 'runtime', modelId, clientUrl: url, serverUrl: url, rigType: RIG_TYPE_6BONE });
    }
    return { sample: async () => batch };
}

/** pick one sample avatar at random (per joining client). Returns undefined
 *  when none are available (engine falls back to the builtin). */
export function pickRandomAvatar(driver: ServerDriver['avatars']): Promise<ResolvedAvatar | undefined> {
    return driver.sample().then((batch) => (batch.length ? batch[Math.floor(Math.random() * batch.length)] : undefined));
}
