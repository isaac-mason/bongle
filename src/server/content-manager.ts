// server/content-manager.ts, the in-memory scene store: sceneId -> raw scene json.
//
// The single source of truth the runtime boots rooms from, seeded from the project
// fs at `load()` and from declared scene payloads. Held in memory so reads stay
// SYNCHRONOUS (the engine reads it from the tick/dispatch path). The runtime only
// reads and seeds; writing scenes back to disk is the editor's
// (editor/persist/scenes.ts), which updates this store and then writes.
//
// scene ids are the path relative to `content/scenes/`, `.scene.json`
// stripped, separators normalized to `/`:
//   content/scenes/blueprints/foo.scene.json  ->  "blueprints/foo"
//   content/scenes/main.scene.json            ->  "main"

import type { ScenePayload } from '../core/content/scene-store';
import type { SerializedSceneTree } from '../core/scene/scene-tree';
import type { SavedChunk } from '../core/voxels/voxel-savefile';

export type { ScenePayload };

const SCENE_FILE_VERSION = 1;

/** scene files live under `content/scenes/`, one `*.scene.json` each; the sceneId
 *  is that path with the dir prefix + extension stripped, `/`-separators kept
 *  (`content/scenes/blueprints/foo.scene.json` -> `blueprints/foo`). */
export const SCENES_DIR = 'content/scenes';
export const SCENE_EXT = '.scene.json';
export function scenePath(sceneId: string): string {
    return `${SCENES_DIR}/${sceneId}${SCENE_EXT}`;
}
export function sceneIdFromPath(path: string): string | null {
    if (!path.startsWith(`${SCENES_DIR}/`) || !path.endsWith(SCENE_EXT)) return null;
    return path.slice(SCENES_DIR.length + 1, -SCENE_EXT.length);
}

export type SceneEntry = {
    /** logical scene name, e.g. "main". */
    sceneId: string;
};

/** on-disk shape. nodes is required; chunks is omitted when voxels are empty. */
export type SceneFile = {
    version: number;
    nodes: SerializedSceneTree;
    chunks?: Record<string, SavedChunk>;
};

export type ContentManager = {
    /** sceneId -> raw scene JSON, exactly the bytes on disk (or to be written). */
    scenes: Map<string, string>;
};

export function init(): ContentManager {
    return { scenes: new Map() };
}

// ── on-disk <-> in-memory conversion ──────────────────────────────────

function fileToPayload(file: SceneFile): ScenePayload {
    return { nodes: file.nodes, voxels: file.chunks ? { chunks: file.chunks } : null };
}

function payloadToFile(payload: ScenePayload): SceneFile {
    const file: SceneFile = { version: SCENE_FILE_VERSION, nodes: payload.nodes };
    if (payload.voxels && Object.keys(payload.voxels.chunks).length > 0) file.chunks = payload.voxels.chunks;
    return file;
}

/** the exact JSON a payload is stored (and written) as. Seeding with this for a
 *  payload that came from elsewhere keeps a later identical save a no-op. */
export function serializeScenePayload(payload: ScenePayload): string {
    return JSON.stringify(payloadToFile(payload), null, 2);
}

// ── queries ────────────────────────────────────────────────────────────

export function listScenes(state: ContentManager): SceneEntry[] {
    return [...state.scenes.keys()].sort().map((sceneId) => ({ sceneId }));
}

export function loadScene(state: ContentManager, sceneId: string): ScenePayload | null {
    return loadSceneRaw(state, sceneId)?.data ?? null;
}

/** load a scene's parsed payload plus its raw JSON. null when absent/invalid. */
export function loadSceneRaw(state: ContentManager, sceneId: string): { data: ScenePayload; raw: string } | null {
    const raw = state.scenes.get(sceneId);
    if (raw === undefined) return null;

    let parsed: SceneFile;
    try {
        parsed = JSON.parse(raw) as SceneFile;
    } catch {
        return null;
    }
    if (!parsed?.nodes?.root) return null;
    if (parsed.version !== SCENE_FILE_VERSION) {
        throw new Error(
            `[content-manager] scene "${sceneId}" has unknown version ${parsed.version} (expected ${SCENE_FILE_VERSION}), refusing to load`,
        );
    }
    return { data: fileToPayload(parsed), raw };
}

// ── the store ──────────────────────────────────────────────────────────

/** put a scene's raw json in the store: a file read at load, a declared payload, or
 *  what the editor is about to write. */
export function putScene(state: ContentManager, sceneId: string, raw: string): void {
    state.scenes.set(sceneId, raw);
}

/** drop a scene from the store; false when it was not there. */
export function dropScene(state: ContentManager, sceneId: string): boolean {
    return state.scenes.delete(sceneId);
}

/** move a scene to a new id; false if the source is missing or the target exists. */
export function moveScene(state: ContentManager, oldSceneId: string, newSceneId: string): boolean {
    const raw = state.scenes.get(oldSceneId);
    if (raw === undefined || state.scenes.has(newSceneId)) return false;
    state.scenes.delete(oldSceneId);
    state.scenes.set(newSceneId, raw);
    return true;
}
