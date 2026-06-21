// ── save ─────────────────────────────────────────────────────────────
//
// Persistence coordinator. Every path that writes an edit room to disk routes
// through here: the interval auto-flush, the explicit `save_scene`, the
// before-exit flush, the play-start snapshot, and the starter-floor seed.
//
// It sequences the two layers below it rather than owning them: content-manager
// (disk I/O + self-write dedup) and voxel-savefile (incremental serialization).
// Per-room save state lives on `room.edit` (Rooms.RoomEditState) — null on play
// rooms, so they can never be persisted.

import * as Content from '../core/content';
import * as Debug from '../core/debug';
import { registry } from '../core/registry';
import * as Nodes from '../core/scene/nodes';
import { saveVoxelsIncremental, seedVoxelSaveCache, type SavedVoxels } from '../core/voxels/voxel-savefile';
import * as ContentManager from './content-manager';
import type { EngineServer } from './engine-server';
import * as Rooms from './rooms';

/** how often dirty edit rooms auto-flush to disk. dirty-gated + incremental, so
 *  a clean editor (and all of play mode) never flushes — this only bounds the
 *  unsaved-edit loss window. */
const AUTOSAVE_INTERVAL_S = 3;

/** serialize + persist one edit room to disk; returns whether the file changed.
 *  voxels serialize incrementally — only chunks whose data version moved since
 *  the last flush are re-gzipped. no-op (false) on play rooms. */
export function saveRoom(state: EngineServer, room: Rooms.Room): boolean {
    if (!room.edit) return false; // edit === null ⇔ play room (never persists)

    const payload = {
        nodes: Nodes.saveSceneGraph(room.nodes),
        voxels: saveVoxelsIncremental(room.voxels, room.edit.voxelSaveCache),
    };
    const sceneChanged = ContentManager.saveScene(state.contentManager, room.sceneId, payload);

    // bump the scene handle version so in-process consumers (cross-room prefab
    // readers in the same tick) see the new state immediately — the file-watcher
    // → HMR fan-out reaches the client out-of-band.
    if (sceneChanged) {
        Content.populateScene(state.content, registry.blockRegistry, room.sceneId, payload, 'server');
    }
    return sceneChanged;
}

/** seed a room's incremental-save cache from the bytes just loaded off disk, so
 *  the first flush only re-gzips chunks edited since boot. no-op on play rooms. */
export function seedRoom(room: Rooms.Room, saved: SavedVoxels): void {
    if (room.edit) room.edit.voxelSaveCache = seedVoxelSaveCache(room.voxels, saved);
}

/** flush every dirty edit room now + clear its flag. the before-exit path. */
export function flushDirty(state: EngineServer): void {
    for (const room of state.rooms.rooms.values()) {
        if (!room.edit?.dirty) continue;
        saveRoom(state, room);
        Rooms.setRoomDirty(room, false);
    }
}

/** interval auto-flush, driven from the server tick. accumulates `delta` and
 *  flushes dirty edit rooms every AUTOSAVE_INTERVAL_S — clean and play rooms are
 *  skipped, so an idle or playing server never touches disk. */
export function tick(state: EngineServer, delta: number): void {
    state.flushSince += delta;
    if (state.flushSince < AUTOSAVE_INTERVAL_S) return;
    state.flushSince = 0;
    Debug.begin(state.metrics, 'save');
    flushDirty(state);
    Debug.end(state.metrics, 'save');
}

/** explicit save (the editor's `save_scene` message): flush every edit room for
 *  the given scene + clear its flag. */
export function saveScene(state: EngineServer, sceneId: string): void {
    Debug.begin(state.metrics, 'save');
    for (const room of state.rooms.rooms.values()) {
        if (room.sceneId !== sceneId || !room.edit) continue;
        saveRoom(state, room);
        Rooms.setRoomDirty(room, false);
    }
    Debug.end(state.metrics, 'save');
}
