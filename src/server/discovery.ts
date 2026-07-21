import type { Client } from 'bongle/interface';
import { PlayerTrait } from '../builtins/player';
import { getWorldPosition, TransformTrait } from '../builtins/transform';
import type { PlayerId } from '../core/client';
import * as Debug from '../core/debug';
import type { BinaryField, BinaryTrait, RoomInfo, RoomMode, SceneSyncUpdate, ServerMessage, VoxelAck } from '../core/protocol';
import { registry } from '../core/registry';
import type { Resources } from '../core/resources';
import { getControlCodecs, getSyncCodecs } from '../core/scene/packcat-bridge';
import { packSceneTree } from '../core/scene/scene-pack';
import {
    bumpFieldVersion,
    encodePrefabConfig,
    getNodeById,
    getTrait,
    hasTrait,
    isReplicable,
    isTransformRoot,
    type Node,
    type Realm,
    reconcileRootChunks,
    rootsInChunk,
    type SceneTree,
} from '../core/scene/scene-tree';
import { diffSync, writeSnapshot } from '../core/scene/sync/sync-diff';
import * as SyncRate from '../core/scene/sync/sync-rate';
import type { TraitBase, TraitDef } from '../core/scene/traits';
import { encodeChunk, encodeLight, type Zstd } from '../core/voxels/chunk-codec';
import {
    CHUNK_VOLUME,
    type Chunk,
    chunkKey,
    clearVoxelChanges,
    toChunkCoord,
    type VoxelBlockOp,
    type VoxelChanges,
    type Voxels,
} from '../core/voxels/voxels';
import type { ServerNet } from './net';
import * as Net from './net';
import type { Player, Room, Rooms } from './rooms';
import * as RoomsModule from './rooms';

/* ── diff snapshots (change detection) ── */

/**
 * run diff detection on a scene tree: compare each trait's current sync values
 * against the per-instance snapshots (`instance._sync.bytes/values`), bumping
 * versions and updating the snapshot when a slice changed. diffs both property
 * and sync fields regardless of mode, scripts can mutate either at any time.
 *
 * per-slice state lives on the instance, so it's reaped with the node via GC,
 * no side-map to scan or clean up.
 *
 * call once per tick, after scripts have run.
 */
export function runDiffDetection(sceneTree: SceneTree): void {
    for (const node of sceneTree.nodes) {
        diffNode(sceneTree, node);
    }
}

function diffNode(sceneTree: SceneTree, node: Node): void {
    for (const [traitSlot, instance] of node._traits) {
        const def = registry.slotToTrait.get(traitSlot);
        if (!def) continue;

        const codecs = getSyncCodecs(def);
        if (!codecs) continue;

        const sync = instance._sync;
        if (!sync) continue;

        for (let i = 0; i < codecs.length; i++) {
            const codec = codecs[i];

            // dirty fast path: read+clear sync-dirty bits before byte-diffing.
            const word = i >> 5;
            const bit = 1 << (i & 31);
            if ((sync.dirty[word] & bit) !== 0) {
                sync.dirty[word] &= ~bit;
                // only 'explicit' slices emit purely on the dirty bit — that's their
                // contract (SyncHandle.dirty() is the sole change signal). 'diff'
                // and threshold slices consume the bit but still verify below, because
                // setPosition / physics set the bit unconditionally every tick (even
                // when the packed value is byte-identical), so trusting it here would
                // re-emit a resting entity at the tick rate.
                if (def.sync[i].dirty === 'explicit') {
                    writeSnapshot(codec, instance, node, i, sync);
                    bumpFieldVersion(sceneTree, node, instance, i);
                    continue;
                }
            }

            // 'explicit' dirtiness skips cold-path byte-diff entirely, only
            // SyncHandle.dirty() above can flag emission.
            if (def.sync[i].dirty === 'explicit') continue;

            // shared cold path: byte-diff or threshold metric. the server seeds
            // a first-seen slice silently (its initial version already covers it),
            // so emitOnFirstSeen = false.
            if (diffSync(codec, instance, node, i, sync, false)) {
                bumpFieldVersion(sceneTree, node, instance, i);
            }
        }
    }
}

/* ── per-client knowledge tracking ── */

type TraitKnowledge = {
    version: number;
    // Per-field knowledge as dense arrays indexed by sync field index (0..def.sync.length).
    // The trait is already selected by the enclosing `traits` map (keyed by def.id), so
    // the field only needs its index, no per-tick key to build. Sized + zero-filled once
    // when the trait knowledge is created (0 = never sent / unknown, matching the old
    // `?? 0` semantics).
    versions: number[];
    /** tick this field was last sent to this client (per-field rate gating). */
    lastSentTicks: number[];
};

// Build a zero-filled PACKED_SMI array. `new Array(n)` (even `.fill(0)`'d) stays
// HOLEY elements-kind forever, and a single holey `versions`/`lastSentTicks`
// array would make every `known.versions[i]` read polymorphic. Pushing from `[]`
// keeps them all PACKED so those hot reads stay monomorphic.
function zeros(n: number): number[] {
    const a: number[] = [];
    for (let i = 0; i < n; i++) a.push(0);
    return a;
}

type ClientNodeKnowledge = {
    nodeVersion: number;
    parentId: number;
    childIndex: number;
    name: string | undefined;
    owner: PlayerId | null;
    realm: Realm;
    traits: Map<string, TraitKnowledge>;
    /** json-encoded PrefabConfig, or null if no prefab */
    prefab: string | null;
};

/* ── per-client voxel knowledge ── */

type ClientVoxelKnowledge = {
    /** chunks sent as voxel_chunk_full and kept in sync with chunk_ops/light. */
    knownChunks: Set<string>;
    /** chunks announced as empty via voxel_chunk_empty, client holds an
     *  all-air stub so collision can distinguish "known air" from "unknown". */
    knownEmptyChunks: Set<string>;
    knownLightEpoch: number;
    /** player's chunk coord at the last flush. eviction runs only when this
     *  changes, so per-tick cost stays low at the edit-radius scale. null
     *  until the first flush. */
    lastAnchor: [number, number, number] | null;
    /** cursor into expansionOrder[viewRadius]. each tick we resume here and
     *  advance until the per-tick budget is filled. when the cursor reaches
     *  expansionOrder.length the sphere is fully discovered and per-tick cost
     *  drops to zero. reset to 0 on anchor cross and on addedChunks drain. */
    cursor: number;
    /** chunks whose light has changed but hasn't yet been shipped to this
     *  client. populated each tick from voxels.dirty.light (intersected with
     *  knownChunks). drained by the room-level dispatch with a global priority
     *  sort + per-client cap. survives across ticks so rate-limited skips
     *  ship on subsequent ticks rather than being lost. */
    pendingLight: Set<string>;
    /** occupied chunks discovered in-range but not yet shipped as
     *  voxel_chunk_full. the discovery walk populates this (bounded by
     *  DISCOVERY_BACKLOG_CAP); the room-level dispatchFull drains it with a
     *  global priority sort + per-client cap. a chunk becomes "known" only
     *  once dispatchFull actually ships it. survives across ticks. */
    pendingFull: Set<string>;
    /** chunks shipped as voxel_chunk_full but not yet acked by the client
     *  (voxel_ack). its size is the in-flight window: dispatchFull stops
     *  shipping to a client once it hits MAX_IN_FLIGHT_FULL, so a slow
     *  (decode-bound) client throttles the server. an ack removes the key,
     *  freeing a slot. disjoint from pendingFull (ship moves the key across)
     *  and a subset of knownChunks. pure pacing, TCP handles delivery. */
    inFlightFull: Set<string>;
    /** per-tick region deltas for chunk-tied node AOI: chunk keys that entered the
     *  discovered region this tick (announced empty, or shipped as chunk_full) and
     *  keys evicted this tick. cleared-then-filled each tick in flushVoxelsForPlayer;
     *  consumed by the scene phase (buildSceneSyncUpdates) to turn a chunk transition
     *  into subtree create/destroy for the transform roots filed in it. NOT touched by
     *  chunk_full promotion (a re-send is not an eviction), so a re-shipped chunk under
     *  a known node doesn't flicker it. */
    entered: Set<string>;
    left: Set<string>;
};

/* ── per-client scene graph knowledge ── */

type ClientState = {
    /**
     * per-Player, per-node knowledge. outer key is PlayerId, inner key is
     * node id. Mode-aware: an edit-Player tracks server-only and edit-only
     * nodes that a play-Player in the same room would not. A Player entry
     * exists once the client has received join_room for that Player.
     */
    nodeKnowledge: Map<PlayerId, Map<number, ClientNodeKnowledge>>;

    /**
     * per-Player set of node ids that still owe this client a `sync()` field — a
     * `rate.hz` field went dirty but its send was throttled and hasn't shipped yet.
     * (the field is what's pending; this indexes it by node, since the node is the
     * unit the fan-out revisits.) it carries no new truth — the field-level "behind"
     * already lives in `nodeKnowledge` (`TraitKnowledge.versions[i]` lags the
     * instance, so `ClientNodeKnowledge.nodeVersion` stays < `node._sync.version`).
     * it exists only so the fan-out can revisit those nodes without scanning every
     * known node: `dirtyNodes` carries what CHANGED this tick, not what a node that
     * has since SETTLED still owes. mirrors the voxel `pendingLight`/`pendingFull`
     * sets. an id lands here when a diff leaves the client behind and clears once it
     * catches up. key is PlayerId, same as `nodeKnowledge`. */
    nodeSyncKnowledge: Map<PlayerId, Set<number>>;

    /** Players that have received their join_room (and therefore have a
     *  populated nodeKnowledge entry). */
    knownPlayers: Set<PlayerId>;

    /** last room list version this client received (-1 = never). */
    roomListVersion: number;

    /**
     * per-Player voxel chunk knowledge. key is PlayerId. Each Player has
     * its own streaming anchor (its player node's chunk coord) and its own
     * known-chunks set, so views stay isolated, particularly important
     * when a client holds two Players in the same room (e.g. dev edit
     * camera + dev play character) whose positions diverge.
     */
    voxelKnowledge: Map<PlayerId, ClientVoxelKnowledge>;

    /**
     * Set of runtime-source model ids this client has been told about via
     * `register_model`. Drives a per-tick diff against
     * `resources.models`, new entries → `register_model`, vanished
     * entries → `unregister_model`. Bundled entries never enter this set;
     * they ship with the engine build on both sides.
     */
    knownModels: Set<string>;
};

/* ── discovery state ── */

/** a server→client RPC command queued for this tick. drained by
 *  `flushCommands` after scene distribution (see below). */
type QueuedCommand =
    | { kind: 'send'; client: Client; msg: ServerMessage }
    | { kind: 'broadcast'; roomId: string; msg: ServerMessage };

export type Discovery = {
    /** monotonic version bumped whenever the room list changes. */
    roomListVersion: number;

    /** per-client tracking. */
    clients: Map<Client, ClientState>;

    /** RPC commands emitted this tick, drained by `flushCommands` AFTER scene
     *  distribution so a command never beats this tick's scene state (join_room
     *  / scene_sync) onto a client's ordered socket. */
    commandQueue: QueuedCommand[];

    /** zstd impl for chunk_full snapshots, injected by the server entry (Node
     *  zstd, or zstd-wasm in the editor). kept off the codec so this
     *  browser-bundled module never imports node:zlib. */
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

/* ── RPC command ordering ──────────────────────────────────────────────
 * Server→client RPC commands are queued here (by the rpc driver) rather than
 * written straight to the outbox, then drained by `flushCommands` right after
 * the per-tick scene distribution. That makes "commands deliver after this
 * tick's scene state" a global invariant: a command sent from `onJoin` lands
 * after the joiner's `join_room`, so its listeners are already registered. */
export function queueCommand(state: Discovery, cmd: QueuedCommand): void {
    state.commandQueue.push(cmd);
}

export function flushCommands(state: Discovery, net: ServerNet, rooms: Rooms): void {
    // splice a snapshot so any command emitted while draining defers to the
    // next tick rather than mutating the array mid-iteration.
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

/* ── client lifecycle ── */

export function addClient(state: Discovery, client: Client): void {
    state.clients.set(client, {
        nodeKnowledge: new Map(),
        nodeSyncKnowledge: new Map(),
        knownPlayers: new Set(),
        roomListVersion: -1,
        voxelKnowledge: new Map(),
        knownModels: new Set(),
    });
}

export function removeClient(state: Discovery, client: Client): void {
    state.clients.delete(client);
}

/* ── invalidation ── */

export function invalidateRoomList(state: Discovery): void {
    state.roomListVersion++;
}

/**
 * Call when a Player is allocated (or its scene is structurally invalidated,
 * e.g. a hot-reload or scene rebuild). Synchronously emits a join_room
 * for this Player on the per-client outbox and re-snapshots per-Player
 * knowledge against current scene state. Initializes fresh voxel knowledge
 * for the Player so its chunk view streams from scratch.
 *
 * Synchronous emission means call order = wire order: a script doing
 * `Net.send(rpc1); addClientToRoom(...); Net.send(rpc2)` produces
 * `[rpc1, join_room, rpc2]` in the outbox. End-of-tick batching applies
 * only to scene_sync (which needs diff detection over the full tick).
 */
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
        knownChunks: new Set(),
        knownEmptyChunks: new Set(),
        knownLightEpoch: 0,
        lastAnchor: null,
        cursor: 0,
        pendingLight: new Set(),
        pendingFull: new Set(),
        inFlightFull: new Set(),
        entered: new Set(),
        left: new Set(),
    });

    // Catch this client up on any runtime model entries that exist now,
    // emit synchronously so they precede `join_room` on the outbox. The
    // packed scene may reference these modelIds via trait fields; the
    // client's `ensureModel` needs a URL entry in hand when it tries to
    // load. Mirrors the `wire_table` pattern above.
    for (const msg of computeModelRegistrations(cs, resources)) {
        Net.send(net, player.client, msg);
    }

    // AOI-aware join: when this player streams chunks, omit transform-root subtrees
    // from the packed scene (they're created later via the AOI presence pass as the
    // player's region discovers), EXCEPT the player's own node subtree, which is the
    // always-visible anchor. the SAME predicate feeds snapshotAllNodeKnowledge below so
    // the marked-known set is exactly the packed set.
    const ownPlayerNode = room.playerNodes.get(player.id);
    const transformRootPrune =
        player.mode === 'play' && room.voxels.authority
            ? (node: Node) => node !== ownPlayerNode && isTransformRoot(node)
            : undefined;

    const packT0 = performance.now();
    const packedNodes = packSceneTree(room.nodes, player.mode, transformRootPrune);
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

    // snapshot every node so the same-tick scene_sync diff finds no changes
    const snapT0 = performance.now();
    snapshotAllNodeKnowledge(room.nodes, nodeKnowledge, player.mode, transformRootPrune);
    const snapMs = performance.now() - snapT0;
    console.log(
        `[room-start]     invalidatePlayer packSceneTree=${packMs.toFixed(1)} ` +
            `snapshotNodes=${snapMs.toFixed(1)} packedBytes=${packedNodes.byteLength}`,
    );
}

/**
 * Call when a Player is removed. Synchronously emits room_left on the
 * per-client outbox and drops all per-Player knowledge (scene + voxel).
 * Caller must have already removed the Player from `state.players`.
 */
export function notifyPlayerLeft(state: Discovery, net: ServerNet, player: Player): void {
    const cs = state.clients.get(player.client);
    if (!cs) return;

    cs.nodeKnowledge.delete(player.id);
    cs.nodeSyncKnowledge.delete(player.id);
    cs.knownPlayers.delete(player.id);
    cs.voxelKnowledge.delete(player.id);

    Net.send(net, player.client, { type: 'room_left', playerId: player.id });
}

/* ── runtime model registration diff ── */

/**
 * Diff `resources.models` (runtime entries only) against this client's
 * `knownModels` set. Returns the messages to bring the client into sync;
 * mutates `knownModels` to match the new state so the caller doesn't have
 * to. Bundled entries are skipped, both sides ship them with their build.
 */
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

/* ── optimistic knowledge update ── */

/**
 * stamp the current node state into the originating client's knowledge
 * after a mutation. prevents discovery from echoing the change back.
 *
 * Stamps every Player the client holds in the room, the mutation came
 * from the client connection, so all of that client's views into the
 * room should suppress the echo.
 */
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

/**
 * remove the originating client's knowledge of a destroyed node.
 * prevents discovery from sending a redundant node_destroyed message.
 */
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

/**
 * accept owner-authority fields from the owning client. applies the value
 * to the trait instance, updates the diff snapshot (so diff detection won't
 * re-bump the version), and stamps the client's knowledge (so discovery
 * won't echo the value back). one holistic "accept field from client" op.
 */
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
    // play mode: only accept owner fields for replicable nodes. non-shared
    // nodes aren't synced to other clients, so an owner-authority write
    // would silently never reach anyone, reject loudly instead.
    if (mode === 'play' && !isReplicable(node)) return;

    const codecs = getSyncCodecs(def);
    if (!codecs) return;

    const sync = instance._sync;
    if (!sync) return;

    // collect every Player the client holds in this room, we stamp all of
    // their knowledge so none echo this owner-authority write back.
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

        // 1. apply value to the trait instance. codec.apply clears the
        //    sync-dirty bit so the next diffNode pass doesn't re-pack from
        //    the same write and double-bump.
        codec.apply(entry.data, instance);

        // 2. update the per-instance snapshot to the just-applied bytes so the
        //    byte-diff in diffNode sees no change and doesn't re-bump. reuse the
        //    shared scratch (in-place store) rather than allocating a fresh
        //    buffer per owner field, owner writes land every tick for
        //    player-controlled entities.
        writeSnapshot(codec, instance, node, i, sync);

        // 3. bump the field version once, here. broadcasts to non-owners
        //    via the per-client knowledge diff in buildSceneSyncUpdates;
        //    the owner is exempted by stamping their knowledge to the
        //    post-bump version below (step 4) so they don't echo it back.
        bumpFieldVersion(sceneTree, node, instance, i);

        // 4. stamp every Player the owner client holds in this room to the
        //    post-bump version so this owner-authority write doesn't echo
        //    back to the sender.
        if (!cs) continue;
        const fieldVersion = instance._sync?.versions[i] ?? 0;
        for (const player of targetPlayers) {
            const nodeKnowledge = cs.nodeKnowledge.get(player.id);
            const known = nodeKnowledge?.get(node.id);
            if (!known) continue;
            let traitKnowledge = known.traits.get(def.id);
            if (!traitKnowledge) {
                traitKnowledge = {
                    version: 0,
                    versions: zeros(def.sync.length),
                    lastSentTicks: zeros(def.sync.length),
                };
                known.traits.set(def.id, traitKnowledge);
            }
            // stamp the field version; lastSentTick stays as-is (0 if first seen).
            traitKnowledge.versions[i] = fieldVersion;
        }
    }
}

/* ── flush ── */

/**
 * produce pending messages for all clients. call once per tick, after
 * scripts have run. runs diff detection per room first (serialize once),
 * then distributes updates to clients based on per-client knowledge.
 *
 * returns a list of [client, message] pairs to be sent.
 */
export function flush(
    state: Discovery,
    rooms: Rooms,
    resources: Resources,
    metrics: Debug.Metrics,
): Array<[Client, ServerMessage]> {
    const out: Array<[Client, ServerMessage]> = [];

    // --- phase 1: diff detection (per-room, serialize once) ---
    Debug.begin(metrics, 'discovery/diff');
    for (const room of rooms.rooms.values()) {
        runDiffDetection(room.nodes);
    }
    Debug.end(metrics, 'discovery/diff');

    // --- phase 2: voxel chunk streaming + transform-root chunk-index reconcile ---
    // runs BEFORE the scene phase (approach B): chunk knowledge is the region
    // authority, so it must be current when scene sync gates node presence, and the
    // per-player entered/left region deltas captured here are consumed same-tick by
    // the scene phase below. (was phase 3, after scene.)
    Debug.begin(metrics, 'discovery/voxels');
    for (const room of rooms.rooms.values()) {
        // reconcile the transform-root chunk index off this tick's dirtyNodes so
        // rootsInChunk is current for the scene phase. runs for every room (even
        // ones without voxel authority); it's O(dirtyNodes) and touches nothing else.
        reconcileRootChunks(room.nodes);
        const auth = room.voxels.authority;
        if (!auth) continue;
        flushVoxelsForRoom(state, rooms, room, out);
        clearVoxelChanges(auth.changes);
        // clear lightDirty flags after all clients have absorbed into their
        // per-client pendingLight queues. compressedLight stays cached across
        // ticks, writeChunkLight / markChunkDirty (light.ts) null it on the
        // next actual change. dirty.light is reset so next tick starts empty.
        // mask + count are NOT cleared here, dispatchLight already cleared
        // them for shipped chunks; unshipped (cap-exhausted) chunks keep
        // their accumulated delta info for next tick.
        for (const chunk of room.voxels.dirty.light) {
            chunk.lightDirty = false;
        }
        room.voxels.dirty.light.clear();
    }
    Debug.end(metrics, 'discovery/voxels');

    // --- phase 3: per-client scene sync (consumes this tick's chunk region) ---
    Debug.begin(metrics, 'discovery/scene');

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
        // runtime model registrations, diff `resources.models` against
        // per-client knowledge. Push BEFORE scene_sync so any new trait
        // field carrying a freshly-registered modelId can resolve to a URL
        // entry on the client by the time the field lands.
        for (const msg of computeModelRegistrations(cs, resources)) {
            out.push([client, msg]);
        }

        // incremental scene sync, per-Player, mode-aware
        for (const player of RoomsModule.getPlayersForClient(rooms, client)) {
            if (!cs.knownPlayers.has(player.id)) continue;

            const room = RoomsModule.getRoom(rooms, player.roomId);
            if (!room) continue;

            const nodeKnowledge = cs.nodeKnowledge.get(player.id);
            if (!nodeKnowledge) continue;
            const nodeSyncKnowledge = cs.nodeSyncKnowledge.get(player.id);
            if (!nodeSyncKnowledge) continue;

            // AOI region for chunk-tied node presence: present only when the room
            // streams chunks. undefined → no chunk gating (all replicable nodes
            // visible, the pre-AOI behaviour) for edit players and non-voxel rooms.
            const aoi = player.mode === 'play' && room.voxels.authority ? cs.voxelKnowledge.get(player.id) : undefined;
            const ownRootId = aoi ? room.playerNodes.get(player.id)?.id : undefined;

            const updates = buildSceneSyncUpdates(
                room.nodes,
                nodeKnowledge,
                nodeSyncKnowledge,
                room.tick,
                player.mode,
                player.id,
                aoi,
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

        // room list
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

    // clear the per-room dirty set now that every client has diffed against it AND
    // this tick's reconcileRootChunks consumed it. cleared here (end of the scene
    // phase, which now runs LAST): the voxel phase's reconcile + the scene fan-out
    // both read dirtyNodes, so clearing any earlier would strand one of them. nodes
    // still owed after a rate-throttle are carried per-client in nodeSyncKnowledge.
    for (const room of rooms.rooms.values()) {
        if (room.nodes.dirtyNodes.size > 0) room.nodes.dirtyNodes.clear();
    }

    Debug.end(metrics, 'discovery/scene');

    return out;
}

/* ── scene sync generation ── */

/**
 * tree depth of a node (root = 0). used to emit creates parent-first: a parent's
 * depth is strictly less than its child's, so depth-ascending guarantees the
 * parent's `node_created` precedes the child's regardless of mutation order.
 */
function nodeDepth(node: Node): number {
    let d = 0;
    let p = node.parent;
    while (p) {
        d++;
        p = p.parent;
    }
    return d;
}

/* ── chunk-tied node AOI helpers ── */

/** the transform root gating `node`'s AOI presence: the topmost `TransformTrait`
 *  node in its chain, or null if no ancestor-or-self has a transform (a node with
 *  no transform root, always visible). only used on the cold create path for a
 *  not-yet-known node; movers never climb (the presence pass iterates roots). */
function transformRootOf(node: Node): Node | null {
    let cur: Node | null = node;
    let root: Node | null = null;
    while (cur) {
        if (hasTrait(cur, TransformTrait)) root = cur;
        cur = cur.parent;
    }
    return root;
}

/** is a chunk currently in this client's AOI region? `knownChunks ∪ knownEmptyChunks`
 *  is the shipped region; `pendingFull` is included so a chunk mid-(re)ship doesn't
 *  flicker a node whose presence is being re-evaluated. */
function chunkInRegion(aoi: ClientVoxelKnowledge, key: string): boolean {
    return aoi.knownChunks.has(key) || aoi.knownEmptyChunks.has(key) || aoi.pendingFull.has(key);
}

/**
 * build incremental SceneSync updates for a single client's knowledge of a single
 * room, driven by the room's per-tick dirty set (nodes touched this tick) PLUS this
 * client's `nodeSyncKnowledge` carry-over (nodes that still owe it a rate-throttled
 * sync() field but have since settled out of the dirty set), not a whole-tree walk.
 * per node, the same per-client diff decides create / update / destroy against this
 * client's knowledge (a destroyed node is a dirty node that's no longer live,
 * `node.scene === null`); the baseline for nodes that never change comes from the
 * join snapshot. reads pre-serialized trait bytes from each instance's `_sync.bytes`.
 *
 * assembled as: creates (parent-first by depth) → updates → destroys, so a
 * `node_structure` that points at a freshly-created parent finds it already sent,
 * and a child's `node_created` never precedes its parent's.
 */
function buildSceneSyncUpdates(
    sceneTree: SceneTree,
    nodeKnowledge: Map<number, ClientNodeKnowledge>,
    nodeSyncKnowledge: Set<number>,
    currentTick: number,
    mode: RoomMode,
    playerId: PlayerId,
    aoi: ClientVoxelKnowledge | undefined,
    ownRootId: number | undefined,
): SceneSyncUpdate[] {
    const creates = new Set<Node>();
    const updateList: SceneSyncUpdate[] = [];
    const destroys: SceneSyncUpdate[] = [];
    // node ids whose presence the AOI pass already settled (created or destroyed) this
    // tick, so the dirtyNodes loop skips them (it owns field updates, not presence).
    const presenceSettled = new Set<number>();

    // subtree-coherent create/destroy for a transform root: a bulk-in static subtree
    // has descendants that aren't individually in dirtyNodes, so we expand the whole
    // subtree at the root. walkReplicable prunes non-shared subtrees in play mode
    // (matching what was/would be created); the root's ancestry is all shared
    // (isTransformRoot ⇒ isReplicable), so 'shared' is the right inherited realm.
    const createSubtree = (root: Node): void => {
        walkReplicable(root, mode, 'shared', (n) => {
            // only settle nodes we actually create. an already-known node in this subtree
            // may carry a pending field update in dirtyNodes — leave it for the diff path.
            if (!nodeKnowledge.has(n.id)) {
                creates.add(n);
                presenceSettled.add(n.id);
            }
        });
    };
    const destroySubtree = (root: Node): void => {
        walkReplicable(root, mode, 'shared', (n) => {
            if (nodeKnowledge.has(n.id)) {
                destroys.push({ type: 'node_destroyed', id: n.id });
                nodeKnowledge.delete(n.id);
                nodeSyncKnowledge.delete(n.id);
            }
            presenceSettled.add(n.id);
        });
    };

    // --- AOI presence pass (play + voxel rooms) ---
    // presence of a transform root = its chunk ∈ region. it flips when EITHER the
    // region moved (this player's entered/left chunk deltas) OR the root moved/spawned/
    // despawned (the room's rootChunkChanges). we gather those candidate roots and, for
    // each, compare want (current filed chunk ∈ region) vs have (known) — iterating
    // ROOTS, so we never climb the tree. destruction of an actually-destroyed root
    // (scene === null) is left to the dirtyNodes loop; here we handle live AOI in/out.
    if (aoi) {
        const candidates = new Set<Node>();
        for (const key of aoi.left) {
            const roots = rootsInChunk(sceneTree, key);
            if (roots) for (const r of roots) candidates.add(r);
        }
        for (const key of aoi.entered) {
            const roots = rootsInChunk(sceneTree, key);
            if (roots) for (const r of roots) candidates.add(r);
        }
        for (const ch of sceneTree.rootChunkChanges) candidates.add(ch.root);

        for (const root of candidates) {
            // the own-player subtree is the always-visible anchor, never chunk-gated.
            if (root.id === ownRootId || root.scene === null) continue;
            const filed = sceneTree.rootToChunk.get(root); // current chunk, O(1); undefined if unfiled
            const want = filed !== undefined && chunkInRegion(aoi, filed);
            const have = nodeKnowledge.has(root.id);
            if (want && !have) createSubtree(root);
            else if (!want && have) destroySubtree(root);
            // want === have: no presence change; field updates flow through dirtyNodes.
        }
    }

    // --- dirtyNodes: field updates for present nodes, incremental adds, destruction,
    //     and (non-voxel / non-transform) realm-gated create/destroy ---
    for (const node of sceneTree.dirtyNodes) {
        if (presenceSettled.has(node.id)) continue; // AOI pass already created/destroyed it
        const known = nodeKnowledge.get(node.id);

        // detached at flush = destroyed this tick. (destroyed-then-re-added the same
        // tick is live here, node.scene set, so it flows to create/update below.)
        if (node.scene === null) {
            if (known) {
                destroys.push({ type: 'node_destroyed', id: node.id });
                nodeKnowledge.delete(node.id);
                nodeSyncKnowledge.delete(node.id);
            }
            continue;
        }

        // a present (known) node changed. no CHUNK re-check: a node that left its client's
        // region was already pulled from knowledge by the AOI presence pass, so if it's
        // still known here its chunk is still present (hot path for movers). but REALM
        // relevance is orthogonal to chunks and still gates here: a known node flipped to a
        // non-shared realm must be destroyed (a transform-root flip is caught by the
        // presence pass via reconcile unfiling it; this handles the rest, per-node).
        if (known) {
            if (mode === 'edit' || isReplicable(node)) {
                diffNodeKnowledge(sceneTree, node, known, updateList, mode, currentTick, playerId, nodeSyncKnowledge);
            } else {
                destroys.push({ type: 'node_destroyed', id: node.id });
                nodeKnowledge.delete(node.id);
                nodeSyncKnowledge.delete(node.id);
            }
            continue;
        }

        // not known → decide creation. edit sees everything; play needs replicable.
        if (mode === 'edit') {
            creates.add(node);
            continue;
        }
        if (!isReplicable(node)) continue;
        // a node with no transform root (or a non-voxel room) is not chunk-gated → visible.
        const root = aoi ? transformRootOf(node) : null;
        if (root === null) {
            creates.add(node);
            continue;
        }
        // a chunk-gated node became newly relevant (spawned, or added under a present
        // subtree): create from its root iff that root is in region — createSubtree walks
        // only the not-yet-known nodes, so an incremental add under a present root emits
        // just the new nodes, and a spawn out of region waits for the AOI pass.
        const filed = sceneTree.rootToChunk.get(root);
        if (root.id === ownRootId || (filed !== undefined && chunkInRegion(aoi!, filed))) createSubtree(root);
    }

    // carry-over: nodes that still owe this client a rate-throttled sync() field but
    // are NOT in dirtyNodes because their source settled. re-diff each to retry the
    // throttled field once its cadence allows; diffNodeKnowledge clears it from
    // nodeSyncKnowledge when the client catches up. these are already-known nodes, so
    // region membership is current (eviction/exit already removed them here). snapshot
    // first — the diff mutates the set. skip nodes already handled via dirtyNodes above.
    for (const nodeId of [...nodeSyncKnowledge]) {
        const node = getNodeById(sceneTree, nodeId);
        if (!node || node.scene === null || sceneTree.dirtyNodes.has(node)) continue;
        const known = nodeKnowledge.get(nodeId);
        if (!known || !(mode === 'edit' || isReplicable(node))) {
            nodeSyncKnowledge.delete(nodeId);
            continue;
        }
        diffNodeKnowledge(sceneTree, node, known, updateList, mode, currentTick, playerId, nodeSyncKnowledge);
    }

    // assemble parent-first creates → updates → destroys.
    const updates: SceneSyncUpdate[] = [];
    const createArr = [...creates];
    if (createArr.length > 1) createArr.sort((a, b) => nodeDepth(a) - nodeDepth(b));
    for (const node of createArr) {
        updates.push(buildNodeCreatedUpdate(node, mode));
        snapshotNodeKnowledge(nodeKnowledge, node, currentTick);
    }
    for (let i = 0; i < updateList.length; i++) updates.push(updateList[i]);
    for (let i = 0; i < destroys.length; i++) updates.push(destroys[i]);
    return updates;
}

/**
 * walk a node tree in parent-first (pre-order) order. in play mode prunes
 * subtrees whose effective realm isn't `'shared'`. `inheritedRealm` is the
 * effective realm of the parent (root callers pass `'shared'`); `'inherit'`
 * nodes resolve to that value. iterative, no recursion, no stack growth on
 * deep trees.
 */
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

/**
 * read all controls for a trait as control-shaped BinaryField entries.
 * used for full-state events (node_created, node_trait_added) where the
 * receiver wants every editable/persisted field, not just sync slices.
 * packs fresh, controls aren't snapshotted on the instance.
 */
function readAllFields(node: Node, traitSlot: number, instance: TraitBase): BinaryField[] {
    const def = registry.slotToTrait.get(traitSlot);
    if (!def) return [];

    const codecs = getControlCodecs(def);
    if (!codecs) return [];

    const entries: BinaryField[] = [];
    for (let i = 0; i < codecs.length; i++) {
        entries.push({ index: i, data: codecs[i].pack(instance, node) });
    }
    return entries;
}

/**
 * read all sync slices for a trait as sync-shaped BinaryField entries.
 * used for full-state events to seed initial replicated state on the
 * receiver, pairs with readAllFields (controls).
 */
function readAllSyncs(node: Node, traitSlot: number, instance: TraitBase): BinaryField[] {
    const def = registry.slotToTrait.get(traitSlot);
    if (!def) return [];

    const codecs = getSyncCodecs(def);
    if (!codecs) return [];

    const entries: BinaryField[] = [];
    for (let i = 0; i < codecs.length; i++) {
        entries.push({ index: i, data: codecs[i].pack(instance, node) });
    }
    return entries;
}

/**
 * read only fields that changed (version > known version) as BinaryField entries,
 * applying per-field rate gating. fields that are throttled are skipped.
 * sentFieldKeys is populated with the snapshot keys of fields that were included,
 * so callers can update per-field knowledge.
 */
function readChangedFields(
    node: Node,
    traitSlot: number,
    instance: TraitBase,
    known: TraitKnowledge,
    currentTick: number,
    sentFields: Array<{ index: number; version: number }>,
    playerId: PlayerId,
): BinaryField[] {
    const def = registry.slotToTrait.get(traitSlot);
    if (!def) return [];

    const codecs = getSyncCodecs(def);
    if (!codecs) return [];

    const sync = instance._sync;
    const entries: BinaryField[] = [];

    for (let i = 0; i < codecs.length; i++) {
        // current field version lives on the instance; known version is per-client.
        const fieldVersion = sync?.versions[i] ?? 0;
        const knownVersion = known.versions[i] ?? 0;

        if (fieldVersion <= knownVersion) continue;

        const syncDef = def.sync[i];
        // rate is the send-path cadence gate, orthogonal to dirtiness: this field is
        // already known-dirty (fieldVersion > knownVersion, gated above by its
        // `dirty` policy), and { hz } throttles how often that dirty value ships. a
        // dirty value blocked here stays version-ahead and retries next tick, so the
        // peer gets the LATEST value at the cadence, never a stale one. 'realtime'
        // (no `hz`) doesn't throttle.
        // never rate-gate an owner-authority field being shipped to its OWN owner:
        // that's an authoritative handoff the owner adopts and then uploads from
        // (e.g. the server-set spawn transform). throttle it and the owner can boot
        // on its default, upload that, and — being the authority — clobber the server
        // value permanently. rate is an observer-fanout cadence limiter, not for the
        // handoff. everyone else gets the { hz } throttle.
        const ownerHandoff = syncDef.authority === 'owner' && node.owner === playerId;
        const hz = typeof syncDef.rate === 'object' ? syncDef.rate.hz : null;
        // lastSentTick is 0 until the field first ships (the never-sent sentinel used
        // throughout this file). the first delivery of a dirty value is never rate-
        // gated: the { hz } cap limits the cadence BETWEEN repeated sends, not the
        // initial one — and at low ticks (room start) `currentTick - 0 >= ticksPerSend`
        // would otherwise stall that first send until tick >= ticksPerSend.
        const lastSent = known.lastSentTicks[i] ?? 0;
        if (hz !== null && !ownerHandoff && lastSent !== 0) {
            if (!SyncRate.shouldSendThisTick(hz, lastSent, currentTick, 60)) {
                continue;
            }
        }

        // the diff snapshot holds the just-emitted bytes; fall back to a fresh
        // pack if a slice changed without a snapshot (shouldn't happen post-diff).
        let data = sync?.bytes[i];
        if (!data) {
            data = codecs[i].pack(instance, node);
        }

        entries.push({ index: i, data });
        sentFields.push({ index: i, version: fieldVersion });
    }

    return entries;
}

/** build a NodeCreated update from a live node with per-field binary entries. */
function buildNodeCreatedUpdate(node: Node, mode: RoomMode): SceneSyncUpdate {
    const parentId = node.parent?.id ?? 0;
    const index = node.parent ? node.parent.children.indexOf(node) : 0;

    const wireIndex = registry.protocol.traits;
    const traits: BinaryTrait[] = [];
    for (const [traitSlot, instance] of node._traits) {
        const def = registry.slotToTrait.get(traitSlot);
        if (!def) continue;
        traits.push({
            netIndex: wireIndex.idToIndex.get(def.id),
            id: undefined,
            fields: readAllFields(node, traitSlot, instance),
            syncs: readAllSyncs(node, traitSlot, instance),
        });
    }
    // include unresolved traits (no wire-index entry, fall back to string id)
    for (const [id] of node._unresolvedTraits) {
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

/** diff a known node against current state and emit updates. updates knowledge in-place for sent fields. */
function diffNodeKnowledge(
    _sceneTree: SceneTree,
    node: Node,
    known: ClientNodeKnowledge,
    updates: SceneSyncUpdate[],
    mode: RoomMode,
    currentTick: number,
    playerId: PlayerId,
    nodeSyncKnowledge: Set<number>,
): void {
    // structural change (parent or index)
    const parentId = node.parent?.id ?? 0;
    const childIndex = node.parent ? node.parent.children.indexOf(node) : 0;
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

    // name change
    if (known.name !== node.name) {
        updates.push({
            type: 'node_name',
            id: node.id,
            name: node.name,
        });
        known.name = node.name;
    }

    // owner change
    if (known.owner !== node.owner) {
        updates.push({
            type: 'node_owner',
            id: node.id,
            owner: node.owner ?? undefined,
        });
        known.owner = node.owner;
    }

    // trait changes, per-field granularity with per-field rate gating
    const currentTraitIds = new Set<string>();
    const wireIndex = registry.protocol.traits;

    for (const [traitSlot, instance] of node._traits) {
        const def = registry.slotToTrait.get(traitSlot);
        if (!def) continue;
        currentTraitIds.add(def.id);

        const traitKnowledge = known.traits.get(def.id);

        if (!traitKnowledge) {
            // new trait, send add with full state (controls + syncs, no rate gating)
            updates.push({
                type: 'node_trait_added',
                id: node.id,
                traitNetIndex: wireIndex.idToIndex.get(def.id),
                traitId: undefined,
                fields: readAllFields(node, traitSlot, instance),
                syncs: readAllSyncs(node, traitSlot, instance),
            });

            // snapshot knowledge for this new trait, dense PACKED arrays by field index.
            const len = def.sync.length;
            const versions: number[] = [];
            const lastSentTicks: number[] = [];
            for (let i = 0; i < len; i++) {
                versions.push(instance._sync?.versions[i] ?? 0);
                lastSentTicks.push(currentTick);
            }
            known.traits.set(def.id, {
                version: instance._sync?.traitVersion ?? 0,
                versions,
                lastSentTicks,
            });
        } else {
            // existing trait, send only changed fields, with per-field rate gating
            const sentFields: Array<{ index: number; version: number }> = [];
            const changedFields = readChangedFields(node, traitSlot, instance, traitKnowledge, currentTick, sentFields, playerId);
            if (changedFields.length > 0) {
                updates.push({
                    type: 'node_trait_fields',
                    id: node.id,
                    traitNetIndex: wireIndex.idToIndex.get(def.id)!,
                    fields: changedFields,
                });
            }

            // update knowledge for sent fields only
            for (const sf of sentFields) {
                traitKnowledge.versions[sf.index] = sf.version;
                traitKnowledge.lastSentTicks[sf.index] = currentTick;
            }
            traitKnowledge.version = instance._sync?.traitVersion ?? 0;
        }
    }

    // include unresolved traits in current set
    for (const [id] of node._unresolvedTraits) {
        currentTraitIds.add(id);
        const traitKnowledge = known.traits.get(id);
        if (!traitKnowledge) {
            updates.push({
                type: 'node_trait_added',
                id: node.id,
                traitNetIndex: undefined,
                traitId: id,
                fields: [],
                syncs: [],
            });
            known.traits.set(id, { version: 0, versions: [], lastSentTicks: [] });
        }
        // note: unresolved traits can't change in-place (no live instance),
        // so we don't need to check version diffs for them
    }

    // removed traits, wire-compress when the id still has a current
    // entry; fall back to the string id for traits that disappeared from
    // the registry between snapshot and now (rare HMR edge).
    for (const traitId of known.traits.keys()) {
        if (!currentTraitIds.has(traitId)) {
            const netIndex = wireIndex.idToIndex.get(traitId);
            updates.push({
                type: 'node_trait_removed',
                id: node.id,
                traitNetIndex: netIndex,
                traitId: netIndex === undefined ? traitId : undefined,
            });
            known.traits.delete(traitId);
        }
    }

    // prefab config change, edit mode only
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

    // update node version, if any fields were throttled (not yet sent), keep nodeVersion
    // stale so the node is re-checked next tick. we detect this by comparing each trait's
    // field knowledge against the current field versions.
    let allFieldsCurrent = true;
    for (const [traitSlot, instance] of node._traits) {
        const def = registry.slotToTrait.get(traitSlot);
        if (!def) continue;
        const tk = known.traits.get(def.id);
        if (!tk) continue;
        for (let i = 0; i < def.sync.length; i++) {
            const currentFv = instance._sync?.versions[i] ?? 0;
            if (currentFv > (tk.versions[i] ?? 0)) {
                allFieldsCurrent = false;
                break;
            }
        }
        if (!allFieldsCurrent) break;
    }
    // `nodeVersion` reaching `node._sync.version` IS this client's "fully caught up"
    // marker, so it doubles as the pending-index truth: park the node while a field
    // is still behind (rate-throttled this tick), drop it once current. the fan-out
    // revisits `pending` even when the node isn't in `dirtyNodes` — otherwise a source
    // that settled would strand its last throttled update and this client would hold a
    // stale value. no new state: it indexes the `nodeVersion`/`versions` we already keep.
    if (allFieldsCurrent) {
        known.nodeVersion = node._sync.version;
        nodeSyncKnowledge.delete(node.id);
    } else {
        nodeSyncKnowledge.add(node.id);
    }
}

/* ── knowledge snapshotting ── */

/** snapshot the current state of a node into a knowledge map. */
export function snapshotNodeKnowledge(nodeKnowledge: Map<number, ClientNodeKnowledge>, node: Node, currentTick = 0): void {
    const parentId = node.parent?.id ?? 0;
    const childIndex = node.parent ? node.parent.children.indexOf(node) : 0;

    const traits = new Map<string, TraitKnowledge>();
    for (const [traitSlot, instance] of node._traits) {
        const def = registry.slotToTrait.get(traitSlot);
        if (!def) continue;

        // snapshot per-sync versions for this trait, dense PACKED arrays by field
        // index (0 = never bumped → lastSentTick stays 0, matching the old "no entry").
        const len = def.sync.length;
        const versions: number[] = [];
        const lastSentTicks: number[] = [];
        for (let i = 0; i < len; i++) {
            const v = instance._sync?.versions[i] ?? 0;
            versions.push(v);
            lastSentTicks.push(v ? currentTick : 0);
        }

        traits.set(def.id, {
            version: instance._sync?.traitVersion ?? 0,
            versions,
            lastSentTicks,
        });
    }
    // include unresolved traits so the diff system knows we already sent them
    for (const id of node._unresolvedTraits.keys()) {
        if (!traits.has(id)) {
            traits.set(id, { version: 0, versions: [], lastSentTicks: [] });
        }
    }

    nodeKnowledge.set(node.id, {
        nodeVersion: node._sync.version,
        parentId,
        childIndex: Math.max(0, childIndex),
        name: node.name,
        owner: node.owner,
        realm: node.realm,
        traits,
        prefab: node.prefab ? encodePrefabConfig(node.prefab) : null,
    });
}

/**
 * snapshot every (replicable) node in the scene tree into a knowledge map.
 * in play mode skips non-shared subtrees, those are never replicated and
 * should not appear in client knowledge. `prune` must MATCH the one passed to
 * `packSceneTree` at join, so the knowledge marked-known is exactly the packed
 * set: a transform root omitted from the pack is left unknown and is created
 * via the AOI presence pass, and (crucially) nothing packed is left unknown
 * (which would emit a redundant node_created next tick).
 */
function snapshotAllNodeKnowledge(
    sceneTree: SceneTree,
    nodeKnowledge: Map<number, ClientNodeKnowledge>,
    mode: RoomMode,
    prune?: (node: Node) => boolean,
): void {
    // include root: it's sent to the client as part of the packed scene
    // at join_room, so we must mark it known. otherwise the next diff loop
    // will see no knowledge entry and emit a redundant node_created.
    // root traits/scripts still diff normally on subsequent flushes.
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

// ═══════════════════════════════════════════════════════════════════════
// voxel chunk streaming
// ═══════════════════════════════════════════════════════════════════════
//
// server-side chunk streaming to clients. tracks per-client voxel
// knowledge and produces chunk_full / chunk_ops / chunk_light /
// chunk_del messages each tick.
//
// design mirrors minecraft's approach:
//   - spherical expansion order (closest chunks first)
//   - discovery walk queues occupied chunks into pendingFull (bounded by
//     DISCOVERY_BACKLOG_CAP); the room-level dispatchFull drains it with a
//     global priority sort + per-client cap (FULL_CHUNKS_PER_CLIENT_PER_TICK)
//   - coalesced ops (dedup by voxel index, keep last value)
//   - promotion threshold (too many ops → re-send as chunk_full)
//   - light epoch for full-recompute detection

/** max voxel_chunk_full messages per client per tick, burst limiter on the
 *  room-level dispatchFull, mirroring LIGHT_CHUNKS_PER_CLIENT_PER_TICK. bounds
 *  the cold-start decode burst when many chunks are queued at once; the
 *  steady-state ceiling will come from in-flight acks (Part C). */
const FULL_CHUNKS_PER_CLIENT_PER_TICK = 6;

/** max chunks in flight (shipped as voxel_chunk_full, awaiting voxel_ack) per
 *  client. the in-flight window: dispatchFull won't ship past this until acks
 *  free slots, so a decode-bound client throttles the server. Luanti uses 40
 *  against slower mesh-acks; we ack on decode, so start lower. effective
 *  throughput ≈ MAX_IN_FLIGHT_FULL / RTT, tune up for high-RTT clients. */
const MAX_IN_FLIGHT_FULL = 24;

/** stop the per-player discovery walk once pendingFull reaches this size.
 *  bounds cursor work + queue growth on a teleport / edit-radius anchor cross
 *  (~58k offsets) where the walk would otherwise drain the whole sphere into
 *  pendingFull in one tick. the cursor pauses and resumes next tick as
 *  dispatchFull drains the queue. */
const DISCOVERY_BACKLOG_CAP = 64;

/** max empty-chunk announcements per client per tick. each entry is ~12
 *  bytes so we can be generous, empties race ahead of full chunks so the
 *  client establishes the "known air" frontier quickly. */
const EMPTY_CHUNKS_PER_TICK = 256;

/** fallback view radius in chunks when the player node has no PlayerTrait
 *  (shouldn't happen in practice, createPlayerNode always adds it, but
 *  guards the flush against a partially-constructed scene). */
const DEFAULT_VIEW_RADIUS = 8;

/** hysteresis band (chunks) added to viewRadius to compute the eviction
 *  radius. chunks in [viewRadius, viewRadius + VIEW_RADIUS_MARGIN] are kept if
 *  already known but not freshly loaded, prevents thrash when the player
 *  jitters across a chunk boundary at the load frontier. */
const VIEW_RADIUS_MARGIN = 4;

/** if a chunk has more ops than this, promote to chunk_full re-send */
const PROMOTION_THRESHOLD = CHUNK_VOLUME / 2;

/** max voxel_chunk_light chunks per client per tick. drained by the
 *  room-level dispatch which sorts candidates globally by distance from
 *  each owning player. tuned to keep client-side decodeLight cost flat
 *  per tick. */
const LIGHT_CHUNKS_PER_CLIENT_PER_TICK = 8;

/** if a chunk has at most this many dirty light voxels, send per-voxel
 *  delta (voxel_chunk_light_delta) instead of the compressed whole-chunk
 *  (voxel_chunk_light). cuts client-side neighbour remesh fan-out for
 *  small edits. above the threshold, whole-chunk is more compact. */
const LIGHT_DELTA_THRESHOLD = 100;

/** virtual "max users" used in the global light cap formula, same shape
 *  as luanti's max_users knob, sets the global ceiling for small rooms.
 *  globalCap = (currentPlayers + ROOM_MAX_USERS) * per_client_cap / 4 + 1.
 *  with 1 player and the default per-client cap, globalCap >> per-client
 *  cap so a solo player is gated by the per-client cap only. as the room
 *  fills, the global cap grows mildly, keeping cross-client fairness. */
const ROOM_MAX_USERS = 8;

/* ── voxel knowledge reset ── */

/** called on hot reload, reset all voxel knowledge so chunks re-stream */
export function resetAllVoxelKnowledge(state: Discovery): void {
    for (const cs of state.clients.values()) {
        for (const k of cs.voxelKnowledge.values()) {
            k.knownChunks.clear();
            k.knownEmptyChunks.clear();
            k.knownLightEpoch = 0;
            k.cursor = 0;
            k.pendingLight.clear();
            k.pendingFull.clear();
            k.inFlightFull.clear();
            k.entered.clear();
            k.left.clear();
        }
    }
}

/** apply a client's voxel_ack: free the in-flight slots for the chunks it has
 *  decoded + applied, letting dispatchFull ship more. lookup by (client,
 *  playerId) is inherently scoped, a client's voxelKnowledge only holds its
 *  own players, and unknown keys (already evicted / re-sent / promoted) are
 *  ignored, so a stale or spoofed ack is a harmless no-op. */
export function handleVoxelAck(state: Discovery, client: Client, message: VoxelAck): void {
    const cs = state.clients.get(client);
    if (!cs) return;
    const knowledge = cs.voxelKnowledge.get(message.playerId);
    if (!knowledge) return;
    for (const c of message.full) {
        knowledge.inFlightFull.delete(chunkKey(c.cx, c.cy, c.cz));
    }
}

/* ── spherical expansion order ── */

/** cached spherical-expansion offsets keyed by radius. radii are chosen
 *  per-player via PlayerTrait.viewRadius (e.g. 8 for play, 24 for edit), and
 *  there are only a handful of distinct values in practice so this map stays
 *  tiny. lazy: first request for a radius builds and caches. */
const EXPANSION_ORDER_CACHE = new Map<number, [number, number, number][]>();

function getExpansionOrder(radius: number): [number, number, number][] {
    let order = EXPANSION_ORDER_CACHE.get(radius);
    if (!order) {
        order = buildExpansionOrder(radius);
        EXPANSION_ORDER_CACHE.set(radius, order);
    }
    return order;
}

function buildExpansionOrder(radius: number): [number, number, number][] {
    const offsets: [number, number, number][] = [];
    const r2 = radius * radius;
    for (let dy = -radius; dy <= radius; dy++)
        for (let dz = -radius; dz <= radius; dz++)
            for (let dx = -radius; dx <= radius; dx++) if (dx * dx + dy * dy + dz * dz <= r2) offsets.push([dx, dy, dz]);
    offsets.sort((a, b) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2] - (b[0] * b[0] + b[1] * b[1] + b[2] * b[2]));
    return offsets;
}

/* ── compressed snapshot caching ── */

/** get or build the compressed snapshot for a chunk. caches on the chunk. */
function getCompressedSnapshot(chunk: Chunk, zstd: Zstd): { compressed: Uint8Array; palette: string[] } {
    if (chunk.compressedSnapshot && chunk.snapshotPalette) {
        return { compressed: chunk.compressedSnapshot, palette: chunk.snapshotPalette };
    }
    const compressed = encodeChunk(chunk.data, chunk.light, zstd);
    const palette = chunk.paletteKeys.slice();
    chunk.compressedSnapshot = compressed;
    chunk.snapshotPalette = palette;
    return { compressed, palette };
}

/** get or build the compressed light streams for a chunk. caches on the
 *  chunk. light is split into sky + rgb channels, RLE'd, then deflated. */
function getCompressedLight(chunk: Chunk): { sky: Uint8Array; rgb: Uint8Array } {
    if (chunk.compressedLight) return chunk.compressedLight;
    const compressed = encodeLight(chunk.light);
    chunk.compressedLight = compressed;
    return compressed;
}

/* ── coalescing ── */

type CoalescedBlockChunk = {
    cx: number;
    cy: number;
    cz: number;
    paletteKeys: string[];
    changes: Map<number, number>; // index → data (last wins)
};

/** coalesce block ops by chunk, dedup by voxel index (keep last value). */
function coalesceBlockOps(
    ops: VoxelChanges['ops'],
    knownChunks: Set<string>,
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
                paletteKeys: chunk.paletteKeys,
                changes: new Map(),
            };
            result.set(key, entry);
        }
        entry.changes.set(op.index, (op as VoxelBlockOp).data);
    }
    return result;
}

/* ── player chunk coordinate ── */

/** Chunk coordinate of a Player's body, used as the streaming anchor. */
function getPlayerChunkCoord(room: Room, playerId: PlayerId): [number, number, number] {
    const node = room.playerNodes.get(playerId);
    if (!node) return [0, 0, 0];

    const t = getTrait(node, TransformTrait);
    if (!t) return [0, 0, 0];

    const pos = getWorldPosition(t);
    return [toChunkCoord(Math.floor(pos[0])), toChunkCoord(Math.floor(pos[1])), toChunkCoord(Math.floor(pos[2]))];
}

/* ── voxel flush ── */

/**
 * produce voxel messages for every Player in a room, each Player has its
 * own streaming anchor and chunk-knowledge set, so views stay isolated
 * (matters when a client holds two Players in the same room, e.g. a
 * dev's edit camera + their play character).
 */
function flushVoxelsForRoom(state: Discovery, rooms: Rooms, room: Room, out: Array<[Client, ServerMessage]>): void {
    const voxels = room.voxels;
    const auth = voxels.authority;
    if (!auth) return;
    const changes = auth.changes;

    // per-player phase: cursor walks → pendingFull, ops, and absorb newly-dirty
    // light chunks into each client's pendingLight set. nothing is shipped for
    // full/light yet, dispatch happens room-wide below.
    const players: Player[] = [];
    for (const player of RoomsModule.getPlayersInRoom(rooms, room)) {
        const cs = state.clients.get(player.client);
        if (!cs) continue;

        let knowledge = cs.voxelKnowledge.get(player.id);
        if (!knowledge) {
            knowledge = {
                knownChunks: new Set(),
                knownEmptyChunks: new Set(),
                knownLightEpoch: 0,
                lastAnchor: null,
                cursor: 0,
                pendingLight: new Set(),
                pendingFull: new Set(),
                inFlightFull: new Set(),
                entered: new Set(),
                left: new Set(),
            };
            cs.voxelKnowledge.set(player.id, knowledge);
        }

        flushVoxelsForPlayer(room, voxels, changes, player, knowledge, out);
        players.push(player);
    }

    // room-wide dispatch after every player has discovered + absorbed.
    // dispatchFull runs first and returns the chunks it shipped as
    // voxel_chunk_full this tick: those payloads carry fresh light, so
    // dispatchLight clears their masks (and skips them, they were still in
    // pendingFull, not knownChunks, when the per-player light-absorb ran).
    const fullShippedChunks = dispatchFull(state, room, voxels, players, out);
    dispatchLight(state, room, voxels, players, out, fullShippedChunks);
}

type DispatchCandidate = { d2: number; key: string; pid: PlayerId; chunk: Chunk };

/**
 * shared room-wide priority dispatch. each player's `selectPending` queue is
 * gathered into one candidate list ranked by d² from that player's anchor, then
 * shipped nearest-first under a per-client cap + a global cap (luanti's
 * GetNextBlocks → PrioritySortedBlockTransfer → SendBlocks shape). one message
 * per shipped chunk, the transport coalesces a tick's messages into one
 * frame, so per-chunk keeps the dispatch unit uniform across channels.
 *
 * `ship` emits the channel's message + any per-winner bookkeeping; the generic
 * loop deletes the shipped key from the pending set. returns the chunks shipped.
 */
function dispatchChannel(
    state: Discovery,
    room: Room,
    voxels: Voxels,
    players: Player[],
    perClientCap: number,
    selectPending: (k: ClientVoxelKnowledge) => Set<string>,
    ship: (c: DispatchCandidate, knowledge: ClientVoxelKnowledge, client: Client) => void,
    // optional in-flight window (full channel): skip a client once this many
    // chunks are outstanding (shipped, awaiting ack). pending and in-flight are
    // disjoint, ship moves the key across, so this is the only gate needed.
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
                // chunk deleted between queueing and dispatch, drop it.
                pending.delete(key);
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
        // in-flight ceiling: skip (leave queued) once this client has too many
        // outstanding. the set grows as we ship this tick, so the check is live.
        if (inFlight && inFlight.select(knowledge).size >= inFlight.max) continue;

        ship(c, knowledge, clientByPid.get(c.pid)!);
        selectPending(knowledge).delete(c.key);
        shipped.add(c.chunk);
        perClientCount.set(c.pid, sent + 1);
        totalSent++;
    }

    return shipped;
}

/**
 * room-wide chunk_full dispatch. drains each player's pendingFull (filled by
 * discovery) nearest-first. returns the chunks shipped, handed to
 * dispatchLight as fullShippedChunks so their light masks get cleared (the full
 * payload already carried fresh light).
 *
 * runs before dispatchLight: shipping here adds the chunk to knownChunks, and
 * since the per-player light-absorb ran while it was still in pendingFull (not
 * known), it is not separately queued for light.
 */
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
                    paletteKeys: palette,
                    compressed,
                },
            ]);
            knowledge.knownChunks.add(c.key);
            knowledge.inFlightFull.add(c.key);
            knowledge.entered.add(c.key); // node AOI: chunk terrain shipped → its roots stream in this tick
        },
        { max: MAX_IN_FLIGHT_FULL, select: (k) => k.inFlightFull },
    );
}

/**
 * room-wide light dispatch. drains each player's pendingLight nearest-first,
 * shipping a per-voxel delta when the dirty count is small, else a whole-chunk
 * light. then clears the light masks of chunks fully synced this tick, light
 * shipped here, or chunk_full shipped earlier (its payload carried fresh light).
 * unshipped (cap-exhausted) chunks keep their mask + count for next tick; new
 * writes OR into the same mask via setLight.
 */
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
                // per-voxel delta path, iterate set bits in the mask.
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

    // mask + count cleared only on ship (deferred so two players queued for the
    // same chunk both see the same dirtyCount and ship matching payloads).
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

/**
 * sweep this player's known/knownEmpty sets and evict any chunks outside the
 * `evictRadius` sphere centered at `(pcx,pcy,pcz)`. emits voxel_chunk_del for
 * each evicted known chunk so the client drops its mesh + memory; empty
 * stubs are dropped silently (client keeps the all-air alias, harmless).
 *
 * called only on chunk-coord transitions in flushVoxelsForPlayer, known sets
 * can be large at edit-radius scale (~58k entries) so per-tick walking would
 * be wasteful when nothing has changed.
 */
function evictOutOfRange(
    knowledge: ClientVoxelKnowledge,
    pcx: number,
    pcy: number,
    pcz: number,
    evictRadius: number,
    client: Client,
    playerId: PlayerId,
    out: Array<[Client, ServerMessage]>,
): void {
    const r2 = evictRadius * evictRadius;
    for (const key of knowledge.knownChunks) {
        const parts = key.split(',');
        const cx = Number.parseInt(parts[0]!, 10);
        const cy = Number.parseInt(parts[1]!, 10);
        const cz = Number.parseInt(parts[2]!, 10);
        const dx = cx - pcx;
        const dy = cy - pcy;
        const dz = cz - pcz;
        if (dx * dx + dy * dy + dz * dz <= r2) continue;
        out.push([client, { type: 'voxel_chunk_del', playerId, cx, cy, cz }]);
        knowledge.left.add(key); // node AOI: transform roots here leave this client's region
        knowledge.knownChunks.delete(key);
        knowledge.pendingLight.delete(key);
        // in-flight keys are a subset of knownChunks; drop the slot. a late ack
        // for an evicted chunk hits an unknown key and is ignored.
        knowledge.inFlightFull.delete(key);
    }
    for (const key of knowledge.knownEmptyChunks) {
        const parts = key.split(',');
        const cx = Number.parseInt(parts[0]!, 10);
        const cy = Number.parseInt(parts[1]!, 10);
        const cz = Number.parseInt(parts[2]!, 10);
        const dx = cx - pcx;
        const dy = cy - pcy;
        const dz = cz - pcz;
        if (dx * dx + dy * dy + dz * dz <= r2) continue;
        knowledge.left.add(key); // node AOI: air-chunk roots leave the region too
        knowledge.knownEmptyChunks.delete(key);
    }
    // pendingFull entries are neither known nor empty yet, drop any that
    // drifted out of range before dispatchFull got to them (no chunk_del:
    // the client never received them).
    for (const key of knowledge.pendingFull) {
        const parts = key.split(',');
        const cx = Number.parseInt(parts[0]!, 10);
        const cy = Number.parseInt(parts[1]!, 10);
        const cz = Number.parseInt(parts[2]!, 10);
        const dx = cx - pcx;
        const dy = cy - pcy;
        const dz = cz - pcz;
        if (dx * dx + dy * dy + dz * dz <= r2) continue;
        knowledge.left.add(key); // node AOI: a mover created against this pending chunk must leave too
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

    // clear-then-fill the per-tick node-AOI region deltas. last tick's values were
    // already consumed by last tick's scene phase (which runs after this voxel phase),
    // so starting empty here is correct; the walk / evict / dispatchFull below refill them.
    knowledge.entered.clear();
    knowledge.left.clear();

    // 0. light epoch check, if server did a full recompute, reset client
    //    knowledge. clear the discovery queue too: pendingFull holds chunks
    //    that would otherwise ship against the stale epoch; the cursor rewind
    //    re-discovers them with fresh light.
    if (knowledge.knownLightEpoch < changes.light.epoch) {
        knowledge.knownChunks.clear();
        knowledge.knownEmptyChunks.clear();
        knowledge.pendingFull.clear();
        knowledge.inFlightFull.clear();
        knowledge.knownLightEpoch = changes.light.epoch;
        knowledge.cursor = 0;
    }

    const [pcx, pcy, pcz] = getPlayerChunkCoord(room, player.id);

    // per-player view radius, server picks 8 (play) or 24 (edit) at
    // createPlayerNode time. fall back to the default if PlayerTrait is
    // somehow missing.
    const playerNode = room.playerNodes.get(player.id);
    const playerTrait = playerNode ? getTrait(playerNode, PlayerTrait) : null;
    const viewRadius = playerTrait?.viewRadius ?? DEFAULT_VIEW_RADIUS;
    const expansionOrder = getExpansionOrder(viewRadius);

    // 1a. eviction, only on chunk-boundary crossings. evict knownChunks
    //     (sending chunk_del) and silently drop knownEmptyChunks that drifted
    //     beyond viewRadius + VIEW_RADIUS_MARGIN. empty stubs are cheap on the
    //     client (aliased EMPTY_DATA) so we leave them in voxels.chunks; only
    //     the server-side knowledge needs to shrink so they can be re-emitted
    //     if the player ever returns.
    //
    //     anchor cross also rewinds the cursor: the sphere is anchor-relative,
    //     so previously-discovered offsets now point at different chunks.
    if (
        knowledge.lastAnchor === null ||
        knowledge.lastAnchor[0] !== pcx ||
        knowledge.lastAnchor[1] !== pcy ||
        knowledge.lastAnchor[2] !== pcz
    ) {
        evictOutOfRange(knowledge, pcx, pcy, pcz, viewRadius + VIEW_RADIUS_MARGIN, client, player.id, out);
        knowledge.lastAnchor = [pcx, pcy, pcz];
        knowledge.cursor = 0;
    }

    // 1b. addedChunks drain, chunks created this tick. drop any
    //     known-empty entry that's now occupied, and rewind the cursor so the
    //     walk picks them up (visited entries short-circuit cheaply on re-walk).
    if (changes.addedChunks.size > 0) {
        for (const chunk of changes.addedChunks) {
            const key = chunkKey(chunk.cx, chunk.cy, chunk.cz);
            knowledge.knownEmptyChunks.delete(key);
        }
        knowledge.cursor = 0;
    }

    // 2. chunk_full / chunk_empty, resume the sphere walk from the cursor.
    //    each tick we drain forward until the per-tick budget is hit; visited
    //    entries (knownChunks / knownEmptyChunks) short-circuit. when the
    //    cursor reaches expansionOrder.length the sphere is fully discovered
    //    and per-tick cost drops to zero until the next anchor cross or
    //    addedChunks drain.
    const pendingEmpty: { cx: number; cy: number; cz: number }[] = [];
    while (knowledge.cursor < expansionOrder.length) {
        // stop once both queues are full for this tick. occupied chunks go to
        // pendingFull (drained by dispatchFull); empties ship inline below.
        if (knowledge.pendingFull.size >= DISCOVERY_BACKLOG_CAP && pendingEmpty.length >= EMPTY_CHUNKS_PER_TICK) break;
        const [dx, dy, dz] = expansionOrder[knowledge.cursor]!;
        knowledge.cursor++;
        const cx = pcx + dx;
        const cy = pcy + dy;
        const cz = pcz + dz;
        const key = chunkKey(cx, cy, cz);
        if (knowledge.knownChunks.has(key)) continue;
        if (knowledge.knownEmptyChunks.has(key)) continue;
        if (knowledge.pendingFull.has(key)) continue;
        const chunk = voxels.chunks.get(key);
        if (chunk) {
            if (knowledge.pendingFull.size >= DISCOVERY_BACKLOG_CAP) {
                // backlog full, rewind one step so we revisit this offset
                // next tick once dispatchFull has drained the queue.
                knowledge.cursor--;
                break;
            }
            knowledge.pendingFull.add(key);
        } else {
            if (pendingEmpty.length >= EMPTY_CHUNKS_PER_TICK) {
                knowledge.cursor--;
                break;
            }
            pendingEmpty.push({ cx, cy, cz });
            knowledge.knownEmptyChunks.add(key);
            knowledge.entered.add(key); // node AOI: air chunk discovered → its roots can stream in
        }
    }
    if (pendingEmpty.length > 0) {
        out.push([
            client,
            {
                type: 'voxel_chunk_empty',
                playerId: player.id,
                chunks: pendingEmpty,
            },
        ]);
    }

    // 3. block ops, coalesce and send for known chunks
    if (changes.ops.length > 0) {
        const blockChanges = coalesceBlockOps(changes.ops, knowledge.knownChunks, voxels.chunks);

        // promote chunks with too many block changes to a chunk_full re-send:
        // drop from knownChunks (+ any queued light) and re-queue directly into
        // pendingFull so dispatchFull re-ships the whole chunk. no cursor
        // rewind needed, the chunk is back in the dispatch queue, and the
        // pendingFull guard in the walk keeps re-discovery from duplicating it.
        for (const [key, entry] of blockChanges) {
            if (entry.changes.size > PROMOTION_THRESHOLD) {
                knowledge.knownChunks.delete(key);
                knowledge.pendingLight.delete(key);
                // if it was shipped-but-not-acked, drop the in-flight slot; the
                // stale ack for the old send is ignored (unknown key).
                knowledge.inFlightFull.delete(key);
                knowledge.pendingFull.add(key);
                blockChanges.delete(key);
            }
        }

        // send chunk_ops (block changes)
        if (blockChanges.size > 0) {
            const chunks: Array<{
                cx: number;
                cy: number;
                cz: number;
                paletteKeys: string[];
                changes: Array<{ index: number; data: number }>;
            }> = [];

            for (const entry of blockChanges.values()) {
                const changeList: Array<{ index: number; data: number }> = [];
                for (const [index, data] of entry.changes) {
                    changeList.push({ index, data });
                }
                chunks.push({
                    cx: entry.cx,
                    cy: entry.cy,
                    cz: entry.cz,
                    paletteKeys: entry.paletteKeys,
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

    // 4. light, absorb newly-dirty chunks into this client's pendingLight
    //    queue. actual dispatch happens at the room level after all players
    //    have absorbed, so we can apply a globally-sorted priority + per-tick
    //    cap across the room (luanti-style global priority + per-client cap).
    //    the knownChunks guard skips chunks still queued in pendingFull: their
    //    light ships inside the chunk_full payload that dispatchFull sends this
    //    tick (it runs after this), so there's no separate light send.
    for (const chunk of voxels.dirty.light) {
        const key = chunkKey(chunk.cx, chunk.cy, chunk.cz);
        if (!knowledge.knownChunks.has(key)) continue;
        knowledge.pendingLight.add(key);
    }
}
