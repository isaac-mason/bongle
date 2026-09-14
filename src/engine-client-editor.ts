// engine-client-editor, client-side editor-mode boot composition.
//
// Imported only by the edit-mode client realm entries (the cli + editor edit clients).
// `setup(state)` is called between `EngineClient.init` and `EngineClient.load` so the
// editor's EditorScript + commands land in the registry before
// `EngineClient.load`'s `clearPendingChanges` sweep. Splitting the editor
// out of `engine-client.ts` keeps the runtime entry free of `env.editor`
// UI conditionals, composition lives in the template, not the core.
//
// Pairs with `engine-server-editor` (the server-side counterpart). The HMR re-apply
// loop is `EngineClient.watchRegistry`, the same one every dev realm uses.

import type { EngineClient } from './client/client';
import { type SceneSource, setSceneSource } from './editor/blueprints';
import './editor/client';
import { mountEditUI } from './editor/ui/edit-ui';

// Blueprint scene-source wiring for embedders that read scenes from a project fs
// (the browser editor). refreshBlueprints re-lists; reloadBlueprint re-reads one.
export { refreshBlueprints, reloadBlueprint, type SceneSource } from './editor/blueprints';
// The editor UI store. Re-exported here because engine-client-editor is the editor's
// public surface, the edit client reads it for the net-sim toggle.
export { useEditor } from './editor/editor-store';
// Reload the pipeline-baked voxel icons. The host calls these when the asset
// pipeline announces that an icon artifact moved: the block atlas and per-prefab
// thumbnails are separate artifacts with separate bakes, so they invalidate
// separately.
export { invalidatePrefabIcons, reloadBlockIconAtlas } from './editor/icons';

/** the mounted editor: what `setup` hands back and the host disposes with the realm. */
export type EditorClient = {
    dispose(): void;
};

/** Mount the editor on an initialized (not yet loaded) engine client with the host's
 *  caps: `sceneSource` lists and reads the project's scene files for the library.
 *  Returns the mounted editor; dispose it before the engine. */
export function setup(state: EngineClient, opts?: { sceneSource?: SceneSource }): EditorClient {
    setSceneSource(opts?.sceneSource ?? null);
    const root = mountEditUI(state);
    return {
        dispose: () => {
            root.unmount();
            setSceneSource(null);
        },
    };
}
