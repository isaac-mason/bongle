// engine-server-editor, server-side editor-mode boot composition.
//
// Imported only by the edit-mode server realm entries (the cli + editor edit servers).
// Importing it registers the editor's server-side declarations (trait, script,
// commands) into the registry, which the realm does before `EngineServer.load`
// builds the derived indexes. `drainWrites` is what a host awaits after
// `EngineServer.dispose`: the editor is the only thing that writes scene files.
// Pairs with `engine-client-editor` (the client-side counterpart).
//
// Splitting this out of `engine-server.ts` keeps the runtime server entry free of the
// `env.editor` branch, mirroring what `engine-client-editor` already does for the
// client. Both edit modules own the HMR re-apply loop via `watchRegistry`, so the edit
// realms never reach into `bongle/internal` for the flush themselves.

import { registerFlushHandler, requestFlush } from './core/capture/flush';
import './editor/server';
import { applyRegistryChanges } from './server/registry-dispatch';
import type { EngineServer } from './server/server';

export { drainWrites } from './editor/persist/scenes';

/** Server-side counterpart of `engine-client-editor.watchRegistry`: re-apply registry
 *  changes on every settled flush (HMR / re-declare) plus an initial apply; returns an
 *  unregister for teardown. Call AFTER `EngineServer.load`. Edit/dev only: deployed
 *  play applies the registry once in `load()` and never runs this. */
export function watchRegistry(state: EngineServer): () => void {
    const unregister = registerFlushHandler(() => applyRegistryChanges(state));
    requestFlush();
    return unregister;
}
