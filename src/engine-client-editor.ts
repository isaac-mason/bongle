// engine-client-editor, client-side editor-mode boot composition.
//
// Imported only by the edit-mode client realm entries (the cli + editor edit clients).
// `setup(state)` is called between `EngineClient.init` and `EngineClient.load` so the
// editor's EditorScript + commands land in the registry before
// `EngineClient.load`'s `clearPendingChanges` sweep. Splitting the editor
// out of `engine-client.ts` keeps the runtime entry free of `env.editor`
// UI conditionals, composition lives in the template, not the core.
//
// Pairs with `engine-server-editor` (the server-side counterpart). Both own the
// HMR re-apply loop via `watchRegistry`, so the edit realms never reach into
// `bongle/internal` for the flush themselves.

import * as api from 'bongle';
import { applyRegistryChanges } from './client/registry-dispatch';
import type { EngineClient } from './client/engine-client';
import { registerFlushHandler, requestFlush } from './core/capture/flush';
import { type SceneSource, setSceneSource } from './editor/blueprints';
import * as Editor from './editor/index';
import { mountEditUI } from './editor/ui/edit-ui';

// Blueprint scene-source wiring for embedders that read scenes from a project fs
// (the browser editor). refreshBlueprints re-lists; reloadBlueprint re-reads one.
export { refreshBlueprints, reloadBlueprint, type SceneSource } from './editor/blueprints';
// Reload the pipeline-baked voxel icons (block atlas + prefab thumbnails). The
// edit client calls this when a baked icon file changes on the fs.
export { reloadBakedIcons } from './editor/index';
// The editor UI store. Re-exported here because engine-client-editor is the editor's
// public surface, the edit client reads it for the net-sim toggle.
export { useEditor } from './editor/editor-store';

export async function setup(state: EngineClient, opts?: { sceneSource?: SceneSource }): Promise<void> {
    setSceneSource(opts?.sceneSource ?? null);
    Editor.registerClient(state);
    mountEditUI(state.domElement);
    const g = window as unknown as { _state: EngineClient; _api: typeof api };
    g._state = state;
    g._api = api;
}

/** Re-apply registry changes to `state` on every settled flush (HMR / re-declare),
 *  plus an initial apply. Returns an unregister for teardown. Call AFTER
 *  `EngineClient.load` so the first apply sees the loaded render tier.
 *
 *  Edit/dev only: deployed play applies the registry once in `load()` and never
 *  runs this. Lives here (not on `EngineClient`) so the play surface stays free
 *  of the HMR loop; `registerFlushHandler`/`requestFlush` are the same
 *  `core/capture/flush` primitives `bongle/internal` exposes to realm entries. */
export function watchRegistry(state: EngineClient): () => void {
    const unregister = registerFlushHandler(() => applyRegistryChanges(state));
    requestFlush();
    return unregister;
}
