// blueprints, client-only sync of `useEditor.sceneList` + `useEditor.blueprints`.
// `initBlueprints()` is called from the editor's client activation path; never
// imported on the server.
//
// Scenes are read through an injected `SceneSource` — the browser editor backs it
// with the project OPFS (see `engine-editor.setup` + the client boot), and re-
// lists / reloads over the client's fs-change relay when a `content/scenes/**`
// file changes. The engine stays blueprint-agnostic; this module is the editor's
// subscriber that pulls each `blueprints/...` payload named in the scene list.

import type { ScenePayload } from '../core/content/scene-store';
import { useEditor } from './editor-store';

const BLUEPRINT_PREFIX = 'blueprints/';

/** reads scenes for the blueprint sync (the browser editor backs it with OPFS). */
export type SceneSource = {
    /** all scene ids, dir-relative to content/scenes (e.g. 'blueprints/tree'). */
    listScenes(): Promise<string[]>;
    /** a scene's raw JSON, or null if missing. */
    readScene(id: string): Promise<string | null>;
};

let sceneSource: SceneSource | null = null;

/** wire the scene source; must be set before `initBlueprints` for sync to run. */
export function setSceneSource(source: SceneSource | null): void {
    sceneSource = source;
}

/** re-read the scene list (blueprints added/removed on disk). */
export function refreshBlueprints(): void {
    void fetchSceneList();
}

/** re-read one blueprint's payload (its file changed on disk). */
export function reloadBlueprint(id: string): void {
    if (id.startsWith(BLUEPRINT_PREFIX)) void fetchBlueprint(id);
}

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
    if (!sceneSource) return;
    try {
        const scene = await sceneSource.readScene(id);
        if (scene != null) applySceneFile(id, scene);
    } catch (e) {
        console.warn(`[blueprints] failed to read ${id}:`, e);
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
    if (!sceneSource) return;
    try {
        const scenes = await sceneSource.listScenes();
        useEditor.getState().setSceneList(scenes);
        syncBlueprintsFromSceneList(scenes);
    } catch (e) {
        console.warn('[blueprints] failed to list scenes:', e);
    }
}

let initialized = false;

/** wires up the scene-list cold-read + the sceneList subscription. client-only,
 *  called from the editor's client activation path in editor/index.ts.
 *  idempotent across HMR reloads of the editor module. */
export function initBlueprints(): void {
    if (initialized) return;
    initialized = true;

    void fetchSceneList();

    useEditor.subscribe((s, prev) => {
        if (s.sceneList !== prev.sceneList) syncBlueprintsFromSceneList(s.sceneList);
    });
}
