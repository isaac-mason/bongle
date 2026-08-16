// server/content-manager.ts — authored content (scenes), in-memory.
//
// scenes are one JSON doc each: a node tree + optional voxel chunk payload.
// The store is a `Map<sceneId, rawJSON>` — the single source of truth, held
// in memory so the MEMORY op stays SYNCHRONOUS (the engine calls these from the
// tick/dispatch path). Disk persistence is decoupled: the host injects an async
// `persist` hook, and each save/delete is ENQUEUED onto a serial queue drained
// off the tick — ops run one-at-a-time in enqueue order (a scene's writes/deletes
// never reorder), failures surface via `persist.onError`, and `drainPersist`
// awaits the queue on shutdown so a torn-down realm's edits reach disk. The async
// fs never leaks into the sync engine, but its completion + errors are owned, not
// fire-and-forgotten.
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

/** scene files live under `content/scenes/`, one `*.scene.json` each; the sceneId
 *  is that path with the dir prefix + extension stripped, `/`-separators kept
 *  (`content/scenes/blueprints/foo.scene.json` → `blueprints/foo`). */
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

/** host-injected async persistence for scene changes. The engine enqueues these
 *  off its sync path onto a serial queue; the queue awaits each (ordered, one at a
 *  time) and reports a rejection via `onError`. Impls just do the fs write/remove
 *  — in the browser editor, into the project Filesystem. */
export type ContentPersistence = {
    write(sceneId: string, content: string): Promise<void>;
    delete(sceneId: string): Promise<void>;
    /** a queued write/delete rejected — surface it (the edit didn't reach disk). */
    onError?(op: 'write' | 'delete', sceneId: string, err: unknown): void;
};

export type ContentManager = {
    /** sceneId → raw scene JSON. the in-memory source of truth (+ dedup). */
    scenes: Map<string, string>;
    persist?: ContentPersistence;
    /** the async persist queue's tail: every enqueued write/delete chains onto
     *  this so they run serially in order; `drainPersist` awaits it. */
    persistChain: Promise<void>;
};

/** one enqueued disk op. */
type PersistOp = { kind: 'write'; sceneId: string; content: string } | { kind: 'delete'; sceneId: string };

/** queue a persist op behind the current tail — runs after prior ops (so a scene's
 *  writes/deletes never reorder) and a rejection goes to `persist.onError` without
 *  breaking the chain. No-op without a persist hook (memory-only mode). */
function enqueuePersist(state: ContentManager, op: PersistOp): void {
    const { persist } = state;
    if (!persist) return;
    state.persistChain = state.persistChain.then(async () => {
        try {
            if (op.kind === 'write') await persist.write(op.sceneId, op.content);
            else await persist.delete(op.sceneId);
        } catch (err) {
            persist.onError?.(op.kind, op.sceneId, err);
        }
    });
}

/** await every persist op enqueued so far. Graceful shutdown flushes the final
 *  saves (which enqueue synchronously) then drains, so a torn-down realm's edits
 *  reach disk before a fresh one reloads from it. */
export function drainPersist(state: ContentManager): Promise<void> {
    return state.persistChain;
}

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

/** `persist` writes scene changes back (edit hosts; absent → memory-only). The
 *  scene store is seeded lazily by the engine at `load()` via `seedLastWrittenRaw`,
 *  reading each `content/scenes/*.scene.json` from the project fs. */
export function init(opts: { persist?: ContentPersistence } = {}): ContentManager {
    return { scenes: new Map(), persist: opts.persist, persistChain: Promise.resolve() };
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
    enqueuePersist(state, { kind: 'write', sceneId, content });
    return true;
}

// ── delete / rename ─────────────────────────────────────────────────

export function deleteScene(state: ContentManager, sceneId: string): void {
    if (state.scenes.delete(sceneId)) enqueuePersist(state, { kind: 'delete', sceneId });
}

/** rename a scene. returns false if the source is missing or the target exists. */
export function renameScene(state: ContentManager, oldSceneId: string, newSceneId: string): boolean {
    const raw = state.scenes.get(oldSceneId);
    if (raw === undefined || state.scenes.has(newSceneId)) return false;
    state.scenes.delete(oldSceneId);
    state.scenes.set(newSceneId, raw);
    enqueuePersist(state, { kind: 'delete', sceneId: oldSceneId });
    enqueuePersist(state, { kind: 'write', sceneId: newSceneId, content: raw });
    return true;
}
