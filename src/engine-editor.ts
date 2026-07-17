// engine-editor, editor-mode boot composition.
//
// Imported only by the edit-mode realm entries (the cli + editor edit clients). `setup(state)`
// is called between `EngineClient.init` and `EngineClient.load` so the
// editor's EditorScript + commands land in the registry before
// `EngineClient.load`'s `clearPendingChanges` sweep. Splitting the editor
// out of `engine-client.ts` keeps the runtime entry free of `env.editor`
// UI conditionals, composition lives in the template, not the core.

import * as api from 'bongle';
import type { EngineClient } from './client/engine-client';
import { type SceneSource, setSceneSource } from './editor/blueprints';
import * as Editor from './editor/index';
import { mountEditUI } from './editor/ui/edit-ui';

// Blueprint scene-source wiring for embedders that read scenes from a project fs
// (the browser editor). refreshBlueprints re-lists; reloadBlueprint re-reads one.
export { refreshBlueprints, reloadBlueprint, type SceneSource } from './editor/blueprints';
// The editor UI store. Re-exported here because engine-editor is the editor's
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
