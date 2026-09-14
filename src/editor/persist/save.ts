// editor/persist/save.ts, the editor's persistence policy for an edit room: when its
// unsaved edits land in the scene store and on disk (persist/scenes.ts does the
// writing). One RoomPersist per open edit room, held by the editor system's script
// closure. The room's own scene tree + voxels are the state; this holds only the
// dirty flag, the incremental voxel cache and the autosave clock.

import * as Content from '../../core/content';
import * as Debug from '../../core/debug';
import { registry } from '../../core/registry';
import * as SceneTree from '../../core/scene/scene-tree';
import { SetBlockFlags } from '../../core/voxels/block-flags';
import { formatKey } from '../../core/voxels/block-registry';
import * as Light from '../../core/voxels/light';
import { saveVoxelsIncremental, seedVoxelSaveCache, type VoxelSaveCache } from '../../core/voxels/voxel-savefile';
import { setBlock } from '../../core/voxels/voxels';
import * as ContentManager from '../../server/content-manager';
import type * as Rooms from '../../server/rooms';
import type { EngineServer } from '../../server/server';
import * as Scenes from './scenes';

/** how often a dirty edit room auto-flushes. dirty-gated + incremental, so a clean
 *  editor never touches disk; this only bounds the unsaved-edit loss window. */
const AUTOSAVE_INTERVAL_S = 3;

export type RoomPersist = {
    state: EngineServer;
    room: Rooms.Room;
    /** unsaved edits since the last flush, gates the interval auto-flush. */
    dirty: boolean;
    /** per-chunk serialized-byte cache for incremental voxel save: seeded on open,
     *  refreshed on each flush, so a flush re-gzips only chunks whose version moved. */
    voxelSaveCache: VoxelSaveCache;
    /** seconds since the last interval auto-flush. */
    since: number;
    /** where a failed write is reported: the room's chat, in front of the editor. */
    report: (message: string) => void;
};

/** bind persistence to an edit room the runtime just initialized. A scene the store
 *  already holds seeds the incremental cache from it (a second parse of the raw json;
 *  the room's own load keeps only the live voxels). A brand-new scene gets the starter
 *  floor and its first file. */
export function open(state: EngineServer, room: Rooms.Room, report: (message: string) => void): RoomPersist {
    const persist: RoomPersist = { state, room, dirty: false, voxelSaveCache: new Map(), since: 0, report };
    const sceneFile = ContentManager.loadSceneRaw(state.contentManager, room.sceneId);
    if (sceneFile) {
        if (sceneFile.data.voxels) persist.voxelSaveCache = seedVoxelSaveCache(room.voxels, sceneFile.data.voxels);
    } else {
        seedStarterFloor(room);
        saveRoom(persist);
    }
    return persist;
}

export function markDirty(persist: RoomPersist): void {
    persist.dirty = true;
}

/** flush if dirty + clear the flag. no-op on a clean room. */
export function flush(persist: RoomPersist): boolean {
    if (!persist.dirty) return false;
    saveRoom(persist);
    persist.dirty = false;
    return true;
}

/** the interval auto-flush, driven from the editor system's onTick. */
export function tick(persist: RoomPersist, delta: number): void {
    persist.since += delta;
    if (persist.since < AUTOSAVE_INTERVAL_S) return;
    persist.since = 0;
    Debug.begin(persist.state.profiler, 'save');
    flush(persist);
    Debug.end(persist.state.profiler, 'save');
}

/** serialize + store + write one edit room; returns whether the stored scene changed.
 *  voxels serialize incrementally against the cache. Refuses a room the runtime no
 *  longer holds: its scene is torn down and would overwrite the file with nothing. */
function saveRoom(persist: RoomPersist): boolean {
    const { state, room } = persist;
    if (state.rooms.rooms.get(room.id) !== room) return false;

    const payload = {
        nodes: SceneTree.saveSceneTree(room.scene),
        voxels: saveVoxelsIncremental(room.voxels, persist.voxelSaveCache),
    };
    const written = Scenes.saveScene(state, room.sceneId, payload);
    if (written === null) return false;

    // bump the scene handle so in-process readers (cross-room prefab readers in the
    // same tick) see the new state now; the file watcher reaches the client later.
    Content.populateScene(state.content, registry.blockRegistry, room.sceneId, payload, 'server');
    written.catch((err) => persist.report(`[save] ${room.sceneId} did not reach disk: ${Scenes.errorMessage(err)}`));
    return true;
}

/** seed a brand-new edit scene with a floor of the first registered user block,
 *  centered on origin at y=0, so the user has something to stand on and click
 *  instead of a void. once saved, later opens load from the file. */
function seedStarterFloor(room: Rooms.Room): void {
    const blockRegistry = registry.blockRegistry;
    const firstUser = blockRegistry.defs.find((d) => d.id !== 'air');
    if (!firstUser) return;
    const key = formatKey(firstUser.id, firstUser.states, 0);
    for (let x = -25; x <= 25; x++) {
        for (let z = -25; z <= 25; z++) {
            setBlock(room.voxels, x, 0, z, key, SetBlockFlags.BULK);
        }
    }
    Light.propagateAllLight(room.voxels);
}
