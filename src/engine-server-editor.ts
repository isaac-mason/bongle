// engine-server-editor, server-side editor-mode boot composition.
//
// Imported only by the edit-mode server realm entries (the cli + editor edit servers).
// `setup(state)` is called between `EngineServer.init` and `EngineServer.load` so the
// editor's server commands upsert into the registry before `load` builds the derived
// indexes. Pairs with `engine-client-editor` (the client-side counterpart).
//
// Splitting this out of `engine-server.ts` keeps the runtime server entry free of the
// `env.editor` branch — mirroring what `engine-client-editor` already does for the
// client. Both edit modules own the HMR re-apply loop via `watchRegistry`, so the edit
// realms never reach into `bongle/internal` for the flush themselves.

import * as api from 'bongle';
import { registerFlushHandler, requestFlush } from './core/capture/flush';
import * as Editor from './editor/index';
import type { EngineServer } from './server/engine-server';
import { applyRegistryChanges } from './server/registry-dispatch';

export async function setup(state: EngineServer): Promise<void> {
    // register the editor's server commands before load builds the derived indexes.
    await Editor.registerServer(state);
    // expose state + api on globalThis for ad-hoc inspection via `bun --inspect` /
    // chrome devtools. `_state` is the full EngineServer; `_api` the same surface user
    // scripts import from 'bongle'.
    const g = globalThis as unknown as { _state: EngineServer; _api: typeof api };
    g._state = state;
    g._api = api;
}

/** Server-side counterpart of `engine-client-editor.watchRegistry`: re-apply registry
 *  changes on every settled flush (HMR / re-declare) plus an initial apply; returns an
 *  unregister for teardown. Call AFTER `EngineServer.load`. Edit/dev only — deployed
 *  play applies the registry once in `load()` and never runs this. */
export function watchRegistry(state: EngineServer): () => void {
    const unregister = registerFlushHandler(() => applyRegistryChanges(state));
    requestFlush();
    return unregister;
}
