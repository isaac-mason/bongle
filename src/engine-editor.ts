// engine-editor — editor-mode boot composition.
//
// Imported only by the kit's edit-mode `client.ts` template. `setup(state)`
// is called between `EngineClient.init` and `EngineClient.load` so the
// editor's EditorScript + commands land in the registry before
// `EngineClient.load`'s `clearPendingChanges` sweep. Splitting the editor
// out of `engine-client.ts` keeps the runtime entry free of `env.editor`
// UI conditionals — composition lives in the template, not the core.

import * as api from 'bongle';
import type { EngineClient } from './client/engine-client';
import * as Editor from './editor/index';
import { mountEditUI } from './editor/ui/edit-ui';

// The editor UI store. Re-exported here because engine-editor is the editor's
// public surface — the kit's edit client reads it for the net-sim toggle.
export { useEditor } from './editor/editor-store';

export async function setup(state: EngineClient): Promise<void> {
    Editor.registerClient(state);
    mountEditUI(state.domElement);
    const g = window as unknown as { _state: EngineClient; _api: typeof api };
    g._state = state;
    g._api = api;
}
