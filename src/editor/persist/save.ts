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

/** Dirty-gated + incremental, so a clean editor never touches disk; this only bounds the unsaved-edit loss window. */
const AUTOSAVE_INTERVAL_S = 3;

export type RoomPersist = {
    state: EngineServer;
    room: Rooms.Room;
    /** Unsaved edits since the last flush, gates the interval auto-flush. */
    dirty: boolean;
    /** Per-chunk serialized-byte cache for incremental voxel save, so a flush re-gzips only chunks whose version moved. */
    voxelSaveCache: VoxelSaveCache;
    since: number;
    /** Where a failed write is reported: the room's chat, in front of the editor. */
    report: (message: string) => void;
};

/** A scene the store already holds seeds the incremental cache from it. A brand-new scene gets the starter floor and its first file. */
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

/** Flushes if dirty and clears the flag. No-op on a clean room. */
export function flush(persist: RoomPersist): boolean {
    if (!persist.dirty) return false;
    saveRoom(persist);
    persist.dirty = false;
    return true;
}

/** The interval auto-flush, driven from the editor system's onTick. */
export function tick(persist: RoomPersist, delta: number): void {
    persist.since += delta;
    if (persist.since < AUTOSAVE_INTERVAL_S) return;
    persist.since = 0;
    Debug.begin(persist.state.profiler, 'save');
    flush(persist);
    Debug.end(persist.state.profiler, 'save');
}

/** Refuses a room the runtime no longer holds: its scene is torn down and would overwrite the file with nothing. */
function saveRoom(persist: RoomPersist): boolean {
    const { state, room } = persist;
    if (state.rooms.rooms.get(room.id) !== room) return false;

    const payload = {
        nodes: SceneTree.saveSceneTree(room.scene),
        voxels: saveVoxelsIncremental(room.voxels, persist.voxelSaveCache),
    };
    const written = Scenes.saveScene(state, room.sceneId, payload);
    if (written === null) return false;

    // Bumps the scene handle so in-process readers see the new state now; the file watcher reaches the client later.
    Content.populateScene(state.content, registry.blockRegistry, room.sceneId, payload, 'server');
    written.catch((err) => persist.report(`[save] ${room.sceneId} did not reach disk: ${Scenes.errorMessage(err)}`));
    return true;
}

/** Floor of the first registered user block, centered on origin at y=0, so the user has something to stand on instead of a void. */
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
