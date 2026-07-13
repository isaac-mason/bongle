// server/content-manager.ts — authored content (scenes), in-memory.
//
// scenes are one JSON doc each: a node tree + optional voxel chunk payload.
// The store is a `Map<sceneId, rawJSON>` — the single source of truth, held
// in memory so every op stays SYNCHRONOUS (the engine calls these from the
// tick/dispatch path). The host (editor) seeds it from the project filesystem
// at boot and injects an async `persist` hook that writes changes back
// fire-and-forget, so the async fs never leaks into the sync engine.
//
// scene ids are the path relative to `content/scenes/`, `.scene.json`
// stripped, separators normalized to `/`:
//   content/scenes/blueprints/foo.scene.json  →  "blueprints/foo"
//   content/scenes/main.scene.json            →  "main"
//
// self-write dedup: `saveScene` compares the new JSON against the stored raw
// and skips when identical (so editor → save → re-apply cycles don't churn).

import type { ScenePayload } from '../core/content/scene-store';
import type { SerializedSceneTree } from '../core/scene/scene-tree';
import type { SavedChunk } from '../core/voxels/voxel-savefile';

export type { ScenePayload };

const SCENE_FILE_VERSION = 1;

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

/** host-injected persistence for scene changes. Fire-and-forget: the engine
 *  never awaits, so impls run the async fs write in the background. In the
 *  browser editor these write into the project Filesystem. */
export type ContentPersistence = {
    write(sceneId: string, content: string): void;
    delete(sceneId: string): void;
};

export type ContentManager = {
    /** sceneId → raw scene JSON. the in-memory source of truth (+ dedup). */
    scenes: Map<string, string>;
    persist?: ContentPersistence;
};

// ── on-disk ↔ in-memory conversion ──────────────────────────────────

function fileToPayload(file: SceneFile): ScenePayload {
    return { nodes: file.nodes, voxels: file.chunks ? { chunks: file.chunks } : null };
}

function payloadToFile(payload: ScenePayload): SceneFile {
    const file: SceneFile = { version: SCENE_FILE_VERSION, nodes: payload.nodes };
    if (payload.voxels && Object.keys(payload.voxels.chunks).length > 0) file.chunks = payload.voxels.chunks;
    return file;
}

/** the exact JSON string `saveScene` would write for a payload. Callers that
 *  hold a payload but need to seed the dedup (applyScenePayload,
 *  registry-dispatch) use this so it matches a subsequent load. */
export function serializeScenePayload(payload: ScenePayload): string {
    return JSON.stringify(payloadToFile(payload), null, 2);
}

// ── init ────────────────────────────────────────────────────────────

/** `scenes` seeds the store (sceneId → raw JSON), read from the project fs by
 *  the host. `persist` writes changes back (optional; absent → memory-only). */
export function init(opts: { scenes?: Record<string, string>; persist?: ContentPersistence } = {}): ContentManager {
    return { scenes: new Map(Object.entries(opts.scenes ?? {})), persist: opts.persist };
}

// ── queries ─────────────────────────────────────────────────────────

export function listScenes(state: ContentManager): SceneEntry[] {
    return [...state.scenes.keys()].sort().map((sceneId) => ({ sceneId }));
}

// ── load ────────────────────────────────────────────────────────────

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
            `[content-manager] scene "${sceneId}" has unknown version ${parsed.version} (expected ${SCENE_FILE_VERSION}) — refusing to load`,
        );
    }
    return { data: fileToPayload(parsed), raw };
}

// ── save / seed ─────────────────────────────────────────────────────

/** seed the stored raw for a scene (typically the bytes just applied to a
 *  handle) so the first flush after an apply skips a redundant identical save.
 *  Does NOT persist — the bytes already reflect the persisted state. */
export function seedLastWrittenRaw(state: ContentManager, sceneId: string, raw: string): void {
    state.scenes.set(sceneId, raw);
}

/**
 * save a scene. the edit room is the single authoritative writer for its
 * scene, so this just stores the room's state; it does not reconcile against
 * any external copy. Returns false (skipping the persist) when the JSON is
 * byte-identical to what's stored.
 */
export function saveScene(state: ContentManager, sceneId: string, payload: ScenePayload): boolean {
    const content = JSON.stringify(payloadToFile(payload), null, 2);
    if (content === state.scenes.get(sceneId)) return false;
    state.scenes.set(sceneId, content);
    state.persist?.write(sceneId, content);
    return true;
}

// ── delete / rename ─────────────────────────────────────────────────

export function deleteScene(state: ContentManager, sceneId: string): void {
    if (state.scenes.delete(sceneId)) state.persist?.delete(sceneId);
}

/** rename a scene. returns false if the source is missing or the target exists. */
export function renameScene(state: ContentManager, oldSceneId: string, newSceneId: string): boolean {
    const raw = state.scenes.get(oldSceneId);
    if (raw === undefined || state.scenes.has(newSceneId)) return false;
    state.scenes.delete(oldSceneId);
    state.scenes.set(newSceneId, raw);
    state.persist?.delete(oldSceneId);
    state.persist?.write(newSceneId, raw);
    return true;
}
