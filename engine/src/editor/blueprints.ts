// blueprints — client-only sync of `useEditor.sceneList` + `useEditor.blueprints`
// off the kit's scene HMR channels. `initBlueprints()` is called from the
// editor's client activation path; never imported on the server.
//
// Two channels in one module because blueprint sync is driven by the scene
// list — every `blueprints/...` id in the list needs its payload pulled.
//
//   • `bongle:scene-list` carries the current scene id set; cold-cache
//     boot via `GET /__bongle/scenes` covers initial fetch (HMR doesn't
//     replay past events on new connections).
//
//   • `bongle:scene-update` / `bongle:scene-clear` carry per-scene payload
//     changes. The engine itself stays blueprint-agnostic; this module is
//     the editor's own subscriber.
//
// Initial blueprint payloads go through the plugin's `/__bongle/scene/:id`
// cold-cache endpoint, since the file watcher only fires for live edits —
// files that existed before the dev server booted never produce an HMR
// event, so we fetch them off the cold-fetched scene list.

import type { ScenePayload } from '../core/content/scene-store';
import { useEditor } from './editor-store';

const BLUEPRINT_PREFIX = 'blueprints/';

function applySceneFile(id: string, sceneJson: string): void {
    const file = JSON.parse(sceneJson) as {
        nodes: ScenePayload['nodes'];
        chunks?: NonNullable<ScenePayload['voxels']>['chunks'];
    };
    useEditor.getState().setBlueprint(id, {
        nodes: file.nodes,
        voxels: file.chunks ? { chunks: file.chunks } : null,
    });
}

async function fetchBlueprint(id: string): Promise<void> {
    try {
        const res = await fetch(`/__bongle/scene/${encodeURIComponent(id)}`);
        if (!res.ok) return;
        const { scene } = (await res.json()) as { id: string; scene: string };
        applySceneFile(id, scene);
    } catch (e) {
        console.warn(`[blueprints] failed to fetch ${id}:`, e);
    }
}

function syncBlueprintsFromSceneList(sceneIds: string[]): void {
    const blueprints = useEditor.getState().blueprints;
    const wanted = new Set<string>();
    for (const id of sceneIds) {
        if (!id.startsWith(BLUEPRINT_PREFIX)) continue;
        wanted.add(id);
        if (!blueprints.has(id)) void fetchBlueprint(id);
    }
    for (const id of blueprints.keys()) {
        if (!wanted.has(id)) useEditor.getState().removeBlueprint(id);
    }
}

async function fetchSceneList(): Promise<void> {
    try {
        const res = await fetch('/__bongle/scenes');
        if (!res.ok) return;
        const { scenes } = (await res.json()) as { scenes: string[] };
        useEditor.getState().setSceneList(scenes);
        syncBlueprintsFromSceneList(scenes);
    } catch (e) {
        console.warn('[blueprints] failed to fetch scene list:', e);
    }
}

let initialized = false;

/** wires up scene-list cold-fetch + HMR subscriptions. client-only — called
 *  from the editor's client activation path in editor/index.ts. idempotent
 *  across HMR reloads of the editor module. */
export function initBlueprints(): void {
    if (initialized) return;
    initialized = true;

    void fetchSceneList();

    useEditor.subscribe((s, prev) => {
        if (s.sceneList !== prev.sceneList) syncBlueprintsFromSceneList(s.sceneList);
    });

    if (import.meta.hot) {
        import.meta.hot.on('bongle:scene-list', (msg: { scenes: string[] }) => {
            useEditor.getState().setSceneList(msg.scenes);
        });
        import.meta.hot.on('bongle:scene-update', (msg: { id: string; scene: string }) => {
            if (!msg.id.startsWith(BLUEPRINT_PREFIX)) return;
            applySceneFile(msg.id, msg.scene);
        });
        import.meta.hot.on('bongle:scene-clear', (msg: { id: string }) => {
            if (!msg.id.startsWith(BLUEPRINT_PREFIX)) return;
            useEditor.getState().removeBlueprint(msg.id);
        });
    }
}
