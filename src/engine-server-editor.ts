// engine-server-editor, server-side editor-mode boot composition.
//
// Imported only by the edit-mode server realm entries (the cli + editor edit servers).
// Importing it registers the editor's server-side declarations (trait, script,
// commands) into the registry, which the realm does before `EngineServer.load`
// builds the derived indexes.
// Pairs with `engine-client-editor` (the client-side counterpart).
//
// Splitting this out of `engine-server.ts` keeps the runtime server entry free of the
// `env.editor` branch — mirroring what `engine-client-editor` already does for the
// client. Both edit modules own the HMR re-apply loop via `watchRegistry`, so the edit
// realms never reach into `bongle/internal` for the flush themselves.

import { registerFlushHandler, requestFlush } from './core/capture/flush';
import * as Persist from './editor/persist/save';
import './editor/server';
import { applyRegistryChanges } from './server/registry-dispatch';
import * as EngineServer from './server/server';

/** Server-side counterpart of `engine-client-editor.watchRegistry`: re-apply registry
 *  changes on every settled flush (HMR / re-declare) plus an initial apply; returns an
 *  unregister for teardown. Call AFTER `EngineServer.load`. Edit/dev only — deployed
 *  play applies the registry once in `load()` and never runs this. */
export function watchRegistry(state: EngineServer.EngineServer): () => void {
    const unregister = registerFlushHandler(() => applyRegistryChanges(state));
    requestFlush();
    return unregister;
}

/** Tear down an edit server: land every open edit room's unsaved edits in the scene
 *  store first (the runtime's dispose destroys rooms and knows nothing about saving),
 *  then dispose the engine. The host awaits `EngineServer.drainPersist` after this. */
export function dispose(state: EngineServer.EngineServer): void {
    Persist.flushAll();
    EngineServer.dispose(state);
}
