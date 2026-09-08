// editor/persist/scenes.ts, writing scenes to the project fs. The runtime holds the
// in-memory scene store and reads through the host fs; the editor is the only
// writer, so it owns the write pipeline: per-scene ordering (a scene's writes and
// removes never reorder; unrelated scenes do not wait on each other), the shutdown
// drain, and failure reporting (each call returns its write, the caller reports).
// Writes go through `state.fs`, the host filesystem the engine holds.

import * as Content from '../../core/content';
import type { ScenePayload } from '../../core/content/scene-store';
import * as ContentManager from '../../server/content-manager';
import * as Rooms from '../../server/rooms';
import type { EngineServer } from '../../server/server';

const encoder = new TextEncoder();

/** the last write issued per scene; a new write on that scene runs after it. */
const tails = new Map<string, Promise<void>>();

/** run `op` after every pending write on `sceneIds`, and make it their new tail.
 *  the returned promise rejects if the op does; the tail itself never does, so a
 *  failed write never wedges the ones behind it. */
function after(sceneIds: string[], op: () => Promise<void>): Promise<void> {
    const previous = Promise.all(sceneIds.map((id) => tails.get(id) ?? Promise.resolve()));
    const run = previous.then(op, op);
    const settled = run.catch(() => {});
    for (const id of sceneIds) tails.set(id, settled);
    return run;
}

/** await every write issued so far. The host calls this after `EngineServer.dispose`
 *  on a graceful stop, so the bytes reach disk before a fresh realm reloads them. */
export function drainWrites(): Promise<void> {
    return Promise.all(tails.values()).then(() => {});
}

export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** store + write a scene. Returns null when the stored json was already identical
 *  (no write), else the write. */
export function saveScene(state: EngineServer, sceneId: string, payload: ScenePayload): Promise<void> | null {
    const raw = ContentManager.serializeScenePayload(payload);
    if (raw === state.contentManager.scenes.get(sceneId)) return null;
    ContentManager.putScene(state.contentManager, sceneId, raw);
    return after([sceneId], () => state.fs.write(ContentManager.scenePath(sceneId), encoder.encode(raw)));
}

/** delete a scene: stop every room on it (each flushes as its editors leave, ahead
 *  of the remove on the same tail), clear the declared handle, drop it from the
 *  store, remove the file. */
export function deleteScene(state: EngineServer, sceneId: string): Promise<void> {
    if (!sceneId.trim()) return Promise.resolve();
    Rooms.stopScene(state, sceneId);
    Content.clearScene(state.content, sceneId, 'server');
    ContentManager.dropScene(state.contentManager, sceneId);
    return after([sceneId], () => state.fs.remove(ContentManager.scenePath(sceneId)));
}

/** rename a scene in the store, on disk, and on every open room. */
export function renameScene(state: EngineServer, oldSceneId: string, newSceneId: string): Promise<void> {
    if (!newSceneId.trim() || oldSceneId === newSceneId) return Promise.resolve();
    if (!ContentManager.moveScene(state.contentManager, oldSceneId, newSceneId)) return Promise.resolve();
    Rooms.retargetScene(state, oldSceneId, newSceneId);
    const raw = state.contentManager.scenes.get(newSceneId)!;
    return after([oldSceneId, newSceneId], async () => {
        await state.fs.remove(ContentManager.scenePath(oldSceneId));
        await state.fs.write(ContentManager.scenePath(newSceneId), encoder.encode(raw));
    });
}
