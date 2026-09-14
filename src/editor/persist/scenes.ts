import * as Content from '../../core/content';
import type { ScenePayload } from '../../core/content/scene-store';
import * as ContentManager from '../../server/content-manager';
import * as Rooms from '../../server/rooms';
import type { EngineServer } from '../../server/server';

const encoder = new TextEncoder();

/** The last write issued per scene; a new write on that scene runs after it. */
const tails = new Map<string, Promise<void>>();

/** Runs `op` after every pending write on `sceneIds` and makes it their new tail. The tail itself never rejects, so a failed write never wedges the ones behind it. */
function after(sceneIds: string[], op: () => Promise<void>): Promise<void> {
    const previous = Promise.all(sceneIds.map((id) => tails.get(id) ?? Promise.resolve()));
    const run = previous.then(op, op);
    const settled = run.catch(() => {});
    for (const id of sceneIds) tails.set(id, settled);
    return run;
}

/** Awaits every write issued so far, so the bytes reach disk before a fresh realm reloads them. */
export function drainWrites(): Promise<void> {
    return Promise.all(tails.values()).then(() => {});
}

export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Returns null when the stored json was already identical (no write), else the write. */
export function saveScene(state: EngineServer, sceneId: string, payload: ScenePayload): Promise<void> | null {
    const raw = ContentManager.serializeScenePayload(payload);
    if (raw === state.contentManager.scenes.get(sceneId)) return null;
    ContentManager.putScene(state.contentManager, sceneId, raw);
    return after([sceneId], () => state.fs.write(ContentManager.scenePath(sceneId), encoder.encode(raw)));
}

/** Stops every room on the scene (each flushes as its editors leave, ahead of the remove on the same tail), clears the declared handle, drops it from the store, removes the file. */
export function deleteScene(state: EngineServer, sceneId: string): Promise<void> {
    if (!sceneId.trim()) return Promise.resolve();
    Rooms.stopScene(state, sceneId);
    Content.clearScene(state.content, sceneId, 'server');
    ContentManager.dropScene(state.contentManager, sceneId);
    return after([sceneId], () => state.fs.remove(ContentManager.scenePath(sceneId)));
}

/** Renames a scene in the store, on disk, and on every open room. */
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
