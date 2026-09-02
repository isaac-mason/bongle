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
    childIndexOf,
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
import type { TraitBase, TraitDef } from '../core/scene/traits';
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
    const nodeTraits = node._traits;
    for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
        const instance = nodeTraits[traitSlot];
        if (instance === undefined) continue;
        const def = registry.slotToTrait[traitSlot];
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
    /** the trait's registry id, so a removal can still name it if the def has since left the
     *  registry and its slot no longer resolves. */
    id: string;
    /** a field of this trait is version-ahead of what this client has, because rate gating
     *  held it back. Set by `readChangedFields`, which is the only thing that can know. */
    behind: boolean;
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
    /** per-slot knowledge for traits whose def is in the registry. Indexed the same way
     *  `Node._traits` is, so the fan-out reaches it without hashing a trait id. */
    traits: Array<TraitKnowledge | undefined>;
    /** knowledge for traits whose def was missing at snapshot time (HMR drift). Mirrors
     *  `Node._unresolvedTraits`; null until one appears, which is the normal case. */
    unresolvedTraits: Map<string, TraitKnowledge> | null;
    /** json-encoded PrefabConfig, or null if no prefab */
    prefab: string | null;
};

/* ── per-client voxel knowledge ── */

/** chunk coords, stored alongside the key so eviction (a per-tick-budgeted-anchor-
 *  cross walk over every known chunk) doesn't have to re-derive them by parsing the
 *  key string every time — chunkKey()/split() round-tripping showed up as the
 *  dominant cost in a live 24ms+ discovery spike (evictOutOfRange + the discovery
 *  walk together, both keyed off the SAME chunkKey() string). */
type ChunkCoord = { cx: number; cy: number; cz: number };

/** region coords, stored alongside the key for the same reason ChunkCoord is:
 *  dispatchRegionFull ranks pendingRegions by distance every tick, so it
 *  shouldn't have to re-derive rx/ry/rz by parsing the region key string. */
type RegionCoord = { rx: number; ry: number; rz: number };

/** one region's worth of this client's known chunks (knownChunks ∪ knownEmptyChunks),
 *  keyed the same way `voxels.regions` is, so eviction's sphere test is O(known
 *  regions) instead of O(known chunks): only regions that actually left range get
 *  enumerated (bounded to REGION_VOLUME entries each), region coords are stored
 *  alongside so the test never re-derives them by parsing the region key string. */
type ClientKnownRegion = { rx: number; ry: number; rz: number; chunks: Map<string, ChunkCoord> };

type ClientVoxelKnowledge = {
    /** chunks known to the client (full data or an air stub), whether shipped
     *  individually (voxel_chunk_full, promotion re-sends) or as part of a
     *  voxel_region_full bundle (discovery). kept in sync with chunk_ops/light. */
    knownChunks: Map<string, ChunkCoord>;
    /** chunks known to the client as empty (an air stub), same shipping paths
     *  as knownChunks above. lets collision distinguish "known air" from
     *  "unknown" (treated as solid). */
    knownEmptyChunks: Map<string, ChunkCoord>;
    /** secondary index over knownChunks ∪ knownEmptyChunks, grouped by region (see
     *  `ClientKnownRegion`). maintained alongside those two maps by `fileKnownChunk`/
     *  `unfileKnownChunk` at every add/remove site — mirrors how `voxels.ts` keeps
     *  `chunks` and `regions` in sync via `ensureChunk`/`removeChunk`. lets eviction
     *  test region-sphere membership in O(known regions) instead of O(known chunks);
     *  entry pruned when its bucket empties. */
    knownRegions: Map<string, ClientKnownRegion>;
    knownLightEpoch: number;
    /** player's region coord at the last flush. eviction (and the discovery
     *  recompute) runs only when this changes, so casual movement within one
     *  region (up to REGION_CHUNKS_PER_AXIS chunks wide) costs nothing — the old
     *  per-CHUNK anchor test re-ran the full sphere walk on every single
     *  chunk-boundary crossing, the actual dominant cost in a live 24ms+
     *  discovery spike. null until the first flush. */
    lastAnchorRegion: [number, number, number] | null;
    /** regions discovered in-range but not yet shipped as voxel_region_full.
     *  populated by an unbudgeted full recompute on anchor cross (see
     *  flushVoxelsForPlayer): deciding "is this region in range" is a pure
     *  geometric distance test, no per-tick budget needed for that — only the
     *  actual SHIP (dispatchRegionFull, which reads and compresses real chunk
     *  data) is rate-limited. */
    pendingRegions: Map<string, RegionCoord>;
    /** regions shipped as voxel_region_full but not yet acked by the client
     *  (voxel_ack.regions). its size is the in-flight window: dispatchRegionFull
     *  stops shipping to a client once it hits `maxInFlightRegions`, so a slow
     *  (decode-bound) client throttles the server. an ack removes the key,
     *  freeing a slot. */
    inFlightRegions: Set<string>;
    /** this player's in-flight ceiling (see `inFlightRegions`). starts at 1 — a
     *  fresh join (which may need to freshly (re)compress a lot of chunks whose
     *  cached snapshot got invalidated by edits since anyone last streamed them,
     *  regardless of how "warm" the server otherwise is) gets at most ONE
     *  region's worth of fresh compression per tick until THIS player proves it
     *  can keep up — bumped to MAX_IN_FLIGHT_REGIONS by handleVoxelAck on its
     *  first region ack. mirrors Minecraft's PlayerChunkSender.maxUnacknowledgedBatches
     *  (1 -> 10 after the first ack), instantiated fresh per connection there the
     *  same way this is fresh per invalidatePlayer here. */
    maxInFlightRegions: number;
    /** this client's self-reported, smoothed decode rate (voxel_region_full
     *  regions/tick), from the `desiredRegionsPerTick` field on its most recent
     *  voxel_ack (see client/voxel-pacing.ts — mirrors Minecraft's
     *  ChunkBatchSizeCalculator, whose "chunk" is actually a whole column: our
     *  region is the equivalent unit). dispatchRegionFull's per-client cap for
     *  THIS player reads this instead of a fixed default, so a slow client is
     *  throttled down and a fast one isn't held back. starts at the default and
     *  only moves once a real ack lands; never reset on hot reload (see
     *  resetAllVoxelKnowledge) — it describes the client machine's decode
     *  speed, not server-side voxel state. */
    fullRegionsPerTick: number;
    /** chunks whose light has changed but hasn't yet been shipped to this
     *  client. populated each tick from voxels.dirty.light (intersected with
     *  knownChunks). drained by the room-level dispatch with a global priority
     *  sort + per-client cap. survives across ticks so rate-limited skips
     *  ship on subsequent ticks rather than being lost. */
    pendingLight: Set<string>;
    /** chunks needing an individual voxel_chunk_full re-send: PROMOTION only
     *  (too many block-ops landed in an already-known chunk this tick, see the
     *  block-ops section of flushVoxelsForPlayer). discovery never populates
     *  this — a newly-discovered region ships as one voxel_region_full instead
     *  (see pendingRegions/dispatchRegionFull). fixed-rate, not adaptive:
     *  promotion volume is bounded by edit activity, not exploration bursts, so
     *  it doesn't need the region channel's sophistication. */
    pendingFull: Set<string>;
    /** chunks shipped as an individual voxel_chunk_full (promotion re-sends)
     *  but not yet acked by the client (voxel_ack.full). its size is the
     *  in-flight window: dispatchFull stops shipping to a client once it hits
     *  MAX_IN_FLIGHT_FULL, so a slow (decode-bound) client throttles the
     *  server. an ack removes the key, freeing a slot. disjoint from
     *  pendingFull (ship moves the key across) and a subset of knownChunks. */
    inFlightFull: Set<string>;
};

/** per-Player entity/prop presence knowledge: independent of `ClientVoxelKnowledge`
 *  on purpose (see the `RETENTION_MARGIN` comment below for the regression this
 *  decoupling fixes). keyed on the SAME region-coordinate grid voxel streaming
 *  uses, so a root's presence test and its invalidation trigger (an anchor
 *  crossing a region boundary) stay synchronized, but tracked as a pure geometric
 *  "which regions are in range" membership set, not residency data. entities
 *  have no expensive payload to prepare, so unlike voxel streaming this recomputes
 *  in full, unbudgeted, on every anchor cross (see `flushEntityPresenceForPlayer`)
 *  rather than draining a per-tick-budgeted cursor. */
type ClientEntityPresence = {
    /** regions currently considered in range for entity presence. */
    knownRegions: Set<string>;
    /** anchor's region coord at the last recompute, null until the first one.
     *  recompute runs only when this changes (mirrors voxel's anchor-cross gate). */
    lastAnchorRegion: [number, number, number] | null;
    /** per-tick region deltas: regions that became in/out of range this recompute.
     *  cleared-then-filled by `flushEntityPresenceForPlayer`; consumed the same tick
     *  by the scene phase (`buildSceneSyncUpdates`) to turn a region transition into
     *  subtree create/destroy for the transform roots filed in it. */
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
     * per-Player entity/prop presence knowledge (see `ClientEntityPresence`). Same
     * per-Player isolation rationale as `voxelKnowledge`, and populated alongside it
     * in `invalidatePlayer`/`notifyPlayerLeft`, but the two maps are otherwise
     * independent, an entity's presence never reads voxel residency state.
     */
    entityPresence: Map<PlayerId, ClientEntityPresence>;

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
        entityPresence: new Map(),
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

    // snapshot every node so the same-tick scene_sync diff finds no changes
    const snapT0 = performance.now();
    snapshotAllNodeKnowledge(room.scene, nodeKnowledge, player.mode, transformRootPrune);
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
    cs.entityPresence.delete(player.id);

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
            let traitKnowledge = known.traits[def.slot];
            if (!traitKnowledge) {
                traitKnowledge = {
                    id: def.id,
                    behind: false,
                    versions: zeros(def.sync.length),
                    lastSentTicks: zeros(def.sync.length),
                };
                known.traits[def.slot] = traitKnowledge;
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
        runDiffDetection(room.scene);
    }
    Debug.end(metrics, 'discovery/diff');

    // --- phase 2: voxel chunk streaming + transform-root region-index reconcile ---
    // runs BEFORE the scene phase: the region index must be current when scene sync
    // gates node presence via `rootRegionChanges`.
    Debug.begin(metrics, 'discovery/voxels');
    for (const room of rooms.rooms.values()) {
        // reconcile the transform-root region index off this tick's dirtyNodes so
        // rootsInRegion is current for the scene phase. runs for every room (even
        // ones without voxel authority); it's O(dirtyNodes) and touches nothing else.
        reconcileRootRegions(room.scene);
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

    // --- phase 3: per-client scene sync ---
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

            // entity/prop presence for region-tied node AOI: present only when the room
            // streams chunks. undefined → no region gating (all replicable nodes
            // visible, the pre-AOI behaviour) for edit players and non-voxel rooms.
            // recomputed here (not in the voxel phase above): it's independent of voxel
            // residency, so unlike `aoi` in the old design it doesn't need to run before
            // this loop, just before this loop consumes it.
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
    // this tick's reconcileRootRegions consumed it. cleared here (end of the scene
    // phase, which now runs LAST): the voxel phase's reconcile + the scene fan-out
    // both read dirtyNodes, so clearing any earlier would strand one of them. nodes
    // still owed after a rate-throttle are carried per-client in nodeSyncKnowledge.
    for (const room of rooms.rooms.values()) {
        if (room.scene.dirtyNodes.size > 0) room.scene.dirtyNodes.clear();
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

/* ── region-tied node AOI helpers ── */

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
    presence: ClientEntityPresence | undefined,
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
    // presence of a transform root = its region ∈ knownRegions. it flips when EITHER
    // the player's region membership moved (this player's entered/left region deltas)
    // OR the root moved/spawned/despawned (the room's rootRegionChanges). we gather
    // those candidate roots and, for each, compare want (current filed region ∈
    // knownRegions) vs have (known) — iterating ROOTS, so we never climb the tree.
    // destruction of an actually-destroyed root (scene === null) is left to the
    // dirtyNodes loop; here we handle live AOI in/out.
    if (presence) {
        const candidates = new Set<Node>();
        for (const key of presence.left) {
            const roots = rootsInRegion(sceneTree, key);
            if (roots) for (const r of roots) candidates.add(r);
        }
        for (const key of presence.entered) {
            const roots = rootsInRegion(sceneTree, key);
            if (roots) for (const r of roots) candidates.add(r);
        }
        for (const ch of sceneTree.rootRegionChanges) candidates.add(ch.root);

        for (const root of candidates) {
            // the own-player subtree is the always-visible anchor, never region-gated.
            if (root.id === ownRootId || root.scene === null) continue;
            const filed = sceneTree.rootToRegion.get(root); // current region, O(1); undefined if unfiled
            const want = filed !== undefined && presence.knownRegions.has(filed);
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
        // a node with no transform root (or a non-voxel room) is not region-gated → visible.
        const root = presence ? transformRootOf(node) : null;
        if (root === null) {
            creates.add(node);
            continue;
        }
        // a region-gated node became newly relevant (spawned, or added under a present
        // subtree): create from its root iff that root is in region — createSubtree walks
        // only the not-yet-known nodes, so an incremental add under a present root emits
        // just the new nodes, and a spawn out of region waits for the AOI pass.
        const filed = sceneTree.rootToRegion.get(root);
        if (root.id === ownRootId || (filed !== undefined && presence!.knownRegions.has(filed))) createSubtree(root);
    }

    // carry-over: nodes that still owe this client a rate-throttled sync() field but
    // are NOT in dirtyNodes because their source settled. re-diff each to retry the
    // throttled field once its cadence allows; diffNodeKnowledge clears it from
    // nodeSyncKnowledge when the client catches up. these are already-known nodes, so
    // region membership is current (eviction/exit already removed them here). snapshot
    // first — the diff mutates the set. skip nodes already handled via dirtyNodes above.
    _pendingSyncScratch.length = 0;
    for (const nodeId of nodeSyncKnowledge) _pendingSyncScratch.push(nodeId);
    for (const nodeId of _pendingSyncScratch) {
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
    const def = registry.slotToTrait[traitSlot];
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
    const def = registry.slotToTrait[traitSlot];
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
 * applying per-field rate gating. Commits per-field knowledge for the fields it sends, and
 * records on `known.behind` whether rate gating held anything back.
 */
function readChangedFields(
    node: Node,
    traitSlot: number,
    instance: TraitBase,
    known: TraitKnowledge,
    currentTick: number,
    playerId: PlayerId,
): BinaryField[] | null {
    // cleared before the early returns: a trait that can't ship anything owes nothing, and a
    // stale `true` would pin its node in `nodeSyncKnowledge` forever.
    known.behind = false;

    const def = registry.slotToTrait[traitSlot];
    if (!def) return null;

    const codecs = getSyncCodecs(def);
    if (!codecs) return null;

    const sync = instance._sync;
    // stays null while nothing has changed, which is the overwhelmingly common case: this
    // runs per trait per known node per client per flush.
    let entries: BinaryField[] | null = null;

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
                // held back this tick: the node stays pending so the field retries.
                known.behind = true;
                continue;
            }
        }

        // the diff snapshot holds the just-emitted bytes; fall back to a fresh
        // pack if a slice changed without a snapshot (shouldn't happen post-diff).
        let data = sync?.bytes[i];
        if (!data) {
            data = codecs[i].pack(instance, node);
        }

        (entries ??= []).push({ index: i, data });
        known.versions[i] = fieldVersion;
        known.lastSentTicks[i] = currentTick;
    }

    return entries;
}

/** reused snapshot of `nodeSyncKnowledge`, which the diff below mutates as it drains. */
const _pendingSyncScratch: number[] = [];

/** build a NodeCreated update from a live node with per-field binary entries. */
function buildNodeCreatedUpdate(node: Node, mode: RoomMode): SceneSyncUpdate {
    const parentId = node.parent?.id ?? 0;
    const index = childIndexOf(node);

    const traits: BinaryTrait[] = [];
    const nodeTraits = node._traits;
    for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
        const instance = nodeTraits[traitSlot];
        if (instance === undefined) continue;
        const def = registry.slotToTrait[traitSlot];
        if (!def) continue;
        traits.push({
            netIndex: def.netIndex,
            id: undefined,
            fields: readAllFields(node, traitSlot, instance),
            syncs: readAllSyncs(node, traitSlot, instance),
        });
    }
    // include unresolved traits (no wire-index entry, fall back to string id)
    for (const [id] of node._unresolvedTraits ?? EMPTY_UNRESOLVED) {
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

    const nodeTraits = node._traits;
    for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
        const instance = nodeTraits[traitSlot];
        if (instance === undefined) continue;
        const def = registry.slotToTrait[traitSlot];
        if (!def) continue;

        const traitKnowledge = known.traits[traitSlot];

        if (!traitKnowledge) {
            // new trait, send add with full state (controls + syncs, no rate gating)
            updates.push({
                type: 'node_trait_added',
                id: node.id,
                traitNetIndex: def.netIndex,
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
            known.traits[traitSlot] = { id: def.id, behind: false, versions, lastSentTicks };
        } else {
            // existing trait, send only changed fields, with per-field rate gating
            // readChangedFields commits per-field knowledge for the fields it sends.
            const changedFields = readChangedFields(node, traitSlot, instance, traitKnowledge, currentTick, playerId);
            if (changedFields !== null) {
                updates.push({
                    type: 'node_trait_fields',
                    id: node.id,
                    traitNetIndex: def.netIndex!,
                    fields: changedFields,
                });
            }
        }
    }

    // include unresolved traits in current set
    for (const [id] of node._unresolvedTraits ?? EMPTY_UNRESOLVED) {
        const traitKnowledge = known.unresolvedTraits?.get(id);
        if (!traitKnowledge) {
            updates.push({
                type: 'node_trait_added',
                id: node.id,
                traitNetIndex: undefined,
                traitId: id,
                fields: [],
                syncs: [],
            });
            (known.unresolvedTraits ??= new Map()).set(id, { id, behind: false, versions: [], lastSentTicks: [] });
        }
        // note: unresolved traits can't change in-place (no live instance),
        // so we don't need to check version diffs for them
    }

    // removed traits, wire-compressed to the net index; the id is only put on the wire for
    // a trait that left the registry between snapshot and now (rare HMR edge), which is why
    // the knowledge carries it.
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
            if (node._unresolvedTraits?.has(traitId) === true) continue;
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

    // if any field was rate-throttled, keep nodeVersion stale so the node is re-checked
    // next tick. `readChangedFields` already knows which those are; it used to be
    // re-derived by walking every trait and field a second time.
    let allFieldsCurrent = true;
    for (let traitSlot = 0; traitSlot < known.traits.length; traitSlot++) {
        if (known.traits[traitSlot]?.behind === true) {
            allFieldsCurrent = false;
            break;
        }
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
    const childIndex = childIndexOf(node);

    const traits: Array<TraitKnowledge | undefined> = [];
    let unresolvedTraits: Map<string, TraitKnowledge> | null = null;
    const nodeTraits = node._traits;
    for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
        const instance = nodeTraits[traitSlot];
        if (instance === undefined) continue;
        const def = registry.slotToTrait[traitSlot];
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

        traits[traitSlot] = { id: def.id, behind: false, versions, lastSentTicks };
    }
    // include unresolved traits so the diff system knows we already sent them
    for (const id of node._unresolvedTraits?.keys() ?? []) {
        (unresolvedTraits ??= new Map()).set(id, { id, behind: false, versions: [], lastSentTicks: [] });
    }

    nodeKnowledge.set(node.id, {
        nodeVersion: node._sync.version,
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
// design mirrors minecraft's approach, at REGION granularity (a region is a
// REGION_CHUNKS_PER_AXIS³ cube of chunks, the AOI/streaming unit — see voxels.ts,
// and matches minecraft's real bundling unit: their "chunk" is actually a whole
// XZ column, sent as one packet regardless of how many of its vertical sections
// are occupied vs air — our region is the equivalent unit):
//   - spherical expansion order over regions (closest regions first). deciding
//     "is this region in range" is an unbudgeted O(1) voxels.regions lookup, no
//     per-tick cap needed for that (see flushVoxelsForPlayer) — only the actual
//     SHIP (dispatchRegionFull, which reads + compresses real chunk data) is
//     rate-limited, by each client's self-reported decode rate
//     (fullRegionsPerTick, see handleVoxelAck) instead of a fixed constant
//   - a newly-discovered region ships as ONE voxel_region_full: a presence
//     bitmask (which of the region's REGION_VOLUME chunk slots are occupied)
//     plus a dense list of only the occupied chunks' payloads, no per-chunk
//     coordinates at all — mirrors how minecraft's light packet marks empty vs
//     present sections via a bitset instead of naming positions
//   - coalesced ops (dedup by voxel index, keep last value)
//   - promotion threshold (too many ops in an already-known chunk → re-send as
//     an individual voxel_chunk_full, its own small fixed-rate channel — a
//     mid-session refresh of one already-discovered chunk isn't a discovery
//     event, so it doesn't fit the region-bundling shape and doesn't need
//     adaptive pacing: it's bounded by edit activity, not exploration bursts)
//   - light epoch for full-recompute detection

/** default (and seed value, before any ack has landed) for a client's
 *  voxel_region_full budget per tick; also anchors dispatchRegionFull's
 *  globalCap formula (a representative per-client share, not the actual
 *  adaptive one — see the `resolveClientCap` param on dispatchChannel). the
 *  ACTUAL per-client ceiling used for the "how many regions can THIS player
 *  receive this tick" check is each client's own `fullRegionsPerTick`,
 *  self-reported via voxel_ack (`desiredRegionsPerTick`, see
 *  client/voxel-pacing.ts) and adopted in handleVoxelAck — mirrors Minecraft's
 *  ChunkBatchSizeCalculator: the client measures its own decode wall-clock and
 *  reports a rate, the server applies it directly with no further smoothing. */
const DEFAULT_REGIONS_PER_TICK = 1;

/** max regions in flight (shipped as voxel_region_full, awaiting voxel_ack) per
 *  client. the in-flight window: dispatchRegionFull won't ship past this until
 *  acks free slots, so a decode-bound client throttles the server. */
const MAX_IN_FLIGHT_REGIONS = 4;

/** max voxel_chunk_full messages per client per tick for the PROMOTION channel
 *  (an already-known chunk re-sent after too many block-ops; see the
 *  block-ops section of flushVoxelsForPlayer). fixed, not adaptive — unlike
 *  region discovery this isn't a bursty exploration event, it's bounded by
 *  edit activity, so a small constant is enough. */
const FULL_CHUNKS_PER_CLIENT_PER_TICK = 6;

/** max promotion chunks in flight (shipped as an individual voxel_chunk_full,
 *  awaiting voxel_ack) per client. same in-flight-window backpressure idea as
 *  MAX_IN_FLIGHT_REGIONS, scoped to the promotion channel. */
const MAX_IN_FLIGHT_FULL = 24;

/** fallback stream radius in chunks when the player node has no PlayerTrait
 *  (shouldn't happen in practice, createPlayerNode always adds it, but
 *  guards the flush against a partially-constructed scene). also the floor:
 *  a client can request more but never shrink below this. */
const DEFAULT_VIEW_RADIUS = 8;

/** clamp bounds (chunks) for the client-requested stream radius
 *  (PlayerTrait.viewRadius, owner-authoritative). one ceiling for every room
 *  mode — play and edit clients used to have separate caps (16 vs 24), killed
 *  in favor of a single cap; a play client still won't request past what its
 *  perf tier picks (`Performance.streamChunkRadius`), this just stops the
 *  server from paternalistically clamping a play client below what edit
 *  clients were always allowed. */
const MIN_STREAM_RADIUS = 8;
const MAX_STREAM_RADIUS = 24;

/** resolve a player's clamped voxel stream radius (chunks) from its
 *  owner-authoritative `PlayerTrait.viewRadius`, falling back to the default
 *  if the node/trait is somehow missing. also feeds `flushEntityPresenceForPlayer`'s
 *  region radius, so entity AOI stays roughly matched to how far terrain streams. */
function resolveStreamRadius(playerNode: Node | undefined): number {
    const playerTrait = playerNode ? getTrait(playerNode, PlayerTrait) : null;
    const requestedRadius = playerTrait?.viewRadius ?? DEFAULT_VIEW_RADIUS;
    return Math.max(MIN_STREAM_RADIUS, Math.min(requestedRadius, MAX_STREAM_RADIUS));
}

/** hysteresis band (chunks) added to the stream radius to compute the eviction
 *  radius. chunks in (streamRadius, streamRadius + RETENTION_MARGIN] stay
 *  resident on the client and keep receiving ops (kept fresh); only chunks
 *  beyond the band are evicted (voxel_chunk_del). prevents thrash at the load
 *  frontier and makes wandering out and back within the band a free re-render
 *  with no re-download.
 *
 *  tried widening 6 -> 18 (2025-08-24 perf investigation), measured a regression:
 *  the OLD chunkInRegion() gated PROP/ENTITY presence off this same
 *  knownChunks/knownEmptyChunks set, so a wider margin inflated entity AOI as a
 *  side effect, not just voxel residency. entity presence is now decoupled
 *  (`ClientEntityPresence`, region-keyed, no read of voxel knowledge at all), so
 *  this margin is voxel-residency-only again; the historical finding is kept here
 *  as a reminder of why the coupling existed, not as a live restriction. */
const RETENTION_MARGIN = 6;

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

/** called on hot reload, reset all voxel + entity-presence knowledge so chunks and
 *  transform-root subtrees re-stream. */
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

/** clamp bounds for the client-reported adaptive region rate
 *  (`VoxelAck.desiredRegionsPerTick`, see client/voxel-pacing.ts). the ceiling
 *  matches MAX_IN_FLIGHT_REGIONS — no point admitting more per tick than the
 *  in-flight window would immediately stall on anyway. the floor keeps a very
 *  slow client making forward progress instead of stalling at 0. */
const MIN_ADAPTIVE_REGION_CAP = 1;
const MAX_ADAPTIVE_REGION_CAP = MAX_IN_FLIGHT_REGIONS;

/** apply a client's voxel_ack: free the in-flight slots for the regions and
 *  (promotion) chunks it has decoded + applied, letting dispatchRegionFull /
 *  dispatchFull ship more, and adopt its reported adaptive pacing rate for
 *  future dispatchRegionFull budgeting. lookup by (client, playerId) is
 *  inherently scoped, a client's voxelKnowledge only holds its own players,
 *  and unknown keys (already evicted / re-sent / promoted) are ignored, so a
 *  stale or spoofed ack is a harmless no-op. a non-finite rate
 *  (malformed/malicious client) is ignored, keeping the last known-good value,
 *  rather than corrupting fullRegionsPerTick into a NaN that would compare
 *  false against everything and grant that client unbounded dispatch.
 *
 *  the FIRST ack that actually confirms a region (message.regions non-empty)
 *  lifts maxInFlightRegions from its conservative join-time seed (1) to the
 *  full MAX_IN_FLIGHT_REGIONS ceiling — mirrors Minecraft's
 *  PlayerChunkSender.onChunkBatchReceivedByClient bumping
 *  maxUnacknowledgedBatches 1 -> 10 the same way. unconditional (not "only if
 *  still 1") is fine, same as MC's: setting the same value repeatedly is a
 *  harmless no-op once ramped. */
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

/* ── compressed snapshot caching ── */

/** get or build the compressed snapshot for a chunk. caches on the chunk.
 *  the wire palette is per-slot global state ids (registry-shared identity),
 *  not the per-chunk strings — `chunk.palette` is already that mapping. */
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
    // slot → global state id, for translating each coalesced slot into the
    // registry-shared id the wire carries. by reference; the live palette is
    // append-only so slot→id stays stable through the tick.
    palette: number[];
    changes: Map<number, number>; // index → local slot (last wins)
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

/* ── entity/prop presence (region-tied node AOI) ── */

/**
 * recompute `presence.knownRegions` from scratch when the player's anchor has
 * crossed into a new region, no-op otherwise (mirrors voxel's anchor-cross gate,
 * see `flushVoxelsForPlayer`). unlike voxel streaming this has no per-tick budget:
 * entity presence carries no payload to prepare, just a membership test, so a full
 * sphere of region keys (radius derived from the same `streamRadius` +
 * `RETENTION_MARGIN` voxel streaming uses, converted to region units) is cheap to
 * regenerate outright rather than amortized across ticks with a cursor.
 */
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
        return; // still in the same region, knownRegions (and the sphere it describes) is unchanged
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

    // per-player phase: discovery/eviction → pendingRegions, ops (+ promotion
    // → pendingFull), and absorb newly-dirty light chunks into each client's
    // pendingLight set. nothing is shipped for region/full/light yet, dispatch
    // happens room-wide below.
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

    // room-wide dispatch after every player has discovered + absorbed.
    // dispatchRegionFull (discovery) and dispatchFull (promotion) both run
    // before dispatchLight and return the chunks they shipped this tick: those
    // payloads carry fresh light, so dispatchLight clears their masks (and
    // skips them, they were still in pendingRegions/pendingFull, not
    // knownChunks, when the per-player light-absorb ran).
    const regionShippedChunks = dispatchRegionFull(state, room, voxels, players, out);
    const fullShippedChunks = dispatchFull(state, room, voxels, players, out);
    for (const chunk of regionShippedChunks) fullShippedChunks.add(chunk);
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
 * room-wide chunk_full dispatch — the PROMOTION channel only (an
 * already-known chunk re-sent after too many block-ops; region discovery
 * ships via dispatchRegionFull instead). drains each player's pendingFull
 * nearest-first, at a fixed (non-adaptive) rate: promotion volume is bounded
 * by edit activity, not exploration bursts, so it doesn't need the region
 * channel's client-reported pacing. returns the chunks shipped, handed to
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

/**
 * room-wide voxel_region_full dispatch — the DISCOVERY channel. drains each
 * player's pendingRegions (filled by the unbudgeted discovery recompute in
 * flushVoxelsForPlayer) nearest-first, under a per-client cap that adapts to
 * that client's self-reported decode rate (fullRegionsPerTick, see
 * handleVoxelAck) + a global cap (same luanti-style shape as dispatchChannel,
 * anchored to DEFAULT_REGIONS_PER_TICK as a representative share) + an
 * in-flight window (inFlightRegions/MAX_IN_FLIGHT_REGIONS).
 *
 * shipping a region assembles ONE voxel_region_full: walk the region's
 * REGION_VOLUME local chunk slots in the shared, fixed REGION_LOCAL_CHUNK_OFFSETS
 * order, building a presence bitmask + a dense list of only the occupied
 * slots' compressed payloads — no per-chunk coordinates on the wire, mirrors
 * how minecraft's light packet marks empty vs present sections via a bitset
 * instead of naming positions. marks all REGION_VOLUME slots known
 * (knownChunks/knownEmptyChunks/knownRegions) in one shot. returns the
 * occupied chunks shipped, handed to dispatchLight (merged with dispatchFull's
 * return) so their light masks get cleared the same way.
 *
 * a bespoke loop rather than dispatchChannel: a region "candidate" isn't one
 * chunk lookup, it's an assembly of up to REGION_VOLUME of them plus a
 * bitmask, which doesn't fit dispatchChannel's one-key-one-ship shape.
 */
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

/** file/unfile a chunk into `knowledge.knownRegions`'s per-region bucket. call
 *  alongside every `knownChunks`/`knownEmptyChunks` add/remove so the secondary
 *  region index (used by eviction, see below) never drifts — mirrors how
 *  `voxels.ts` keeps `chunks` and `regions` in sync via `ensureChunk`/`removeChunk`. */
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

/**
 * sweep this player's known REGIONS and evict any whose region coord is outside
 * the `evictRegionRadius` sphere centered at `(prx,pry,prz)`. emits ONE
 * voxel_region_del per evicted region (the client already knows exactly which
 * chunks it holds there, so no per-chunk coordinate list is needed — mirrors
 * voxel_region_full's bundling). also drops any not-yet-shipped region from
 * pendingRegions, and any promotion-pending chunk from pendingFull, that
 * drifted out of range.
 *
 * called only on region-coord transitions in flushVoxelsForPlayer. walks
 * `knowledge.knownRegions` — bounded by how many REGIONS are in view, not how
 * many individual chunks are known — so a client discovered out to edit-radius
 * scale (~58k chunks, previously the dominant cost of this function) now walks
 * at most a few hundred region entries here; only regions that actually left
 * range pay the (bounded, ≤ REGION_VOLUME) cost of enumerating their chunks.
 */
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
            // in-flight keys (promotion re-sends) are a subset of knownChunks;
            // drop the slot. a late ack for an evicted chunk hits an unknown
            // key and is ignored.
            knowledge.inFlightFull.delete(key);
        }
        knowledge.knownRegions.delete(regionK);
        // in case this region had just shipped and was still awaiting its ack.
        knowledge.inFlightRegions.delete(regionK);
    }

    // pendingRegions entries haven't shipped yet, drop any that drifted out of
    // range before dispatchRegionFull got to them (no del: the client never
    // received them).
    for (const [regionK, { rx, ry, rz }] of [...knowledge.pendingRegions]) {
        const dx = rx - prx;
        const dy = ry - pry;
        const dz = rz - prz;
        if (dx * dx + dy * dy + dz * dz <= r2) continue;
        knowledge.pendingRegions.delete(regionK);
    }

    // pendingFull (promotion) entries are mid-resend, not fresh discovery;
    // drop any that drifted out of range before dispatchFull got to them.
    // stays a flat scan: bounded by FULL_CHUNKS_PER_CLIENT_PER_TICK-ish
    // volume, small enough that region-indexing it isn't worth it.
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

    // 0. light epoch check, if server did a full recompute, reset client
    //    knowledge and force a fresh discovery recompute below (even if the
    //    anchor hasn't moved) so every region re-ships with correct light.
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

    // 1. anchor cross (or a forced reset above): evict out-of-range regions,
    //    then an unbudgeted full recompute of which regions are newly in range.
    //    deciding "is this region in range" is one integer distance test — cheap
    //    enough to redo the whole sphere every anchor cross, no cursor/backlog
    //    budget needed (unlike the old per-chunk walk this replaced). only the
    //    actual SHIP (dispatchRegionFull, which reads + compresses real chunk
    //    data) is rate-limited, by each client's adaptive fullRegionsPerTick.
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

    // 2. addedChunks: a chunk created this tick. if it lands inside an
    //    ALREADY-SHIPPED region, that region's client-side copy is stale for
    //    this one slot — patch it via the individual promotion-style channel
    //    (pendingFull) rather than re-shipping the whole region. a chunk inside
    //    a still-pending region needs no action here: dispatchRegionFull reads
    //    live voxels.chunks at ship time, so it sees the fresh data naturally.
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

    // 3. block ops, coalesce and send for known chunks
    if (changes.ops.length > 0) {
        const blockChanges = coalesceBlockOps(changes.ops, knowledge.knownChunks, voxels.chunks);

        // promote chunks with too many block changes to a chunk_full re-send:
        // drop from knownChunks (+ its region-index entry + any queued light) and
        // re-queue directly into pendingFull so dispatchFull re-ships the whole
        // chunk. no cursor rewind needed, the chunk is back in the dispatch queue,
        // and the pendingFull guard in the walk keeps re-discovery from duplicating
        // it. the region stays filed (still "known" overall, just one chunk mid-resend).
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
