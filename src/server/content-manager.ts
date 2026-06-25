// server/content-manager.ts — disk i/o for authored content.
//
// scenes today are one file per scene: a single combined node tree + optional
// voxel chunk payload. future: any other authored data type (settings,
// tables, dialog) lives here too.
//
// callers pass a `contentDir` at init time (absolute path baked by the
// kit wrapper); every path is resolved against state.contentDir, so
// process cwd no longer matters. scene files live at
// `<contentDir>/scenes/<sceneId>.scene.json`.
//
// responsibilities:
// - scan/list scenes from disk
// - load/save scene payloads (nodes + optional chunks, single file)
// - self-write detection via `_lastWritten` — `saveScene` skips identical
//   re-writes so editor → save → file-watcher → HMR re-apply cycles don't
//   churn. external file watching (dev HMR fan-out) lives in the kit's
//   bongle:scenes Vite plugin, not here.

import fs from 'node:fs';
import path from 'node:path';
import type { ScenePayload } from '../core/content/scene-store';
import type { SerializedSceneGraph } from '../core/scene/nodes';
import type { SavedChunk } from '../core/voxels/voxel-savefile';

export type { ScenePayload };

// ── constants ───────────────────────────────────────────────────────

const SCENES_SUBDIR = 'scenes';
const SCENE_EXT = '.scene.json';
const SCENE_FILE_VERSION = 1;

// ── types ───────────────────────────────────────────────────────────

export type SceneEntry = {
    /** logical scene name, e.g. "main". */
    sceneId: string;
};

/** on-disk shape. nodes is required; chunks is omitted when voxels are empty. */
export type SceneFile = {
    version: number;
    nodes: SerializedSceneGraph;
    chunks?: Record<string, SavedChunk>;
};

export type ContentManager = {
    /** absolute path to the project's `content/` root, baked at init. */
    contentDir: string;
    entries: SceneEntry[];
    /**
     * last json string we wrote per scene id. `saveScene` consults this to
     * skip identical re-writes — that's the entire purpose now that the
     * engine no longer owns a file watcher.
     */
    _lastWritten: Map<string, string>;
};

// ── file path helpers ───────────────────────────────────────────────

function scenesDir(state: ContentManager): string {
    return path.join(state.contentDir, SCENES_SUBDIR);
}

function scenePath(state: ContentManager, sceneId: string): string {
    return path.join(scenesDir(state), `${sceneId}${SCENE_EXT}`);
}

// ── on-disk ↔ in-memory conversion ──────────────────────────────────

function fileToPayload(file: SceneFile): ScenePayload {
    return {
        nodes: file.nodes,
        voxels: file.chunks ? { chunks: file.chunks } : null,
    };
}

function payloadToFile(payload: ScenePayload): SceneFile {
    const file: SceneFile = { version: SCENE_FILE_VERSION, nodes: payload.nodes };
    if (payload.voxels && Object.keys(payload.voxels.chunks).length > 0) {
        file.chunks = payload.voxels.chunks;
    }
    return file;
}

/**
 * the exact JSON string `saveScene` would write for the given payload.
 * callers that already hold a payload but need to seed `_lastWritten` (e.g.
 * `applyScenePayload`, registry-dispatch) use this so the seeded string
 * matches what a subsequent disk read would return.
 */
export function serializeScenePayload(payload: ScenePayload): string {
    return JSON.stringify(payloadToFile(payload), null, 2);
}

// ── scan ────────────────────────────────────────────────────────────

/**
 * scan the content/scenes/ directory recursively for .scene.json files.
 * scene ids are the path relative to scenes/, with `.scene.json` stripped
 * and path separators normalized to `/` — so
 *   content/scenes/blueprints/foo.scene.json  →  "blueprints/foo"
 *   content/scenes/main.scene.json            →  "main"
 *
 * the `blueprints/` subdirectory is reserved by editor convention; anything
 * else (folders for grouping, etc.) is fine.
 */
function scan(state: ContentManager): SceneEntry[] {
    const dir = scenesDir(state);
    if (!fs.existsSync(dir)) return [];

    const ids: string[] = [];
    walkScenes(dir, dir, ids);
    return ids.sort().map((sceneId) => ({ sceneId }));
}

function walkScenes(root: string, current: string, out: string[]): void {
    for (const ent of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, ent.name);
        if (ent.isDirectory()) {
            walkScenes(root, full, out);
        } else if (ent.isFile() && ent.name.endsWith(SCENE_EXT)) {
            const rel = path.relative(root, full).split(path.sep).join('/');
            out.push(rel.slice(0, -SCENE_EXT.length));
        }
    }
}

// ── init ────────────────────────────────────────────────────────────

export function init(opts: { contentDir: string }): ContentManager {
    const state: ContentManager = {
        contentDir: opts.contentDir,
        entries: [],
        _lastWritten: new Map(),
    };
    state.entries = scan(state);
    return state;
}

// ── queries ─────────────────────────────────────────────────────────

/** list all scene entries. */
export function listScenes(state: ContentManager): SceneEntry[] {
    return state.entries;
}

// ── load ────────────────────────────────────────────────────────────

/**
 * load a scene from disk. returns the in-memory payload or null if the file
 * doesn't exist / is empty / has an unknown version.
 */
export function loadScene(state: ContentManager, sceneId: string): ScenePayload | null {
    const result = loadSceneRaw(state, sceneId);
    return result?.data ?? null;
}

/**
 * load a scene and return the parsed payload plus the raw file bytes.
 * callers seed `_lastWritten` with `raw` so the first flush after a load
 * skips a redundant identical write (and its dev file-watcher echo).
 */
export function loadSceneRaw(state: ContentManager, sceneId: string): { data: ScenePayload; raw: string } | null {
    const filePath = scenePath(state, sceneId);
    if (!fs.existsSync(filePath)) return null;

    let raw: string;
    let parsed: SceneFile;
    try {
        raw = fs.readFileSync(filePath, 'utf-8');
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

// ── save ────────────────────────────────────────────────────────────

/**
 * seed the `_lastWritten` dedup cache with the exact raw bytes for a scene
 * (typically just read off disk, or the payload we just applied to a handle).
 * lets the first flush after a load/apply skip a redundant identical write —
 * and the dev file-watcher echo that write would otherwise cause. seed with
 * real bytes (not a re-serialized snapshot) so the comparison is exact.
 */
export function seedLastWrittenRaw(state: ContentManager, sceneId: string, raw: string): void {
    state._lastWritten.set(sceneId, raw);
}

/**
 * save a scene to disk.
 *
 * the edit room is the single authoritative writer for its scene, so this just
 * writes the room's state — it does not reconcile against the on-disk file.
 * `_lastWritten` lets us skip an identical re-write (and the dev file-watcher
 * echo it would trigger). external edits to a scene that a live edit room owns
 * are intentionally overwritten by the room's next flush; agentic/external
 * authoring will go through the editor action API, not the filesystem.
 */
export function saveScene(state: ContentManager, sceneId: string, payload: ScenePayload): boolean {
    const filePath = scenePath(state, sceneId);

    const file = payloadToFile(payload);
    const content = JSON.stringify(file, null, 2);
    const prev = state._lastWritten.get(sceneId);
    if (content === prev) return false; // no change — skip disk write entirely

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    state._lastWritten.set(sceneId, content);
    fs.writeFileSync(filePath, content, 'utf-8');
    if (!state.entries.some((e) => e.sceneId === sceneId)) {
        state.entries.push({ sceneId });
    }
    return true;
}

// ── delete / rename ─────────────────────────────────────────────────

/** delete a scene's file from disk. */
export function deleteScene(state: ContentManager, sceneId: string): void {
    const p = scenePath(state, sceneId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    state._lastWritten.delete(sceneId);
    state.entries = state.entries.filter((e) => e.sceneId !== sceneId);
}

/** rename a scene's file on disk. returns true if successful. */
export function renameScene(state: ContentManager, oldSceneId: string, newSceneId: string): boolean {
    const oldPath = scenePath(state, oldSceneId);
    const newPath = scenePath(state, newSceneId);

    if (!fs.existsSync(oldPath)) return false;
    if (fs.existsSync(newPath)) return false;

    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.renameSync(oldPath, newPath);

    const val = state._lastWritten.get(oldSceneId);
    if (val !== undefined) {
        state._lastWritten.set(newSceneId, val);
        state._lastWritten.delete(oldSceneId);
    }

    state.entries = state.entries.map((e) => (e.sceneId === oldSceneId ? { ...e, sceneId: newSceneId } : e));
    if (!state.entries.some((e) => e.sceneId === newSceneId)) {
        state.entries.push({ sceneId: newSceneId });
    }

    return true;
}
