import type { EngineClient } from './client/client';
import { type SceneSource, setSceneSource } from './editor/blueprints';
import './editor/client';
import { mountEditUI } from './editor/ui/edit-ui';

// Scene-source wiring for embedders that read scenes from a project fs.
export { refreshBlueprints, reloadBlueprint, type SceneSource } from './editor/blueprints';
export { useEditor } from './editor/editor-store';
// Block atlas and per-prefab thumbnails are separate bakes; invalidate separately.
export { invalidatePrefabIcons, reloadBlockIconAtlas } from './editor/icons';

/** The mounted editor: what `setup` hands back and the host disposes with the realm. */
export type EditorClient = {
    dispose(): void;
};

/** Mounts the editor on an initialized (not yet loaded) engine client. Dispose it before the engine. */
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
