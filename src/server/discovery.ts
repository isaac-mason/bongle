import type { Client } from 'bongle/interface';
import { PlayerTrait } from '../builtins/player';
import { getWorldPosition, TransformTrait } from '../builtins/transform';
import type { PlayerId } from '../core/client';
import { SERVER_TICK_HZ } from '../core/clock';
import * as Debug from '../core/debug';
import type { BinaryField, BinaryTrait, RoomInfo, RoomMode, SceneSyncUpdate, ServerMessage, VoxelAck } from '../core/protocol';
import { registry } from '../core/registry';
import type { Resources } from '../core/resources';
import { getControlCodecs, getSyncCodecs } from '../core/scene/packcat-bridge';
import { packSceneTree } from '../core/scene/scene-pack';
import {
    bumpFieldVersion,
    childIndexOf,
    clearDirtyNodes,
    EMPTY_UNRESOLVED,
    encodePrefabConfig,
    getNodeById,
    getTrait,
    hasTrait,
    isReplicable,
    isTransformRoot,
    type Node,
    type Realm,
    reconcileRootRegions,
    rootsInRegion,
    type SceneTree,
} from '../core/scene/scene-tree';
import { diffSync, writeSnapshot } from '../core/scene/sync/sync-diff';
import * as SyncRate from '../core/scene/sync/sync-rate';
import type { TraitBase, TraitDef, TraitHandle } from '../core/scene/traits';
import { encodeChunk, encodeLight, type Zstd } from '../core/voxels/chunk-codec';
import {
    CHUNK_VOLUME,
    type Chunk,
    chunkKey,
    chunkToRegionCoord,
    clearVoxelChanges,
    REGION_CHUNKS_PER_AXIS,
    REGION_LOCAL_CHUNK_OFFSETS,
    REGION_VOLUME,
    regionKey,
    toChunkCoord,
    type VoxelBlockOp,
    type VoxelChanges,
    type Voxels,
} from '../core/voxels/voxels';
import type { ServerNet } from './net';
import * as Net from './net';
import type { Player, Room, Rooms } from './rooms';
import * as RoomsModule from './rooms';

/** runs diff detection on a scene tree: compares each trait's current sync values against the per-instance snapshots, bumping versions on change. */
export function runDiffDetection(sceneTree: SceneTree): void {
    for (const node of sceneTree.nodes) {
        diffNode(sceneTree, node);
    }
}

function diffNode(sceneTree: SceneTree, node: Node): void {
    // walk the bitset's set bits, not `_traits` end to end: a node with one late-registered trait would walk hundreds of holes.
    const nodeTraits = node.traits;
    const bits = node.bitset;
    for (let w = 0; w < bits.length; w++) {
        let word = bits[w]!;
        while (word !== 0) {
            const lowest = word & -word;
            word ^= lowest;
            const traitSlot = w * 32 + (31 - Math.clz32(lowest));
            const instance = nodeTraits[traitSlot];
            if (instance === undefined) continue;

            diffInstance(sceneTree, node, instance);
        }
    }
}

function diffInstance(sceneTree: SceneTree, node: Node, instance: TraitBase): void {
    const handle = registry.traits.handles.get(instance._def.id);
    if (!handle) return;
    const codecs = getSyncCodecs(handle);
    if (!codecs) return;

    const sync = instance._sync;
    if (!sync) return;

    for (let i = 0; i < codecs.length; i++) {
        const codec = codecs[i];

        // dirty fast path: read+clear sync-dirty bits before byte-diffing.
        const word = i >> 5;
        const bit = 1 << (i & 31);
        if ((sync.dirty[word] & bit) !== 0) {
            sync.dirty[word] &= ~bit;
            // only 'explicit' slices emit purely on the dirty bit; 'diff' and threshold slices still verify below.
            if (handle.def.sync[i].dirty === 'explicit') {
                writeSnapshot(codec, instance, node, i, sync);
                bumpFieldVersion(sceneTree, node, instance, i);
                continue;
            }
        }

        if (handle.def.sync[i].dirty === 'explicit') continue;

        // byte-diff or threshold metric; a first-seen slice is seeded silently, so emitOnFirstSeen = false.
        if (diffSync(codec, instance, node, i, sync, false)) {
            bumpFieldVersion(sceneTree, node, instance, i);
        }
    }
}

type TraitKnowledge = {
    // the trait's registry id, so a removal can still name it if the def has since left the registry.
    id: string;
    // true when a field of this trait is version-ahead of what this client has because rate gating held it back.
    behind: boolean;
    // dense arrays indexed by sync field index; 0 = never bumped.
    versions: number[];
    // NEVER_SENT until this field first ships (tick 0 is a real tick).
    lastSentTicks: number[];
};

/** `lastSentTicks` entry for a field that has never shipped to this client. */
const NEVER_SENT = -1;

// pushed from `[]` rather than `new Array(n)`/`.fill()`, which stays HOLEY forever and makes every read polymorphic.
function filled(n: number, value: number): number[] {
    const a: number[] = [];
    for (let i = 0; i < n; i++) a.push(value);
    return a;
}

type ClientNodeKnowledge = {
    parentId: number;
    childIndex: number;
    name: string | undefined;
    owner: PlayerId | null;
    realm: Realm;
    // indexed the same way `Node._traits` is.
    traits: Array<TraitKnowledge | undefined>;
    // traits whose def was missing at snapshot time (HMR drift); mirrors `Node._unresolvedTraits`, null until one appears.
    unresolvedTraits: Map<string, TraitKnowledge> | null;
    // json-encoded PrefabConfig, or null if no prefab.
    prefab: string | null;
};

/** chunk coords stored alongside the key so callers don't re-derive them by parsing the chunkKey() string every time. */
type ChunkCoord = { cx: number; cy: number; cz: number };

/** region coords stored alongside the key so callers don't re-derive them by parsing the region key string. */
type RegionCoord = { rx: number; ry: number; rz: number };

/** one region's worth of this client's known chunks, keyed like `voxels.regions`, so eviction's sphere test is O(known regions). */
type ClientKnownRegion = { rx: number; ry: number; rz: number; chunks: Map<string, ChunkCoord> };

type ClientVoxelKnowledge = {
    // full data or an air stub; shipped individually or as part of a voxel_region_full bundle.
    knownChunks: Map<string, ChunkCoord>;
    // lets collision distinguish "known air" from "unknown" (treated as solid).
    knownEmptyChunks: Map<string, ChunkCoord>;
    // secondary index over knownChunks and knownEmptyChunks, grouped by region, so eviction's sphere test is O(known regions).
    knownRegions: Map<string, ClientKnownRegion>;
    knownLightEpoch: number;
    // player's region coord at the last flush; eviction and the discovery recompute run only when this changes, null until first flush.
    lastAnchorRegion: [number, number, number] | null;
    // regions discovered in-range but not yet shipped as voxel_region_full; only the ship is rate-limited, not the discovery test.
    pendingRegions: Map<string, RegionCoord>;
    // regions shipped as voxel_region_full but not yet acked; dispatchRegionFull stops shipping once this hits `maxInFlightRegions`.
    inFlightRegions: Set<string>;
    // starts at 1 so a fresh join doesn't demand a burst of compression; bumped to MAX_IN_FLIGHT_REGIONS on the first region ack.
    maxInFlightRegions: number;
    // self-reported, smoothed decode rate (regions/tick); starts at the default and only moves once a real ack lands.
    fullRegionsPerTick: number;
    // chunks whose light changed but hasn't shipped yet; survives across ticks.
    pendingLight: Set<string>;
    // chunks needing an individual voxel_chunk_full re-send (promotion, too many block-ops in an already-known chunk); fixed-rate.
    pendingFull: Set<string>;
    // chunks shipped as an individual voxel_chunk_full but not yet acked; disjoint from pendingFull, a subset of knownChunks.
    inFlightFull: Set<string>;
};

/** per-Player entity/prop presence: a pure region-membership set, not residency data; recomputed in full on every anchor cross. */
type ClientEntityPresence = {
    knownRegions: Set<string>;
    // null until the first recompute.
    lastAnchorRegion: [number, number, number] | null;
    // per-tick deltas, cleared-then-filled by `flushEntityPresenceForPlayer`, consumed the same tick by `buildSceneSyncUpdates`.
    entered: Set<string>;
    left: Set<string>;
};

type ClientState = {
    // mode-aware: an edit-Player tracks server-only and edit-only nodes a play-Player in the same room would not.
    nodeKnowledge: Map<PlayerId, Map<number, ClientNodeKnowledge>>;

    // per-Player nodes that still owe this client a rate-throttled `sync()` field, so the fan-out can revisit settled sources.
    nodeSyncKnowledge: Map<PlayerId, Set<Node>>;

    // Players that have received their join_room (and so have a populated nodeKnowledge).
    knownPlayers: Set<PlayerId>;

    // -1 = never received.
    roomListVersion: number;

    // each Player has its own streaming anchor and known-chunks set, so views stay isolated within one client.
    voxelKnowledge: Map<PlayerId, ClientVoxelKnowledge>;

    // same per-Player isolation as voxelKnowledge, but otherwise independent: entity presence never reads voxel residency state.
    entityPresence: Map<PlayerId, ClientEntityPresence>;

    // runtime-source model ids told to this client via `register_model`; bundled entries never enter this set.
    knownModels: Set<string>;
};

/** a server->client RPC command queued for this tick, drained by `flushCommands`. */
type QueuedCommand =
    | { kind: 'send'; client: Client; msg: ServerMessage }
    | { kind: 'broadcast'; roomId: string; msg: ServerMessage };

export type Discovery = {
    /** monotonic version bumped whenever the room list changes. */
    roomListVersion: number;

    /** per-client tracking. */
    clients: Map<Client, ClientState>;

    /** RPC commands emitted this tick, drained by `flushCommands` after scene distribution so a command never beats this tick's scene state. */
    commandQueue: QueuedCommand[];

    /** zstd impl for chunk_full snapshots, injected by the server entry so this browser-bundled module never imports node:zlib. */
    zstd: Zstd;
};

export function init(zstd: Zstd): Discovery {
    return {
        roomListVersion: 0,
        clients: new Map(),
        commandQueue: [],
        zstd,
    };
}

// queued here rather than written straight to the outbox, so a command from `onJoin` lands after the joiner's `join_room`.
export function queueCommand(state: Discovery, cmd: QueuedCommand): void {
    state.commandQueue.push(cmd);
}

export function flushCommands(state: Discovery, net: ServerNet, rooms: Rooms): void {
    // splice a snapshot so any command emitted while draining defers to the next tick instead of mutating the array mid-iteration.
    const batch = state.commandQueue.splice(0);
    for (const cmd of batch) {
        if (cmd.kind === 'send') {
            Net.send(net, cmd.client, cmd.msg);
        } else {
            const room = RoomsModule.getRoom(rooms, cmd.roomId);
            if (room) Net.broadcastToRoom(net, rooms, room, cmd.msg);
        }
    }
}

export function addClient(state: Discovery, client: Client): void {
    state.clients.set(client, {
        nodeKnowledge: new Map(),
        nodeSyncKnowledge: new Map(),
        knownPlayers: new Set(),
        roomListVersion: -1,
        voxelKnowledge: new Map(),
        entityPresence: new Map(),
        knownModels: new Set(),
    });
}

export function removeClient(state: Discovery, client: Client): void {
    state.clients.delete(client);
}

export function invalidateRoomList(state: Discovery): void {
    state.roomListVersion++;
}

/** call when a Player is allocated or its scene is structurally invalidated; synchronously emits join_room, only scene_sync batches to end-of-tick. */
export function invalidatePlayer(state: Discovery, net: ServerNet, rooms: Rooms, resources: Resources, player: Player): void {
    const cs = state.clients.get(player.client);
    if (!cs) return;

    const room = RoomsModule.getRoom(rooms, player.roomId);
    if (!room) return;

    // (re-)initialize per-Player knowledge against the current scene
    const nodeKnowledge = new Map<number, ClientNodeKnowledge>();
    cs.nodeKnowledge.set(player.id, nodeKnowledge);
    cs.nodeSyncKnowledge.set(player.id, new Set());
    cs.knownPlayers.add(player.id);

    cs.voxelKnowledge.set(player.id, {
        knownChunks: new Map(),
        knownEmptyChunks: new Map(),
        knownRegions: new Map(),
        knownLightEpoch: 0,
        lastAnchorRegion: null,
        pendingRegions: new Map(),
        inFlightRegions: new Set(),
        maxInFlightRegions: 1,
        fullRegionsPerTick: DEFAULT_REGIONS_PER_TICK,
        pendingLight: new Set(),
        pendingFull: new Set(),
        inFlightFull: new Set(),
    });

    cs.entityPresence.set(player.id, {
        knownRegions: new Set(),
        lastAnchorRegion: null,
        entered: new Set(),
        left: new Set(),
    });

    // catch this client up on runtime model entries before `join_room`, since packed trait fields may reference these modelIds.
    for (const msg of computeModelRegistrations(cs, resources)) {
        Net.send(net, player.client, msg);
    }

    // AOI-aware join: when this player streams chunks, omit transform-root subtrees (except its own) from the packed scene.
    const ownPlayerNode = room.playerNodes.get(player.id);
    const transformRootPrune =
        player.mode === 'play' && room.voxels.authority
            ? (node: Node) => node !== ownPlayerNode && isTransformRoot(node)
            : undefined;

    const packT0 = performance.now();
    const packedNodes = packSceneTree(room.scene, player.mode, transformRootPrune);
    const packMs = performance.now() - packT0;
    Net.send(net, player.client, {
        type: 'join_room',
        playerId: player.id,
        playerMode: player.mode,
        roomMode: room.mode,
        roomId: room.id,
        sceneId: room.sceneId,
        packedNodes,
        clientId: player.client,
        namespace: room.namespace,
        serverClockTime: room.clock.time, // client seeds its clock from this (shared time base)
    });

    // snapshot every node so the same-tick scene_sync diff finds no changes.
    const snapT0 = performance.now();
    snapshotAllNodeKnowledge(room.scene, nodeKnowledge, player.mode, transformRootPrune);
    const snapMs = performance.now() - snapT0;
    console.log(
        `[room-start]     invalidatePlayer packSceneTree=${packMs.toFixed(1)} ` +
            `snapshotNodes=${snapMs.toFixed(1)} packedBytes=${packedNodes.byteLength}`,
    );
}

/** call when a Player is removed (already gone from `state.players`); synchronously emits room_left and drops all per-Player knowledge. */
export function notifyPlayerLeft(state: Discovery, net: ServerNet, player: Player): void {
    const cs = state.clients.get(player.client);
    if (!cs) return;

    cs.nodeKnowledge.delete(player.id);
    cs.nodeSyncKnowledge.delete(player.id);
    cs.knownPlayers.delete(player.id);
    cs.voxelKnowledge.delete(player.id);
    cs.entityPresence.delete(player.id);

    Net.send(net, player.client, { type: 'room_left', playerId: player.id });
}

/** diffs `resources.models` (runtime entries only) against this client's `knownModels`, returning sync messages and updating `knownModels`. */
function computeModelRegistrations(cs: ClientState, resources: Resources): ServerMessage[] {
    const msgs: ServerMessage[] = [];
    const live = new Set<string>();
    for (const [id, entry] of resources.models) {
        if (entry.source !== 'runtime') continue;
        live.add(id);
        if (cs.knownModels.has(id)) continue;
        msgs.push({
            type: 'register_model',
            id,
            clientUrl: entry.clientUrl,
            hash: entry.hash,
            size: entry.size,
        });
        cs.knownModels.add(id);
    }
    for (const id of cs.knownModels) {
        if (live.has(id)) continue;
        msgs.push({ type: 'unregister_model', id });
        cs.knownModels.delete(id);
    }
    return msgs;
}

/** stamps the current node state into the originating client's knowledge after a mutation, so discovery doesn't echo the change back. */
export function stampNodeKnowledge(
    state: Discovery,
    rooms: Rooms,
    client: Client,
    roomId: string,
    sceneTree: SceneTree,
    nodeId: number,
): void {
    const cs = state.clients.get(client);
    if (!cs) return;
    const node = getNodeById(sceneTree, nodeId);
    if (!node) return;
    for (const player of RoomsModule.getPlayersForClient(rooms, client)) {
        if (player.roomId !== roomId) continue;
        const nodeKnowledge = cs.nodeKnowledge.get(player.id);
        if (!nodeKnowledge) continue;
        snapshotNodeKnowledge(nodeKnowledge, node);
    }
}

/** removes the originating client's knowledge of a destroyed node, so discovery doesn't send a redundant node_destroyed message. */
export function forgetNode(state: Discovery, rooms: Rooms, client: Client, roomId: string, nodeId: number): void {
    const cs = state.clients.get(client);
    if (!cs) return;
    for (const player of RoomsModule.getPlayersForClient(rooms, client)) {
        if (player.roomId !== roomId) continue;
        const nodeKnowledge = cs.nodeKnowledge.get(player.id);
        if (!nodeKnowledge) continue;
        nodeKnowledge.delete(nodeId);
    }
}

/** accepts owner-authority fields from the owning client: applies the value, updates the diff snapshot, and stamps client knowledge. */
export function acceptOwnerFields(
    state: Discovery,
    rooms: Rooms,
    roomId: string,
    client: Client,
    sceneTree: SceneTree,
    node: Node,
    def: TraitDef,
    instance: TraitBase,
    fields: BinaryField[],
    mode: RoomMode,
    syncRemap?: (number | undefined)[],
): void {
    // play mode: non-shared nodes aren't synced to other clients, so an owner-authority write would silently never reach anyone.
    if (mode === 'play' && !isReplicable(node)) return;

    const handle = registry.traits.handles.get(instance._def.id);
    if (!handle) return;
    const codecs = getSyncCodecs(handle);
    if (!codecs) return;

    const sync = instance._sync;
    if (!sync) return;

    // stamp every Player the client holds in this room, so none echo this write back.
    const cs = state.clients.get(client);
    const targetPlayers: Player[] = cs ? RoomsModule.getPlayersForClient(rooms, client).filter((p) => p.roomId === roomId) : [];

    for (const entry of fields) {
        // `entry.index` is the sending client's sync slot; map it to ours by id.
        const i = syncRemap ? syncRemap[entry.index] : entry.index;
        if (i === undefined) continue;
        const codec = codecs[i];
        if (!codec) continue;
        const syncDef = def.sync[i];
        if (syncDef.authority !== 'owner') continue;

        // codec.apply clears the sync-dirty bit so the next diffNode pass doesn't re-pack from the same write and double-bump.
        codec.apply(entry.data, instance);

        // reuse the shared scratch rather than allocating per owner field, since owner writes land every tick.
        writeSnapshot(codec, instance, node, i, sync);

        // broadcasts to non-owners via the per-client knowledge diff in buildSceneSyncUpdates; the owner is exempted below.
        bumpFieldVersion(sceneTree, node, instance, i);

        if (!cs) continue;
        const fieldVersion = instance._sync?.versions[i] ?? 0;
        for (const player of targetPlayers) {
            const nodeKnowledge = cs.nodeKnowledge.get(player.id);
            const known = nodeKnowledge?.get(node.id);
            if (!known) continue;
            let traitKnowledge = known.traits[handle.slot];
            if (!traitKnowledge) {
                traitKnowledge = {
                    id: def.id,
                    behind: false,
                    versions: filled(def.sync.length, 0),
                    lastSentTicks: filled(def.sync.length, NEVER_SENT),
                };
                known.traits[handle.slot] = traitKnowledge;
            }
            // stamp the field version; lastSentTick stays as-is (NEVER_SENT if first seen).
            traitKnowledge.versions[i] = fieldVersion;
        }
    }
}

/** produces pending messages for all clients; call once per tick, after scripts have run. */
export function flush(
    state: Discovery,
    rooms: Rooms,
    resources: Resources,
    profiler: Debug.Profiler,
): Array<[Client, ServerMessage]> {
    const out: Array<[Client, ServerMessage]> = [];

    Debug.begin(profiler, 'discovery/diff');
    for (const room of rooms.rooms.values()) {
        runDiffDetection(room.scene);
    }
    Debug.end(profiler, 'discovery/diff');

    // runs before the scene phase: the region index must be current when scene sync gates node presence via `rootRegionChanges`.
    Debug.begin(profiler, 'discovery/voxels');
    for (const room of rooms.rooms.values()) {
        reconcileRootRegions(room.scene);
        const auth = room.voxels.authority;
        if (!auth) continue;
        flushVoxelsForRoom(state, rooms, room, out);
        clearVoxelChanges(auth.changes);
        // mask + count aren't cleared here; unshipped chunks keep their accumulated light delta for next tick.
        for (const chunk of room.voxels.dirty.light) {
            chunk.lightDirty = false;
        }
        room.voxels.dirty.light.clear();
    }
    Debug.end(profiler, 'discovery/voxels');

    Debug.begin(profiler, 'discovery/scene');

    // build room list lazily (only if at least one client needs it)
    let roomListJson: string | null = null;
    const buildRoomListJson = (): string => {
        if (roomListJson === null) {
            const infos: RoomInfo[] = [];
            for (const room of rooms.rooms.values()) {
                infos.push({
                    id: room.id,
                    sceneId: room.sceneId,
                    roomMode: room.mode,
                    clientCount: RoomsModule.getClientsInRoom(rooms, room).size,
                    sourceRoomId: room.sourceRoomId,
                    namespace: room.namespace,
                });
            }
            roomListJson = JSON.stringify(infos);
        }
        return roomListJson;
    };

    for (const [client, cs] of state.clients) {
        // pushed before scene_sync so a freshly-registered modelId can resolve to a URL entry by the time it lands.
        for (const msg of computeModelRegistrations(cs, resources)) {
            out.push([client, msg]);
        }

        for (const player of RoomsModule.getPlayersForClient(rooms, client)) {
            if (!cs.knownPlayers.has(player.id)) continue;

            const room = RoomsModule.getRoom(rooms, player.roomId);
            if (!room) continue;

            const nodeKnowledge = cs.nodeKnowledge.get(player.id);
            if (!nodeKnowledge) continue;
            const nodeSyncKnowledge = cs.nodeSyncKnowledge.get(player.id);
            if (!nodeSyncKnowledge) continue;

            // undefined (edit players, non-voxel rooms) means no region gating, all replicable nodes visible.
            const playerNode = room.playerNodes.get(player.id);
            const presence = player.mode === 'play' && room.voxels.authority ? cs.entityPresence.get(player.id) : undefined;
            if (presence) {
                flushEntityPresenceForPlayer(room, player, presence, resolveStreamRadius(playerNode));
            }
            const ownRootId = presence ? playerNode?.id : undefined;

            const updates = buildSceneSyncUpdates(
                room.scene,
                nodeKnowledge,
                nodeSyncKnowledge,
                room.tick,
                player.mode,
                player.id,
                presence,
                ownRootId,
            );
            if (updates.length > 0) {
                out.push([
                    client,
                    {
                        type: 'scene_sync',
                        playerId: player.id,
                        updates,
                    },
                ]);
            }
        }

        if (cs.roomListVersion !== state.roomListVersion) {
            cs.roomListVersion = state.roomListVersion;
            out.push([
                client,
                {
                    type: 'room_list',
                    rooms: buildRoomListJson(),
                },
            ]);
        }
    }

    // cleared here since both the voxel reconcile and the scene fan-out read replication.dirty; throttled fields carry over in nodeSyncKnowledge.
    for (const room of rooms.rooms.values()) clearDirtyNodes(room.scene);

    Debug.end(profiler, 'discovery/scene');

    return out;
}

/** tree depth of a node (root = 0); emitting creates depth-ascending guarantees a parent's `node_created` precedes its child's. */
function nodeDepth(node: Node): number {
    let d = 0;
    let p = node.parent;
    while (p) {
        d++;
        p = p.parent;
    }
    return d;
}

/** the transform root gating `node`'s AOI presence: the topmost `TransformTrait` node in its chain, or null if none (always visible). */
function transformRootOf(node: Node): Node | null {
    let cur: Node | null = node;
    let root: Node | null = null;
    while (cur) {
        if (hasTrait(cur, TransformTrait)) root = cur;
        cur = cur.parent;
    }
    return root;
}

/** builds incremental SceneSync updates for one client's knowledge of one room, driven by the room's per-tick dirty set, not a whole-tree walk. */
function buildSceneSyncUpdates(
    sceneTree: SceneTree,
    nodeKnowledge: Map<number, ClientNodeKnowledge>,
    nodeSyncKnowledge: Set<Node>,
    currentTick: number,
    mode: RoomMode,
    playerId: PlayerId,
    presence: ClientEntityPresence | undefined,
    ownRootId: number | undefined,
): SceneSyncUpdate[] {
    // field updates flow nearly every tick, so this one is worth allocating eagerly; the rest stay null until something needs them.
    const updateList: SceneSyncUpdate[] = [];
    let creates: Set<Node> | null = null;
    let destroys: SceneSyncUpdate[] | null = null;
    // node ids whose presence the AOI pass already settled this tick, so the replication.dirty loop skips them.
    const presenceSettled = new Set<number>();

    // subtree-coherent create/destroy for a transform root: a bulk-in static subtree has descendants not individually in replication.dirty.
    const createSubtree = (root: Node): void => {
        walkReplicable(root, mode, 'shared', (n) => {
            // only settle nodes we actually create; an already-known node may carry a pending field update, left for the diff path.
            if (!nodeKnowledge.has(n.id)) {
                (creates ??= new Set()).add(n);
                presenceSettled.add(n.id);
            }
        });
    };
    const destroySubtree = (root: Node): void => {
        walkReplicable(root, mode, 'shared', (n) => {
            if (nodeKnowledge.has(n.id)) {
                (destroys ??= []).push({ type: 'node_destroyed', id: n.id });
                nodeKnowledge.delete(n.id);
                nodeSyncKnowledge.delete(n);
            }
            presenceSettled.add(n.id);
        });
    };

    // AOI presence pass: a transform root's presence flips when the player's region membership or the root itself moved.
    if (presence && (presence.left.size > 0 || presence.entered.size > 0 || sceneTree.regions.rootRegionChanges.length > 0)) {
        const candidates = new Set<Node>();
        for (const key of presence.left) {
            const roots = rootsInRegion(sceneTree, key);
            if (roots) for (const r of roots) candidates.add(r);
        }
        for (const key of presence.entered) {
            const roots = rootsInRegion(sceneTree, key);
            if (roots) for (const r of roots) candidates.add(r);
        }
        for (const ch of sceneTree.regions.rootRegionChanges) candidates.add(ch.root);

        for (const root of candidates) {
            // the own-player subtree is the always-visible anchor, never region-gated.
            if (root.id === ownRootId || root.scene === null) continue;
            const filed = sceneTree.regions.rootToRegion.get(root); // undefined if unfiled
            const want = filed !== undefined && presence.knownRegions.has(filed);
            const have = nodeKnowledge.has(root.id);
            if (want && !have) createSubtree(root);
            else if (!want && have) destroySubtree(root);
        }
    }

    // replication.dirty: field updates for present nodes, incremental adds, destruction, and realm-gated create/destroy.
    for (const node of sceneTree.replication.dirty) {
        if (presenceSettled.has(node.id)) continue; // AOI pass already created/destroyed it
        const known = nodeKnowledge.get(node.id);

        // detached at flush = destroyed this tick (destroyed-then-re-added the same tick has node.scene set).
        if (node.scene === null) {
            if (known) {
                (destroys ??= []).push({ type: 'node_destroyed', id: node.id });
                nodeKnowledge.delete(node.id);
                nodeSyncKnowledge.delete(node);
            }
            continue;
        }

        // a present (known) node changed; realm relevance still gates here since a known node flipped to non-shared must be destroyed.
        if (known) {
            if (mode === 'edit' || isReplicable(node)) {
                diffNodeStructure(node, known, updateList, mode);
                diffNodeTraits(node, known, updateList, currentTick, playerId, nodeSyncKnowledge);
            } else {
                (destroys ??= []).push({ type: 'node_destroyed', id: node.id });
                nodeKnowledge.delete(node.id);
                nodeSyncKnowledge.delete(node);
            }
            continue;
        }

        // not known: decide creation. edit sees everything; play needs replicable.
        if (mode === 'edit') {
            (creates ??= new Set()).add(node);
            continue;
        }
        if (!isReplicable(node)) continue;
        // no transform root (or a non-voxel room) means not region-gated, always visible.
        const root = presence ? transformRootOf(node) : null;
        if (root === null) {
            (creates ??= new Set()).add(node);
            continue;
        }
        // createSubtree only walks not-yet-known nodes, so an incremental add under a present root emits just the new nodes.
        const filed = sceneTree.regions.rootToRegion.get(root);
        if (root.id === ownRootId || (filed !== undefined && presence!.knownRegions.has(filed))) createSubtree(root);
    }

    // carry-over: nodes still owing a rate-throttled sync() field; snapshot first, since the retry mutates the set as it drains.
    _pendingSyncScratch.length = 0;
    for (const node of nodeSyncKnowledge) _pendingSyncScratch.push(node);
    for (const node of _pendingSyncScratch) {
        // a still-moving source is dirty again this tick and was already handled above.
        if (sceneTree.replication.dirty.has(node)) continue;
        if (node.scene === null) {
            nodeSyncKnowledge.delete(node);
            continue;
        }
        const known = nodeKnowledge.get(node.id);
        if (!known || !(mode === 'edit' || isReplicable(node))) {
            nodeSyncKnowledge.delete(node);
            continue;
        }
        // not in replication.dirty, so only the rate gate's timing changed; fields only.
        retryPendingFields(node, known, updateList, currentTick, playerId, nodeSyncKnowledge);
    }
    _pendingSyncScratch.length = 0; // don't retain nodes between flushes

    // steady state: nothing entered this client's view, so hand back the field-update list rather than copying it.
    if (creates === null) {
        if (destroys !== null) for (let i = 0; i < destroys.length; i++) updateList.push(destroys[i]!);
        return updateList;
    }

    // assemble parent-first: creates, then updates, then destroys.
    const updates: SceneSyncUpdate[] = [];
    const createArr = [...creates];
    if (createArr.length > 1) createArr.sort((a, b) => nodeDepth(a) - nodeDepth(b));
    for (const node of createArr) {
        updates.push(buildNodeCreatedUpdate(node, mode));
        snapshotNodeKnowledge(nodeKnowledge, node, currentTick);
    }
    for (let i = 0; i < updateList.length; i++) updates.push(updateList[i]!);
    if (destroys !== null) for (let i = 0; i < destroys.length; i++) updates.push(destroys[i]!);
    return updates;
}

/** walks a node tree pre-order, pruning subtrees whose effective realm isn't 'shared' in play mode; iterative, no recursion. */
function walkReplicable(
    node: Node,
    mode: RoomMode,
    inheritedRealm: Realm,
    callback: (node: Node) => void,
    prune?: (node: Node) => boolean,
): void {
    const stack: Array<{ node: Node; inherited: Realm }> = [{ node, inherited: inheritedRealm }];
    while (stack.length > 0) {
        const { node: cur, inherited } = stack.pop()!;
        const effective = cur.realm === 'inherit' ? inherited : cur.realm;
        if (mode === 'play' && effective !== 'shared') continue;
        if (prune?.(cur)) continue;
        callback(cur);
        // push children in reverse so they pop in original order
        for (let i = cur.children.length - 1; i >= 0; i--) {
            stack.push({ node: cur.children[i], inherited: effective });
        }
    }
}

/** reads all controls for a trait as control-shaped BinaryField entries, for full-state events; packs fresh, controls aren't snapshotted. */
function readAllFields(node: Node, traitSlot: number, instance: TraitBase): BinaryField[] {
    const handle = registry.slotToTrait[traitSlot];
    if (!handle) return [];

    const codecs = getControlCodecs(handle);
    if (!codecs) return [];

    const entries: BinaryField[] = [];
    for (let i = 0; i < codecs.length; i++) {
        entries.push({ index: i, data: codecs[i].pack(instance, node) });
    }
    return entries;
}

/** reads all sync slices for a trait as sync-shaped BinaryField entries, to seed initial replicated state on the receiver. */
function readAllSyncs(node: Node, traitSlot: number, instance: TraitBase): BinaryField[] {
    const handle = registry.slotToTrait[traitSlot];
    if (!handle) return [];

    const codecs = getSyncCodecs(handle);
    if (!codecs) return [];

    const entries: BinaryField[] = [];
    for (let i = 0; i < codecs.length; i++) {
        entries.push({ index: i, data: codecs[i].pack(instance, node) });
    }
    return entries;
}

/** emits one trait's changed fields as a `node_trait_fields` update, applying per-field rate gating; returns whether the gate held anything back. */
function emitChangedFields(
    node: Node,
    instance: TraitBase,
    known: TraitKnowledge,
    handle: TraitHandle,
    updates: SceneSyncUpdate[],
    currentTick: number,
    playerId: PlayerId,
): boolean {
    // cleared before the early returns: a trait that can't ship anything owes nothing.
    known.behind = false;

    const codecs = getSyncCodecs(handle);
    if (!codecs) return false;

    const sync = instance._sync;
    // stays null while nothing has changed, the overwhelmingly common case.
    let entries: BinaryField[] | null = null;

    for (let i = 0; i < codecs.length; i++) {
        // current field version lives on the instance; known version is per-client.
        const fieldVersion = sync?.versions[i] ?? 0;
        const knownVersion = known.versions[i] ?? 0;

        if (fieldVersion <= knownVersion) continue;

        const syncDef = handle.def.sync[i];
        // never rate-gate an owner-authority field shipped to its own owner, or the owner would boot on its default and clobber the server value.
        const ownerHandoff = syncDef.authority === 'owner' && node.owner === playerId;
        const hz = typeof syncDef.rate === 'object' ? syncDef.rate.hz : null;
        // the first delivery of a dirty value is never rate-gated, only the cadence between repeated sends is.
        const lastSent = known.lastSentTicks[i] ?? NEVER_SENT;
        if (hz !== null && !ownerHandoff && lastSent !== NEVER_SENT) {
            if (!SyncRate.shouldSendThisTick(hz, lastSent, currentTick, SERVER_TICK_HZ)) {
                // held back this tick: the node stays pending so the field retries.
                known.behind = true;
                continue;
            }
        }

        // the diff snapshot holds the just-emitted bytes; fall back to a fresh pack if a slice changed without one.
        let data = sync?.bytes[i];
        if (!data) {
            data = codecs[i].pack(instance, node);
        }

        (entries ??= []).push({ index: i, data });
        known.versions[i] = fieldVersion;
        known.lastSentTicks[i] = currentTick;
    }

    if (entries !== null) {
        updates.push({ type: 'node_trait_fields', id: node.id, traitNetIndex: handle.netIndex!, fields: entries });
    }
    return known.behind;
}

/** reused snapshot of `nodeSyncKnowledge`, which the diff below mutates as it drains. */
const _pendingSyncScratch: Node[] = [];

/** build a NodeCreated update from a live node with per-field binary entries. */
function buildNodeCreatedUpdate(node: Node, mode: RoomMode): SceneSyncUpdate {
    const parentId = node.parent?.id ?? 0;
    const index = childIndexOf(node);

    const traits: BinaryTrait[] = [];
    const nodeTraits = node.traits;
    for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
        const instance = nodeTraits[traitSlot];
        if (instance === undefined) continue;
        const handle = registry.slotToTrait[traitSlot];
        if (!handle) continue;
        traits.push({
            netIndex: handle.netIndex,
            id: undefined,
            fields: readAllFields(node, traitSlot, instance),
            syncs: readAllSyncs(node, traitSlot, instance),
        });
    }
    // include unresolved traits (no wire-index entry, fall back to string id)
    for (const [id] of node.unresolved ?? EMPTY_UNRESOLVED) {
        traits.push({ netIndex: undefined, id, fields: [], syncs: [] });
    }

    return {
        type: 'node_created',
        id: node.id,
        name: node.name,
        parentId,
        index: Math.max(0, index),
        persist: node.persist ? undefined : false,
        owner: node.owner ?? undefined,
        traits,
        prefab: mode === 'edit' && node.prefab ? encodePrefabConfig(node.prefab) : undefined,
    };
}

/** emits everything about a node that is not a sync field: structure, name, owner, trait add/remove and prefab. */
function diffNodeStructure(node: Node, known: ClientNodeKnowledge, updates: SceneSyncUpdate[], mode: RoomMode): void {
    const parentId = node.parent?.id ?? 0;
    const childIndex = childIndexOf(node);
    if (known.parentId !== parentId || known.childIndex !== childIndex) {
        updates.push({
            type: 'node_structure',
            id: node.id,
            parentId,
            index: Math.max(0, childIndex),
        });
        known.parentId = parentId;
        known.childIndex = Math.max(0, childIndex);
    }

    if (known.name !== node.name) {
        updates.push({
            type: 'node_name',
            id: node.id,
            name: node.name,
        });
        known.name = node.name;
    }

    if (known.owner !== node.owner) {
        updates.push({
            type: 'node_owner',
            id: node.id,
            owner: node.owner ?? undefined,
        });
        known.owner = node.owner;
    }

    const nodeTraits = node.traits;

    // wire-compressed to the net index; the id is only sent for a trait that left the registry between snapshot and now (HMR edge).
    for (let traitSlot = 0; traitSlot < known.traits.length; traitSlot++) {
        const traitKnowledge = known.traits[traitSlot];
        if (traitKnowledge === undefined || nodeTraits[traitSlot] !== undefined) continue;
        const netIndex = registry.slotToTrait[traitSlot]?.netIndex;
        updates.push({
            type: 'node_trait_removed',
            id: node.id,
            traitNetIndex: netIndex,
            traitId: netIndex === undefined ? traitKnowledge.id : undefined,
        });
        known.traits[traitSlot] = undefined;
    }
    if (known.unresolvedTraits !== null) {
        for (const [traitId, traitKnowledge] of known.unresolvedTraits) {
            if (node.unresolved?.has(traitId) === true) continue;
            const netIndex = registry.protocol.traits.idToIndex.get(traitId);
            updates.push({
                type: 'node_trait_removed',
                id: node.id,
                traitNetIndex: netIndex,
                traitId: netIndex === undefined ? traitKnowledge.id : undefined,
            });
            known.unresolvedTraits.delete(traitId);
        }
    }

    if (mode === 'edit') {
        const currentPrefab = node.prefab ? encodePrefabConfig(node.prefab) : null;
        if (known.prefab !== currentPrefab) {
            updates.push({
                type: 'node_prefab',
                id: node.id,
                prefab: currentPrefab ?? undefined,
            });
            known.prefab = currentPrefab;
        }
    }
}

/** emits trait adds and changed sync fields for a node that changed this tick, in one walk of `node._traits`. */
function diffNodeTraits(
    node: Node,
    known: ClientNodeKnowledge,
    updates: SceneSyncUpdate[],
    currentTick: number,
    playerId: PlayerId,
    nodeSyncKnowledge: Set<Node>,
): void {
    let behind = false;
    const nodeTraits = node.traits;
    for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
        const instance = nodeTraits[traitSlot];
        if (instance === undefined) continue;
        const handle = registry.slotToTrait[traitSlot];
        if (!handle) continue;

        const traitKnowledge = known.traits[traitSlot];
        if (traitKnowledge === undefined) {
            // new to this client, ship full state, no rate gating.
            updates.push({
                type: 'node_trait_added',
                id: node.id,
                traitNetIndex: handle.netIndex,
                traitId: undefined,
                fields: readAllFields(node, traitSlot, instance),
                syncs: readAllSyncs(node, traitSlot, instance),
            });
            const len = handle.def.sync.length;
            const versions: number[] = [];
            const lastSentTicks: number[] = [];
            for (let i = 0; i < len; i++) {
                versions.push(instance._sync?.versions[i] ?? 0);
                lastSentTicks.push(currentTick);
            }
            known.traits[traitSlot] = { id: handle.id, behind: false, versions, lastSentTicks };
            continue;
        }

        if (emitChangedFields(node, instance, traitKnowledge, handle, updates, currentTick, playerId)) behind = true;
    }
    setPending(node, nodeSyncKnowledge, behind);
}

/** retries the fields a rate gate held back on a node that did not change this tick; walks the knowledge rather than the node. */
function retryPendingFields(
    node: Node,
    known: ClientNodeKnowledge,
    updates: SceneSyncUpdate[],
    currentTick: number,
    playerId: PlayerId,
    nodeSyncKnowledge: Set<Node>,
): void {
    let behind = false;
    const nodeTraits = node.traits;
    for (let traitSlot = 0; traitSlot < known.traits.length; traitSlot++) {
        const traitKnowledge = known.traits[traitSlot];
        if (traitKnowledge === undefined || !traitKnowledge.behind) continue;
        const instance = nodeTraits[traitSlot];
        if (instance === undefined) continue;
        const handle = registry.slotToTrait[traitSlot];
        if (!handle) continue;
        if (emitChangedFields(node, instance, traitKnowledge, handle, updates, currentTick, playerId)) behind = true;
    }
    setPending(node, nodeSyncKnowledge, behind);
}

/** parks the node while a field is still rate-throttled and drops it once current, so a settled source doesn't strand its last update. */
function setPending(node: Node, nodeSyncKnowledge: Set<Node>, behind: boolean): void {
    if (behind) nodeSyncKnowledge.add(node);
    else nodeSyncKnowledge.delete(node);
}

/** snapshot the current state of a node into a knowledge map. */
export function snapshotNodeKnowledge(nodeKnowledge: Map<number, ClientNodeKnowledge>, node: Node, currentTick = 0): void {
    const parentId = node.parent?.id ?? 0;
    const childIndex = childIndexOf(node);

    const traits: Array<TraitKnowledge | undefined> = [];
    let unresolvedTraits: Map<string, TraitKnowledge> | null = null;
    const nodeTraits = node.traits;
    for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
        const instance = nodeTraits[traitSlot];
        if (instance === undefined) continue;
        const handle = registry.slotToTrait[traitSlot];
        if (!handle) continue;

        // a field that never bumped wasn't in the create payload, so it hasn't shipped.
        const len = handle.def.sync.length;
        const versions: number[] = [];
        const lastSentTicks: number[] = [];
        for (let i = 0; i < len; i++) {
            const v = instance._sync?.versions[i] ?? 0;
            versions.push(v);
            lastSentTicks.push(v ? currentTick : NEVER_SENT);
        }

        traits[traitSlot] = { id: handle.id, behind: false, versions, lastSentTicks };
    }
    // include unresolved traits so the diff system knows we already sent them
    for (const id of node.unresolved?.keys() ?? []) {
        (unresolvedTraits ??= new Map()).set(id, { id, behind: false, versions: [], lastSentTicks: [] });
    }

    nodeKnowledge.set(node.id, {
        parentId,
        childIndex: Math.max(0, childIndex),
        name: node.name,
        owner: node.owner,
        realm: node.realm,
        traits,
        unresolvedTraits,
        prefab: node.prefab ? encodePrefabConfig(node.prefab) : null,
    });
}

/** snapshots every replicable node in the scene tree into a knowledge map; `prune` must match the one passed to `packSceneTree` at join. */
function snapshotAllNodeKnowledge(
    sceneTree: SceneTree,
    nodeKnowledge: Map<number, ClientNodeKnowledge>,
    mode: RoomMode,
    prune?: (node: Node) => boolean,
): void {
    // include root: it's sent as part of the packed scene at join_room, so it must be marked known.
    walkReplicable(
        sceneTree.root,
        mode,
        'shared',
        (node) => {
            snapshotNodeKnowledge(nodeKnowledge, node);
        },
        prune,
    );
}

// voxel chunk streaming: tracks per-client voxel knowledge and produces chunk_full / chunk_ops / chunk_light / chunk_del messages each
// tick, at REGION granularity (see voxels.ts). regions expand spherically, closest first; only the actual ship (dispatchRegionFull) is
// rate-limited, by each client's self-reported decode rate. a newly-discovered region ships as one voxel_region_full: a presence bitmask
// plus a dense list of only the occupied chunks' payloads. ops are coalesced (dedup by voxel index); too many ops in an already-known
// chunk promote to an individual voxel_chunk_full re-send on its own fixed-rate channel.

/** default (and seed value before any ack has landed) for a client's voxel_region_full budget per tick. */
const DEFAULT_REGIONS_PER_TICK = 1;

/** max regions in flight (shipped as voxel_region_full, awaiting voxel_ack) per client. */
const MAX_IN_FLIGHT_REGIONS = 4;

/** max voxel_chunk_full messages per client per tick for the promotion channel; fixed, not adaptive. */
const FULL_CHUNKS_PER_CLIENT_PER_TICK = 6;

/** max promotion chunks in flight per client, same backpressure idea as MAX_IN_FLIGHT_REGIONS scoped to the promotion channel. */
const MAX_IN_FLIGHT_FULL = 24;

/** fallback stream radius in chunks when the player node has no PlayerTrait; also the floor, a client can request more but not less. */
const DEFAULT_VIEW_RADIUS = 8;

/** clamp bounds (chunks) for the client-requested stream radius (PlayerTrait.viewRadius, owner-authoritative). */
const MIN_STREAM_RADIUS = 8;
const MAX_STREAM_RADIUS = 24;

/** resolves a player's clamped voxel stream radius from its owner-authoritative `PlayerTrait.viewRadius`. */
function resolveStreamRadius(playerNode: Node | undefined): number {
    const playerTrait = playerNode ? getTrait(playerNode, PlayerTrait) : null;
    const requestedRadius = playerTrait?.viewRadius ?? DEFAULT_VIEW_RADIUS;
    return Math.max(MIN_STREAM_RADIUS, Math.min(requestedRadius, MAX_STREAM_RADIUS));
}

/** hysteresis band (chunks) added to the stream radius to compute the eviction radius, preventing thrash at the load frontier. */
const RETENTION_MARGIN = 6;

/** if a chunk has more ops than this, promote to chunk_full re-send. */
const PROMOTION_THRESHOLD = CHUNK_VOLUME / 2;

/** max voxel_chunk_light chunks per client per tick, drained by the room-level dispatch. */
const LIGHT_CHUNKS_PER_CLIENT_PER_TICK = 8;

/** if a chunk has at most this many dirty light voxels, send a per-voxel delta instead of the compressed whole-chunk light. */
const LIGHT_DELTA_THRESHOLD = 100;

/** virtual "max users" in the global light cap formula: globalCap = (currentPlayers + ROOM_MAX_USERS) * per_client_cap / 4 + 1. */
const ROOM_MAX_USERS = 8;

/** called on hot reload, resets all voxel + entity-presence knowledge so chunks and transform-root subtrees re-stream. */
export function resetAllVoxelKnowledge(state: Discovery): void {
    for (const cs of state.clients.values()) {
        for (const k of cs.voxelKnowledge.values()) {
            k.knownChunks.clear();
            k.knownEmptyChunks.clear();
            k.knownRegions.clear();
            k.knownLightEpoch = 0;
            k.lastAnchorRegion = null;
            k.pendingRegions.clear();
            k.inFlightRegions.clear();
            k.pendingLight.clear();
            k.pendingFull.clear();
            k.inFlightFull.clear();
        }
        for (const p of cs.entityPresence.values()) {
            p.knownRegions.clear();
            p.lastAnchorRegion = null;
            p.entered.clear();
            p.left.clear();
        }
    }
}

/** clamp bounds for the client-reported adaptive region rate; the ceiling matches MAX_IN_FLIGHT_REGIONS. */
const MIN_ADAPTIVE_REGION_CAP = 1;
const MAX_ADAPTIVE_REGION_CAP = MAX_IN_FLIGHT_REGIONS;

/** applies a client's voxel_ack: frees in-flight slots for decoded regions/chunks, and adopts its reported adaptive pacing rate. */
export function handleVoxelAck(state: Discovery, client: Client, message: VoxelAck): void {
    const cs = state.clients.get(client);
    if (!cs) return;
    const knowledge = cs.voxelKnowledge.get(message.playerId);
    if (!knowledge) return;
    for (const c of message.full) {
        knowledge.inFlightFull.delete(chunkKey(c.cx, c.cy, c.cz));
    }
    for (const r of message.regions) {
        knowledge.inFlightRegions.delete(regionKey(r.rx, r.ry, r.rz));
    }
    if (message.regions.length > 0) {
        knowledge.maxInFlightRegions = MAX_IN_FLIGHT_REGIONS;
    }
    if (Number.isFinite(message.desiredRegionsPerTick)) {
        knowledge.fullRegionsPerTick = Math.min(
            MAX_ADAPTIVE_REGION_CAP,
            Math.max(MIN_ADAPTIVE_REGION_CAP, Math.round(message.desiredRegionsPerTick)),
        );
    }
}

/** get or build the compressed snapshot for a chunk, caching on the chunk. */
function getCompressedSnapshot(chunk: Chunk, zstd: Zstd): { compressed: Uint8Array; palette: number[] } {
    if (chunk.compressedSnapshot && chunk.snapshotPalette) {
        return { compressed: chunk.compressedSnapshot, palette: chunk.snapshotPalette };
    }
    const compressed = encodeChunk(chunk.data, chunk.light, zstd);
    const palette = chunk.palette.slice();
    chunk.compressedSnapshot = compressed;
    chunk.snapshotPalette = palette;
    return { compressed, palette };
}

/** get or build the compressed light streams for a chunk (sky + rgb channels, RLE'd then deflated), caching on the chunk. */
function getCompressedLight(chunk: Chunk): { sky: Uint8Array; rgb: Uint8Array } {
    if (chunk.compressedLight) return chunk.compressedLight;
    const compressed = encodeLight(chunk.light);
    chunk.compressedLight = compressed;
    return compressed;
}

type CoalescedBlockChunk = {
    cx: number;
    cy: number;
    cz: number;
    // slot -> global state id; by reference, the live palette is append-only so this stays stable through the tick.
    palette: number[];
    changes: Map<number, number>; // index -> local slot (last wins)
};

/** coalesce block ops by chunk, dedup by voxel index (keep last value). */
function coalesceBlockOps(
    ops: VoxelChanges['ops'],
    knownChunks: Map<string, ChunkCoord>,
    chunks: Map<string, Chunk>,
): Map<string, CoalescedBlockChunk> {
    const result = new Map<string, CoalescedBlockChunk>();
    for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!;
        if (op.kind !== 0) continue;
        const key = chunkKey(op.cx, op.cy, op.cz);
        if (!knownChunks.has(key)) continue;
        let entry = result.get(key);
        if (!entry) {
            const chunk = chunks.get(key);
            if (!chunk) continue;
            entry = {
                cx: op.cx,
                cy: op.cy,
                cz: op.cz,
                palette: chunk.palette,
                changes: new Map(),
            };
            result.set(key, entry);
        }
        entry.changes.set(op.index, (op as VoxelBlockOp).data);
    }
    return result;
}

/** Chunk coordinate of a Player's body, used as the streaming anchor. */
function getPlayerChunkCoord(room: Room, playerId: PlayerId): [number, number, number] {
    const node = room.playerNodes.get(playerId);
    if (!node) return [0, 0, 0];

    const t = getTrait(node, TransformTrait);
    if (!t) return [0, 0, 0];

    const pos = getWorldPosition(t);
    return [toChunkCoord(Math.floor(pos[0])), toChunkCoord(Math.floor(pos[1])), toChunkCoord(Math.floor(pos[2]))];
}

/** recomputes `presence.knownRegions` from scratch when the player's anchor crossed into a new region, no-op otherwise; unlike voxel streaming this has no per-tick budget since it's a pure membership test. */
function flushEntityPresenceForPlayer(room: Room, player: Player, presence: ClientEntityPresence, streamRadius: number): void {
    presence.entered.clear();
    presence.left.clear();

    const [pcx, pcy, pcz] = getPlayerChunkCoord(room, player.id);
    const rx = chunkToRegionCoord(pcx);
    const ry = chunkToRegionCoord(pcy);
    const rz = chunkToRegionCoord(pcz);

    if (
        presence.lastAnchorRegion !== null &&
        presence.lastAnchorRegion[0] === rx &&
        presence.lastAnchorRegion[1] === ry &&
        presence.lastAnchorRegion[2] === rz
    ) {
        return; // still in the same region, knownRegions is unchanged
    }
    presence.lastAnchorRegion = [rx, ry, rz];

    const radius = Math.ceil((streamRadius + RETENTION_MARGIN) / REGION_CHUNKS_PER_AXIS);
    const r2 = radius * radius;
    const next = new Set<string>();
    for (let dz = -radius; dz <= radius; dz++) {
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                if (dx * dx + dy * dy + dz * dz > r2) continue;
                const key = regionKey(rx + dx, ry + dy, rz + dz);
                next.add(key);
                if (!presence.knownRegions.has(key)) presence.entered.add(key);
            }
        }
    }
    for (const key of presence.knownRegions) {
        if (!next.has(key)) presence.left.add(key);
    }
    presence.knownRegions = next;
}

/** produces voxel messages for every Player in a room; each Player has its own streaming anchor and chunk-knowledge set. */
function flushVoxelsForRoom(state: Discovery, rooms: Rooms, room: Room, out: Array<[Client, ServerMessage]>): void {
    const voxels = room.voxels;
    const auth = voxels.authority;
    if (!auth) return;
    const changes = auth.changes;

    // per-player phase: discovery/eviction and ops absorb into pending sets; nothing ships yet, dispatch happens room-wide below.
    const players: Player[] = [];
    for (const player of RoomsModule.getPlayersInRoom(rooms, room)) {
        const cs = state.clients.get(player.client);
        if (!cs) continue;

        let knowledge = cs.voxelKnowledge.get(player.id);
        if (!knowledge) {
            knowledge = {
                knownChunks: new Map(),
                knownEmptyChunks: new Map(),
                knownRegions: new Map(),
                knownLightEpoch: 0,
                lastAnchorRegion: null,
                pendingRegions: new Map(),
                inFlightRegions: new Set(),
                maxInFlightRegions: 1,
                fullRegionsPerTick: DEFAULT_REGIONS_PER_TICK,
                pendingLight: new Set(),
                pendingFull: new Set(),
                inFlightFull: new Set(),
            };
            cs.voxelKnowledge.set(player.id, knowledge);
        }

        flushVoxelsForPlayer(room, voxels, changes, player, knowledge, out);
        players.push(player);
    }

    // dispatchRegionFull and dispatchFull run before dispatchLight and return the chunks they shipped, whose payloads carry fresh light.
    const regionShippedChunks = dispatchRegionFull(state, room, voxels, players, out);
    const fullShippedChunks = dispatchFull(state, room, voxels, players, out);
    for (const chunk of regionShippedChunks) fullShippedChunks.add(chunk);
    dispatchLight(state, room, voxels, players, out, fullShippedChunks);
}

type DispatchCandidate = { d2: number; key: string; pid: PlayerId; chunk: Chunk };

/** shared room-wide priority dispatch: each player's `selectPending` queue is gathered into one candidate list, shipped nearest-first under a per-client cap plus a global cap. */
function dispatchChannel(
    state: Discovery,
    room: Room,
    voxels: Voxels,
    players: Player[],
    perClientCap: number,
    selectPending: (k: ClientVoxelKnowledge) => Set<string>,
    ship: (c: DispatchCandidate, knowledge: ClientVoxelKnowledge, client: Client) => void,
    // optional in-flight window: skip a client once this many chunks are outstanding.
    inFlight?: { max: number; select: (k: ClientVoxelKnowledge) => Set<string> },
): Set<Chunk> {
    const candidates: DispatchCandidate[] = [];
    const knowledgeByPid = new Map<PlayerId, ClientVoxelKnowledge>();
    const clientByPid = new Map<PlayerId, Client>();

    for (const player of players) {
        const cs = state.clients.get(player.client);
        if (!cs) continue;
        const knowledge = cs.voxelKnowledge.get(player.id);
        if (!knowledge) continue;
        const pending = selectPending(knowledge);
        if (pending.size === 0) continue;
        knowledgeByPid.set(player.id, knowledge);
        clientByPid.set(player.id, player.client);

        const [pcx, pcy, pcz] = getPlayerChunkCoord(room, player.id);
        for (const key of pending) {
            const chunk = voxels.chunks.get(key);
            if (!chunk) {
                pending.delete(key); // deleted between queueing and dispatch
                continue;
            }
            const dx = chunk.cx - pcx;
            const dy = chunk.cy - pcy;
            const dz = chunk.cz - pcz;
            candidates.push({ d2: dx * dx + dy * dy + dz * dz, key, pid: player.id, chunk });
        }
    }

    const shipped = new Set<Chunk>();
    if (candidates.length === 0) return shipped;

    candidates.sort((a, b) => a.d2 - b.d2);

    const globalCap = Math.floor(((players.length + ROOM_MAX_USERS) * perClientCap) / 4) + 1;
    const perClientCount = new Map<PlayerId, number>();
    let totalSent = 0;

    for (const c of candidates) {
        if (totalSent >= globalCap) break;
        const sent = perClientCount.get(c.pid) ?? 0;
        if (sent >= perClientCap) continue;

        const knowledge = knowledgeByPid.get(c.pid)!;
        // the set grows as we ship this tick, so this check is live.
        if (inFlight && inFlight.select(knowledge).size >= inFlight.max) continue;

        ship(c, knowledge, clientByPid.get(c.pid)!);
        selectPending(knowledge).delete(c.key);
        shipped.add(c.chunk);
        perClientCount.set(c.pid, sent + 1);
        totalSent++;
    }

    return shipped;
}

/** room-wide chunk_full dispatch, the promotion channel only; drains each player's pendingFull nearest-first at a fixed, non-adaptive rate. */
function dispatchFull(
    state: Discovery,
    room: Room,
    voxels: Voxels,
    players: Player[],
    out: Array<[Client, ServerMessage]>,
): Set<Chunk> {
    return dispatchChannel(
        state,
        room,
        voxels,
        players,
        FULL_CHUNKS_PER_CLIENT_PER_TICK,
        (k) => k.pendingFull,
        (c, knowledge, client) => {
            const { compressed, palette } = getCompressedSnapshot(c.chunk, state.zstd);
            out.push([
                client,
                {
                    type: 'voxel_chunk_full',
                    playerId: c.pid,
                    cx: c.chunk.cx,
                    cy: c.chunk.cy,
                    cz: c.chunk.cz,
                    palette,
                    compressed,
                },
            ]);
            const coord = { cx: c.chunk.cx, cy: c.chunk.cy, cz: c.chunk.cz };
            knowledge.knownChunks.set(c.key, coord);
            fileKnownChunk(
                knowledge,
                chunkToRegionCoord(c.chunk.cx),
                chunkToRegionCoord(c.chunk.cy),
                chunkToRegionCoord(c.chunk.cz),
                c.key,
                coord,
            );
            knowledge.inFlightFull.add(c.key);
        },
        { max: MAX_IN_FLIGHT_FULL, select: (k) => k.inFlightFull },
    );
}

/** room-wide voxel_region_full dispatch, the discovery channel; a bespoke loop rather than dispatchChannel since a region candidate is an assembly of up to REGION_VOLUME chunks plus a bitmask, not one chunk lookup. */
function dispatchRegionFull(
    state: Discovery,
    room: Room,
    voxels: Voxels,
    players: Player[],
    out: Array<[Client, ServerMessage]>,
): Set<Chunk> {
    type RegionCandidate = { d2: number; key: string; pid: PlayerId; rx: number; ry: number; rz: number };

    const shipped = new Set<Chunk>();
    const candidates: RegionCandidate[] = [];
    const knowledgeByPid = new Map<PlayerId, ClientVoxelKnowledge>();
    const clientByPid = new Map<PlayerId, Client>();

    for (const player of players) {
        const cs = state.clients.get(player.client);
        if (!cs) continue;
        const knowledge = cs.voxelKnowledge.get(player.id);
        if (!knowledge) continue;
        if (knowledge.pendingRegions.size === 0) continue;
        knowledgeByPid.set(player.id, knowledge);
        clientByPid.set(player.id, player.client);

        const [pcx, pcy, pcz] = getPlayerChunkCoord(room, player.id);
        const prx = chunkToRegionCoord(pcx);
        const pry = chunkToRegionCoord(pcy);
        const prz = chunkToRegionCoord(pcz);
        for (const [key, { rx, ry, rz }] of knowledge.pendingRegions) {
            const dx = rx - prx;
            const dy = ry - pry;
            const dz = rz - prz;
            candidates.push({ d2: dx * dx + dy * dy + dz * dz, key, pid: player.id, rx, ry, rz });
        }
    }

    if (candidates.length === 0) return shipped;
    candidates.sort((a, b) => a.d2 - b.d2);

    const globalCap = Math.floor(((players.length + ROOM_MAX_USERS) * DEFAULT_REGIONS_PER_TICK) / 4) + 1;
    const perClientCount = new Map<PlayerId, number>();
    let totalSent = 0;

    for (const c of candidates) {
        if (totalSent >= globalCap) break;
        const knowledge = knowledgeByPid.get(c.pid)!;
        const sent = perClientCount.get(c.pid) ?? 0;
        if (sent >= knowledge.fullRegionsPerTick) continue;
        if (knowledge.inFlightRegions.size >= knowledge.maxInFlightRegions) continue;

        const bx = c.rx * REGION_CHUNKS_PER_AXIS;
        const by = c.ry * REGION_CHUNKS_PER_AXIS;
        const bz = c.rz * REGION_CHUNKS_PER_AXIS;
        const occupied: boolean[] = new Array(REGION_VOLUME);
        const chunks: Array<{ palette: number[]; compressed: Uint8Array }> = [];
        for (let i = 0; i < REGION_LOCAL_CHUNK_OFFSETS.length; i++) {
            const [lx, ly, lz] = REGION_LOCAL_CHUNK_OFFSETS[i]!;
            const cx = bx + lx;
            const cy = by + ly;
            const cz = bz + lz;
            const chunkK = chunkKey(cx, cy, cz);
            const chunk = voxels.chunks.get(chunkK);
            const coord = { cx, cy, cz };
            if (chunk) {
                occupied[i] = true;
                const { compressed, palette } = getCompressedSnapshot(chunk, state.zstd);
                chunks.push({ palette, compressed });
                knowledge.knownChunks.set(chunkK, coord);
                shipped.add(chunk);
            } else {
                occupied[i] = false;
                knowledge.knownEmptyChunks.set(chunkK, coord);
            }
            fileKnownChunk(knowledge, c.rx, c.ry, c.rz, chunkK, coord);
        }

        out.push([
            clientByPid.get(c.pid)!,
            { type: 'voxel_region_full', playerId: c.pid, rx: c.rx, ry: c.ry, rz: c.rz, occupied, chunks },
        ]);

        knowledge.pendingRegions.delete(c.key);
        knowledge.inFlightRegions.add(c.key);
        perClientCount.set(c.pid, sent + 1);
        totalSent++;
    }

    return shipped;
}

/** room-wide light dispatch: drains each player's pendingLight nearest-first, shipping a per-voxel delta when the dirty count is small, else whole-chunk light. */
function dispatchLight(
    state: Discovery,
    room: Room,
    voxels: Voxels,
    players: Player[],
    out: Array<[Client, ServerMessage]>,
    fullShippedChunks: Set<Chunk>,
): void {
    const shipped = dispatchChannel(
        state,
        room,
        voxels,
        players,
        LIGHT_CHUNKS_PER_CLIENT_PER_TICK,
        (k) => k.pendingLight,
        (c, _knowledge, client) => {
            const dirtyCount = c.chunk.lightDirtyCount;
            if (dirtyCount > 0 && dirtyCount <= LIGHT_DELTA_THRESHOLD) {
                // per-voxel delta: iterate set bits in the mask.
                const mask = c.chunk.lightDirtyMask;
                const light = c.chunk.light;
                const changes: Array<{ index: number; light: number }> = new Array(dirtyCount);
                let w = 0;
                for (let i = 0; i < mask.length && w < dirtyCount; i++) {
                    if (mask[i] !== 0) changes[w++] = { index: i, light: light[i]! };
                }
                out.push([
                    client,
                    { type: 'voxel_chunk_light_delta', playerId: c.pid, cx: c.chunk.cx, cy: c.chunk.cy, cz: c.chunk.cz, changes },
                ]);
            } else {
                const { sky, rgb } = getCompressedLight(c.chunk);
                out.push([
                    client,
                    { type: 'voxel_chunk_light', playerId: c.pid, cx: c.chunk.cx, cy: c.chunk.cy, cz: c.chunk.cz, sky, rgb },
                ]);
            }
        },
    );

    // deferred so two players queued for the same chunk both see the same dirtyCount.
    for (const chunk of shipped) {
        if (chunk.lightDirtyCount > 0) {
            chunk.lightDirtyMask.fill(0);
            chunk.lightDirtyCount = 0;
        }
    }
    for (const chunk of fullShippedChunks) {
        if (chunk.lightDirtyCount > 0) {
            chunk.lightDirtyMask.fill(0);
            chunk.lightDirtyCount = 0;
        }
    }
}

/** files/unfiles a chunk into `knowledge.knownRegions`'s per-region bucket; call alongside every knownChunks/knownEmptyChunks add/remove. */
function fileKnownChunk(
    knowledge: ClientVoxelKnowledge,
    rx: number,
    ry: number,
    rz: number,
    key: string,
    coord: ChunkCoord,
): void {
    const k = regionKey(rx, ry, rz);
    let region = knowledge.knownRegions.get(k);
    if (!region) {
        region = { rx, ry, rz, chunks: new Map() };
        knowledge.knownRegions.set(k, region);
    }
    region.chunks.set(key, coord);
}

function unfileKnownChunk(knowledge: ClientVoxelKnowledge, rx: number, ry: number, rz: number, key: string): void {
    const k = regionKey(rx, ry, rz);
    const region = knowledge.knownRegions.get(k);
    if (!region) return;
    region.chunks.delete(key);
    if (region.chunks.size === 0) knowledge.knownRegions.delete(k);
}

/** sweeps this player's known regions and evicts any outside the `evictRegionRadius` sphere, also dropping out-of-range pending entries. */
function evictOutOfRange(
    knowledge: ClientVoxelKnowledge,
    prx: number,
    pry: number,
    prz: number,
    evictRegionRadius: number,
    client: Client,
    playerId: PlayerId,
    out: Array<[Client, ServerMessage]>,
): void {
    const r2 = evictRegionRadius * evictRegionRadius;
    for (const [regionK, region] of [...knowledge.knownRegions]) {
        const dx = region.rx - prx;
        const dy = region.ry - pry;
        const dz = region.rz - prz;
        if (dx * dx + dy * dy + dz * dz <= r2) continue;

        out.push([client, { type: 'voxel_region_del', playerId, rx: region.rx, ry: region.ry, rz: region.rz }]);
        for (const [key] of region.chunks) {
            knowledge.knownChunks.delete(key);
            knowledge.knownEmptyChunks.delete(key);
            knowledge.pendingLight.delete(key);
            // a late ack for an evicted chunk then hits an unknown key and is ignored.
            knowledge.inFlightFull.delete(key);
        }
        knowledge.knownRegions.delete(regionK);
        knowledge.inFlightRegions.delete(regionK); // in case it just shipped and awaits ack
    }

    // pendingRegions entries haven't shipped yet: drop any that drifted out of range, no del needed.
    for (const [regionK, { rx, ry, rz }] of [...knowledge.pendingRegions]) {
        const dx = rx - prx;
        const dy = ry - pry;
        const dz = rz - prz;
        if (dx * dx + dy * dy + dz * dz <= r2) continue;
        knowledge.pendingRegions.delete(regionK);
    }

    // pendingFull entries are mid-resend, not fresh discovery; stays a flat scan, small enough that region-indexing isn't worth it.
    for (const key of knowledge.pendingFull) {
        const parts = key.split(',');
        const cx = Number.parseInt(parts[0]!, 10);
        const cy = Number.parseInt(parts[1]!, 10);
        const cz = Number.parseInt(parts[2]!, 10);
        const dx = chunkToRegionCoord(cx) - prx;
        const dy = chunkToRegionCoord(cy) - pry;
        const dz = chunkToRegionCoord(cz) - prz;
        if (dx * dx + dy * dy + dz * dz <= r2) continue;
        knowledge.pendingFull.delete(key);
    }
}

function flushVoxelsForPlayer(
    room: Room,
    voxels: Voxels,
    changes: VoxelChanges,
    player: Player,
    knowledge: ClientVoxelKnowledge,
    out: Array<[Client, ServerMessage]>,
): void {
    const client = player.client;

    // if the server did a full light recompute, reset client knowledge so every region re-ships with correct light.
    if (knowledge.knownLightEpoch < voxels.lighting.epoch) {
        knowledge.knownChunks.clear();
        knowledge.knownEmptyChunks.clear();
        knowledge.knownRegions.clear();
        knowledge.pendingRegions.clear();
        knowledge.inFlightRegions.clear();
        knowledge.pendingFull.clear();
        knowledge.inFlightFull.clear();
        knowledge.knownLightEpoch = voxels.lighting.epoch;
        knowledge.lastAnchorRegion = null;
    }

    const [pcx, pcy, pcz] = getPlayerChunkCoord(room, player.id);
    const prx = chunkToRegionCoord(pcx);
    const pry = chunkToRegionCoord(pcy);
    const prz = chunkToRegionCoord(pcz);
    const streamRadius = resolveStreamRadius(room.playerNodes.get(player.id));
    const regionRadius = Math.ceil(streamRadius / REGION_CHUNKS_PER_AXIS);

    // anchor cross: evict out-of-range regions, then an unbudgeted recompute of which regions are newly in range; only the ship is rate-limited.
    if (
        knowledge.lastAnchorRegion === null ||
        knowledge.lastAnchorRegion[0] !== prx ||
        knowledge.lastAnchorRegion[1] !== pry ||
        knowledge.lastAnchorRegion[2] !== prz
    ) {
        const evictRegionRadius = Math.ceil((streamRadius + RETENTION_MARGIN) / REGION_CHUNKS_PER_AXIS);
        evictOutOfRange(knowledge, prx, pry, prz, evictRegionRadius, client, player.id, out);
        knowledge.lastAnchorRegion = [prx, pry, prz];

        const r2 = regionRadius * regionRadius;
        for (let dz = -regionRadius; dz <= regionRadius; dz++) {
            for (let dy = -regionRadius; dy <= regionRadius; dy++) {
                for (let dx = -regionRadius; dx <= regionRadius; dx++) {
                    if (dx * dx + dy * dy + dz * dz > r2) continue;
                    const rx = prx + dx;
                    const ry = pry + dy;
                    const rz = prz + dz;
                    const regionK = regionKey(rx, ry, rz);
                    if (knowledge.pendingRegions.has(regionK)) continue;
                    const known = knowledge.knownRegions.get(regionK);
                    if (known && known.chunks.size === REGION_VOLUME) continue; // fully shipped already
                    knowledge.pendingRegions.set(regionK, { rx, ry, rz });
                }
            }
        }
    }

    // a chunk created this tick inside an already-shipped region patches via the promotion channel rather than re-shipping the region.
    if (changes.addedChunks.size > 0) {
        for (const chunk of changes.addedChunks) {
            const key = chunkKey(chunk.cx, chunk.cy, chunk.cz);
            if (knowledge.knownEmptyChunks.delete(key)) {
                unfileKnownChunk(
                    knowledge,
                    chunkToRegionCoord(chunk.cx),
                    chunkToRegionCoord(chunk.cy),
                    chunkToRegionCoord(chunk.cz),
                    key,
                );
                knowledge.pendingFull.add(key);
            }
        }
    }

    // block ops, coalesce and send for known chunks
    if (changes.ops.length > 0) {
        const blockChanges = coalesceBlockOps(changes.ops, knowledge.knownChunks, voxels.chunks);

        // promote chunks with too many block changes to a chunk_full re-send; the region stays filed, just one chunk mid-resend.
        for (const [key, entry] of blockChanges) {
            if (entry.changes.size > PROMOTION_THRESHOLD) {
                knowledge.knownChunks.delete(key);
                unfileKnownChunk(
                    knowledge,
                    chunkToRegionCoord(entry.cx),
                    chunkToRegionCoord(entry.cy),
                    chunkToRegionCoord(entry.cz),
                    key,
                );
                knowledge.pendingLight.delete(key);
                knowledge.inFlightFull.delete(key);
                knowledge.pendingFull.add(key);
                blockChanges.delete(key);
            }
        }

        if (blockChanges.size > 0) {
            const chunks: Array<{
                cx: number;
                cy: number;
                cz: number;
                changes: Array<{ index: number; stateId: number }>;
            }> = [];

            for (const entry of blockChanges.values()) {
                const changeList: Array<{ index: number; stateId: number }> = [];
                for (const [index, slot] of entry.changes) {
                    changeList.push({ index, stateId: entry.palette[slot]! });
                }
                chunks.push({
                    cx: entry.cx,
                    cy: entry.cy,
                    cz: entry.cz,
                    changes: changeList,
                });
            }

            out.push([
                client,
                {
                    type: 'voxel_chunk_ops',
                    playerId: player.id,
                    chunks,
                },
            ]);
        }
    }

    // absorb newly-dirty chunks into this client's pendingLight queue; the knownChunks guard skips chunks still in pendingFull.
    for (const chunk of voxels.dirty.light) {
        const key = chunkKey(chunk.cx, chunk.cy, chunk.cz);
        if (!knowledge.knownChunks.has(key)) continue;
        knowledge.pendingLight.add(key);
    }
}
