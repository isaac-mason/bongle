import type { Client } from '@bongle/interface';
import { PlayerTrait } from '../builtins/player';
import { TransformTrait } from '../builtins/transform';
import { registry } from '../core/registry';
import type { PlayerId } from '../core/client';
import type { BinaryField, RoomInfo, RoomMode, SceneSyncUpdate, ServerMessage } from '../core/protocol';
import type { Resources } from '../core/resources';
import {
    bumpFieldVersion,
    encodePrefabConfig,
    getNodeById,
    getNodeVersionInfo,
    getTrait,
    isReplicable,
    type Node,
    type Nodes,
    type Realm,
} from '../core/scene/nodes';
import { getControlCodecs, getSyncCodecs } from '../core/scene/packcat-bridge';
import { packSceneGraph } from '../core/scene/scene-pack';
import * as SyncRate from '../core/scene/sync/sync-rate';
import type { TraitBase, TraitDef } from '../core/scene/traits';
import { getWorldPosition } from '../builtins/transform';
import { bytesEqual } from '../core/utils/bytes';
import { encodeChunk, encodeLight } from '../core/voxels/chunk-codec';
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
 * per-node, per-field binary snapshots for diff detection.
 * keyed by node → (snapshot key → last packed bytes).
 * snapshot keys: `${traitSlot}:${fieldName}` for each replicable field.
 */
export type DiffSnapshots = Map<Node, Map<string, Uint8Array>>;

export function createDiffSnapshots(): DiffSnapshots {
    return new Map();
}

/**
 * run diff detection on a scene graph. compares current trait field values
 * against cached binary snapshots. when a difference is found, bumps
 * the trait and node versions and updates the snapshot.
 *
 * diffs both property and sync fields regardless of mode — scripts can
 * mutate either kind of field at any time.
 *
 * call once per tick, after scripts have run.
 */
export function runDiffDetection(sg: Nodes, snapshots: DiffSnapshots): void {
    for (const node of sg.nodes) {
        diffNode(sg, snapshots, node);
    }

    // clean up snapshots for nodes that no longer exist
    for (const node of snapshots.keys()) {
        if (!sg.nodes.has(node)) {
            snapshots.delete(node);
        }
    }
}

function diffNode(sg: Nodes, snapshots: DiffSnapshots, node: Node): void {
    let nodeSnapshots: Map<string, Uint8Array> | undefined;

    for (const [traitSlot, instance] of node._traits) {
        const def = registry.traitsBySlot.get(traitSlot);
        if (!def) continue;

        const codecs = getSyncCodecs(def);
        if (!codecs) continue;

        if (!nodeSnapshots) {
            nodeSnapshots = snapshots.get(node);
            if (!nodeSnapshots) {
                nodeSnapshots = new Map();
                snapshots.set(node, nodeSnapshots);
            }
        }

        // dirty fast path: read+clear sync-dirty bits before byte-diffing.
        const dirtyBits = (instance as TraitBase & { _syncDirty?: Uint32Array })._syncDirty;

        for (let i = 0; i < codecs.length; i++) {
            const codec = codecs[i];
            const key = `${traitSlot}:${i}`;

            if (dirtyBits) {
                const word = i >> 5;
                const bit = 1 << (i & 31);
                if ((dirtyBits[word] & bit) !== 0) {
                    dirtyBits[word] &= ~bit;
                    const bytes = codec.pack(instance, node);
                    nodeSnapshots.set(key, bytes);
                    bumpFieldVersion(sg, node, traitSlot, String(i));
                    continue;
                }
            }

            // 'dirty' rate skips cold-path byte-diff entirely — only
            // SyncHandle.dirty() above can flag emission.
            if (def.sync[i].rate === 'dirty') continue;

            // cold path: byte-diff against snapshot.
            const current = codec.pack(instance, node);
            const previous = nodeSnapshots.get(key);

            if (!previous) {
                nodeSnapshots.set(key, current);
                continue;
            }

            if (!bytesEqual(current, previous)) {
                nodeSnapshots.set(key, current);
                bumpFieldVersion(sg, node, traitSlot, String(i));
            }
        }
    }

    // clean up snapshots for traits that have been removed from this node
    nodeSnapshots = snapshots.get(node);
    if (nodeSnapshots) {
        for (const key of nodeSnapshots.keys()) {
            const traitSlot = Number.parseInt(key, 10);
            if (!node._traits.has(traitSlot)) {
                nodeSnapshots.delete(key);
            }
        }
    }
}

/* ── per-client knowledge tracking ── */

type TraitKnowledge = {
    version: number;
    /** per-field knowledge, keyed by "${traitSlot}:${fieldName}" */
    fieldVersions: Map<string, FieldKnowledge>;
};

type FieldKnowledge = {
    version: number;
    /** last tick this field was sent to this client (for per-field rate gating) */
    lastSentTick: number;
};

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
    /** chunks announced as empty via voxel_chunk_empty — client holds an
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
};

/* ── per-client scene graph knowledge ── */

type ClientState = {
    /**
     * per-Player, per-node knowledge. outer key is PlayerId, inner key is
     * node id. Mode-aware: an edit-Player tracks server-only and edit-only
     * nodes that a play-Player in the same room would not. A Player entry
     * exists once the client has received join_room for that Player.
     */
    playerKnowledge: Map<PlayerId, Map<number, ClientNodeKnowledge>>;

    /** Players that have received their join_room (and therefore have a
     *  populated playerKnowledge entry). */
    knownPlayers: Set<PlayerId>;

    /** last room list version this client received (-1 = never). */
    roomListVersion: number;

    /**
     * per-Player voxel chunk knowledge. key is PlayerId. Each Player has
     * its own streaming anchor (its player node's chunk coord) and its own
     * known-chunks set, so views stay isolated — particularly important
     * when a client holds two Players in the same room (e.g. dev edit
     * camera + dev play character) whose positions diverge.
     */
    voxelKnowledge: Map<PlayerId, ClientVoxelKnowledge>;

    /**
     * Set of runtime-source model ids this client has been told about via
     * `register_model`. Drives a per-tick diff against
     * `resources.models` — new entries → `register_model`, vanished
     * entries → `unregister_model`. Bundled entries never enter this set;
     * they ship with the engine build on both sides.
     */
    knownModels: Set<string>;
};

/* ── discovery state ── */

export type Discovery = {
    /** monotonic version bumped whenever the room list changes. */
    roomListVersion: number;

    /** per-client tracking. */
    clients: Map<Client, ClientState>;

    /** per-room diff snapshots for change detection. */
    diffSnapshots: Map<string, DiffSnapshots>;
};

export function init(): Discovery {
    return {
        roomListVersion: 0,
        clients: new Map(),
        diffSnapshots: new Map(),
    };
}

/* ── client lifecycle ── */

export function addClient(state: Discovery, client: Client): void {
    state.clients.set(client, {
        playerKnowledge: new Map(),
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
 * Call when a Player is allocated (or its scene is structurally invalidated
 * — e.g. a hot-reload or scene rebuild). Synchronously emits a join_room
 * for this Player on the per-client outbox and re-snapshots per-Player
 * knowledge against current scene state. Initializes fresh voxel knowledge
 * for the Player so its chunk view streams from scratch.
 *
 * Synchronous emission means call order = wire order: a script doing
 * `Net.send(rpc1); addClientToRoom(...); Net.send(rpc2)` produces
 * `[rpc1, join_room, rpc2]` in the outbox. End-of-tick batching applies
 * only to scene_sync (which needs diff detection over the full tick).
 */
export function invalidatePlayer(
    state: Discovery,
    net: ServerNet,
    rooms: Rooms,
    resources: Resources,
    player: Player,
): void {
    const cs = state.clients.get(player.client);
    if (!cs) return;

    const room = RoomsModule.getRoom(rooms, player.roomId);
    if (!room) return;

    // (re-)initialize per-Player knowledge against the current scene
    const nodeKnowledge = new Map<number, ClientNodeKnowledge>();
    cs.playerKnowledge.set(player.id, nodeKnowledge);
    cs.knownPlayers.add(player.id);

    cs.voxelKnowledge.set(player.id, {
        knownChunks: new Set(),
        knownEmptyChunks: new Set(),
        knownLightEpoch: 0,
        lastAnchor: null,
        cursor: 0,
        pendingLight: new Set(),
    });

    // Catch this client up on any runtime model entries that exist now —
    // emit synchronously so they precede `join_room` on the outbox. The
    // packed scene may reference these modelIds via trait fields; the
    // client's `ensureModel` needs a URL entry in hand when it tries to
    // load. Mirrors the `wire_table` pattern above.
    for (const msg of computeModelRegistrations(cs, resources)) {
        Net.send(net, player.client, msg);
    }

    const packT0 = performance.now();
    const packedNodes = packSceneGraph(room.nodes, player.mode);
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
        isNamespaceRoot: room.isNamespaceRoot,
    });

    // snapshot every node so the same-tick scene_sync diff finds no changes
    const snapT0 = performance.now();
    snapshotAllNodeKnowledge(room.nodes, nodeKnowledge, player.mode);
    const snapMs = performance.now() - snapT0;
    console.log(
        `[room-start]     invalidatePlayer packSceneGraph=${packMs.toFixed(1)} ` +
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

    cs.playerKnowledge.delete(player.id);
    cs.knownPlayers.delete(player.id);
    cs.voxelKnowledge.delete(player.id);

    Net.send(net, player.client, { type: 'room_left', playerId: player.id });
}

/* ── runtime model registration diff ── */

/**
 * Diff `resources.models` (runtime entries only) against this client's
 * `knownModels` set. Returns the messages to bring the client into sync;
 * mutates `knownModels` to match the new state so the caller doesn't have
 * to. Bundled entries are skipped — both sides ship them with their build.
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
 * Stamps every Player the client holds in the room — the mutation came
 * from the client connection, so all of that client's views into the
 * room should suppress the echo.
 */
export function stampNodeKnowledge(
    state: Discovery,
    rooms: Rooms,
    client: Client,
    roomId: string,
    sg: Nodes,
    nodeId: number,
): void {
    const cs = state.clients.get(client);
    if (!cs) return;
    const node = getNodeById(sg, nodeId);
    if (!node) return;
    for (const player of RoomsModule.getPlayersForClient(rooms, client)) {
        if (player.roomId !== roomId) continue;
        const nodeKnowledge = cs.playerKnowledge.get(player.id);
        if (!nodeKnowledge) continue;
        snapshotNodeKnowledge(sg, nodeKnowledge, node);
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
        const nodeKnowledge = cs.playerKnowledge.get(player.id);
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
    sg: Nodes,
    node: Node,
    def: TraitDef,
    instance: TraitBase,
    fields: BinaryField[],
    mode: RoomMode,
): void {
    // play mode: only accept owner fields for replicable nodes. non-shared
    // nodes aren't synced to other clients, so an owner-authority write
    // would silently never reach anyone — reject loudly instead.
    if (mode === 'play' && !isReplicable(node)) return;

    const codecs = getSyncCodecs(def);
    if (!codecs) return;

    // get or create diff snapshots for this room + node
    let roomSnapshots = state.diffSnapshots.get(roomId);
    if (!roomSnapshots) {
        roomSnapshots = createDiffSnapshots();
        state.diffSnapshots.set(roomId, roomSnapshots);
    }
    let nodeSnapshots = roomSnapshots.get(node);
    if (!nodeSnapshots) {
        nodeSnapshots = new Map();
        roomSnapshots.set(node, nodeSnapshots);
    }

    // collect every Player the client holds in this room — we stamp all of
    // their knowledge so none echo this owner-authority write back.
    const cs = state.clients.get(client);
    const targetPlayers: Player[] = cs ? RoomsModule.getPlayersForClient(rooms, client).filter((p) => p.roomId === roomId) : [];

    for (const entry of fields) {
        const i = entry.index;
        const codec = codecs[i];
        if (!codec) continue;
        const syncDef = def.sync[i];
        if (syncDef.authority !== 'owner') continue;

        // 1. apply value to the trait instance. codec.apply clears the
        //    sync-dirty bit so the next diffNode pass doesn't re-pack from
        //    the same write and double-bump.
        codec.apply(entry.data, instance);

        // 2. update diff snapshot to the just-applied bytes so the byte-diff
        //    in diffNode sees no change and doesn't re-bump.
        const snapshotKey = `${def.slot}:${i}`;
        const freshBytes = codec.pack(instance, node);
        nodeSnapshots.set(snapshotKey, freshBytes);

        // 3. bump the field version once, here. broadcasts to non-owners
        //    via the per-client knowledge diff in buildSceneSyncUpdates;
        //    the owner is exempted by stamping their knowledge to the
        //    post-bump version below (step 4) so they don't echo it back.
        bumpFieldVersion(sg, node, def.slot, String(i));

        // 4. stamp every Player the owner client holds in this room to the
        //    post-bump version so this owner-authority write doesn't echo
        //    back to the sender.
        if (!cs) continue;
        const vInfo = getNodeVersionInfo(sg, node);
        const fieldVersion = vInfo?.fieldVersions.get(snapshotKey) ?? 0;
        for (const player of targetPlayers) {
            const nodeKnowledge = cs.playerKnowledge.get(player.id);
            const known = nodeKnowledge?.get(node.id);
            if (!known) continue;
            let traitKnowledge = known.traits.get(def.id);
            if (!traitKnowledge) {
                traitKnowledge = { version: 0, fieldVersions: new Map() };
                known.traits.set(def.id, traitKnowledge);
            }
            traitKnowledge.fieldVersions.set(snapshotKey, {
                version: fieldVersion,
                lastSentTick: traitKnowledge.fieldVersions.get(snapshotKey)?.lastSentTick ?? 0,
            });
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
): Array<[Client, ServerMessage]> {
    const out: Array<[Client, ServerMessage]> = [];

    // --- phase 1: diff detection (per-room, serialize once) ---
    for (const room of rooms.rooms.values()) {
        let snapshots = state.diffSnapshots.get(room.id);
        if (!snapshots) {
            snapshots = createDiffSnapshots();
            state.diffSnapshots.set(room.id, snapshots);
        }
        runDiffDetection(room.nodes, snapshots);
    }

    // --- phase 2: per-client knowledge diff + message generation ---

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
                    isNamespaceRoot: room.isNamespaceRoot,
                });
            }
            roomListJson = JSON.stringify(infos);
        }
        return roomListJson;
    };

    for (const [client, cs] of state.clients) {
        // runtime model registrations — diff `resources.models` against
        // per-client knowledge. Push BEFORE scene_sync so any new trait
        // field carrying a freshly-registered modelId can resolve to a URL
        // entry on the client by the time the field lands.
        for (const msg of computeModelRegistrations(cs, resources)) {
            out.push([client, msg]);
        }

        // incremental scene sync — per-Player, mode-aware
        for (const player of RoomsModule.getPlayersForClient(rooms, client)) {
            if (!cs.knownPlayers.has(player.id)) continue;

            const room = RoomsModule.getRoom(rooms, player.roomId);
            if (!room) continue;

            const nodeKnowledge = cs.playerKnowledge.get(player.id);
            if (!nodeKnowledge) continue;

            const snapshots = state.diffSnapshots.get(player.roomId);
            const updates = buildSceneSyncUpdates(room.nodes, nodeKnowledge, snapshots, room.tick, player.mode);
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

    // clean up diff snapshots for rooms that no longer exist
    for (const roomId of state.diffSnapshots.keys()) {
        if (!rooms.rooms.has(roomId)) {
            state.diffSnapshots.delete(roomId);
        }
    }
    // --- phase 3: voxel chunk streaming ---
    for (const room of rooms.rooms.values()) {
        const auth = room.voxels.authority;
        if (!auth) continue;
        flushVoxelsForRoom(state, rooms, room, out);
        clearVoxelChanges(auth.changes);
        // clear lightDirty flags after all clients have absorbed into their
        // per-client pendingLight queues. compressedLight stays cached across
        // ticks — writeChunkLight / markChunkDirty (light.ts) null it on the
        // next actual change. dirty.light is reset so next tick starts empty.
        // mask + count are NOT cleared here — dispatchLight already cleared
        // them for shipped chunks; unshipped (cap-exhausted) chunks keep
        // their accumulated delta info for next tick.
        for (const chunk of room.voxels.dirty.light) {
            chunk.lightDirty = false;
        }
        room.voxels.dirty.light.clear();
    }

    return out;
}

/* ── scene sync generation ── */

/**
 * build incremental SceneSync updates for a single client's knowledge
 * of a single room, based on what they know vs what the scene graph
 * currently looks like. reads pre-serialized trait bytes from diff
 * snapshots to avoid redundant serialization across clients.
 */
function buildSceneSyncUpdates(
    sg: Nodes,
    nodeKnowledge: Map<number, ClientNodeKnowledge>,
    snapshots: DiffSnapshots | undefined,
    currentTick: number,
    mode: RoomMode,
): SceneSyncUpdate[] {
    const updates: SceneSyncUpdate[] = [];

    // track which ids exist (and are replicable) in the current scene graph
    const livingIds = new Set<number>();

    // walk nodes in parent-first order so creates arrive before children.
    // in play mode prunes non-shared subtrees — those nodes are server- or
    // client-local and never replicated. edit mode walks everything.
    walkReplicable(sg.root, mode, 'shared', (node) => {
        livingIds.add(node.id);

        const known = nodeKnowledge.get(node.id);
        if (!known) {
            // client doesn't know about this node — send full create
            const update = buildNodeCreatedUpdate(node, snapshots, mode);
            updates.push(update);
            snapshotNodeKnowledge(sg, nodeKnowledge, node, currentTick);
        } else {
            // client knows this node — check for changes
            const vInfo = getNodeVersionInfo(sg, node);
            const currentVersion = vInfo?.version ?? 0;

            if (currentVersion > known.nodeVersion) {
                // per-field rate gating is handled inside diffNodeKnowledge —
                // no node-level gate here. diffNodeKnowledge updates knowledge in-place.
                diffNodeKnowledge(sg, node, known, updates, snapshots, mode, currentTick);
            }
        }
    });

    // nodes the client knows about that no longer exist (or stopped being
    // replicable) → destroy. covers both deletion and shared→non-shared
    // realm transitions.
    for (const id of nodeKnowledge.keys()) {
        if (!livingIds.has(id)) {
            updates.push({ type: 'node_destroyed', id });
            nodeKnowledge.delete(id);
        }
    }

    return updates;
}

/**
 * walk a node tree in parent-first (pre-order) order. in play mode prunes
 * subtrees whose effective realm isn't `'shared'`. `inheritedRealm` is the
 * effective realm of the parent (root callers pass `'shared'`); `'inherit'`
 * nodes resolve to that value. iterative — no recursion, no stack growth on
 * deep trees.
 */
function walkReplicable(node: Node, mode: RoomMode, inheritedRealm: Realm, callback: (node: Node) => void): void {
    const stack: Array<{ node: Node; inherited: Realm }> = [{ node, inherited: inheritedRealm }];
    while (stack.length > 0) {
        const { node: cur, inherited } = stack.pop()!;
        const effective = cur.realm === 'inherit' ? inherited : cur.realm;
        if (mode === 'play' && effective !== 'shared') continue;
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
 * packs fresh — diff snapshots are sync-keyed, so they don't apply here.
 */
function readAllFields(
    node: Node,
    traitSlot: number,
    instance: TraitBase,
    _snapshots: DiffSnapshots | undefined,
): BinaryField[] {
    const def = registry.traitsBySlot.get(traitSlot);
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
 * receiver — pairs with readAllFields (controls).
 */
function readAllSyncs(node: Node, traitSlot: number, instance: TraitBase): BinaryField[] {
    const def = registry.traitsBySlot.get(traitSlot);
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
    snapshots: DiffSnapshots | undefined,
    knownFieldVersions: Map<string, FieldKnowledge>,
    currentFieldVersions: Map<string, number>,
    currentTick: number,
    sentFieldKeys: string[],
): BinaryField[] {
    const def = registry.traitsBySlot.get(traitSlot);
    if (!def) return [];

    const codecs = getSyncCodecs(def);
    if (!codecs) return [];

    const nodeSnaps = snapshots?.get(node);
    const entries: BinaryField[] = [];

    for (let i = 0; i < codecs.length; i++) {
        const key = `${traitSlot}:${i}`;
        const fieldVersion = currentFieldVersions.get(key) ?? 0;
        const knownFk = knownFieldVersions.get(key);
        const knownVersion = knownFk?.version ?? 0;

        if (fieldVersion <= knownVersion) continue;

        const syncDef = def.sync[i];
        const rate = SyncRate.resolveRate(syncDef.rate, node);
        if (rate !== null) {
            const lastSent = knownFk?.lastSentTick ?? 0;
            if (!SyncRate.shouldSendThisTick(rate, lastSent, currentTick, 60)) {
                continue;
            }
        }

        let data: Uint8Array | undefined;
        if (nodeSnaps) {
            data = nodeSnaps.get(key);
        }
        if (!data) {
            data = codecs[i].pack(instance, node);
        }

        entries.push({ index: i, data });
        sentFieldKeys.push(key);
    }

    return entries;
}

/** build a NodeCreated update from a live node with per-field binary entries. */
function buildNodeCreatedUpdate(
    node: Node,
    snapshots: DiffSnapshots | undefined,
    mode: RoomMode,
): SceneSyncUpdate {
    const parentId = node.parent?.id ?? 0;
    const index = node.parent ? node.parent.children.indexOf(node) : 0;

    const wireIndex = registry.traitWireIndex;
    const traits: Array<{ netIndex?: number; id?: string; fields: BinaryField[]; syncs: BinaryField[] }> = [];
    for (const [traitSlot, instance] of node._traits) {
        const def = registry.traitsBySlot.get(traitSlot);
        if (!def) continue;
        traits.push({
            netIndex: wireIndex.idToIndex.get(def.id),
            id: undefined,
            fields: readAllFields(node, traitSlot, instance, snapshots),
            syncs: readAllSyncs(node, traitSlot, instance),
        });
    }
    // include unresolved traits (no wire-index entry — fall back to string id)
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
    sg: Nodes,
    node: Node,
    known: ClientNodeKnowledge,
    updates: SceneSyncUpdate[],
    snapshots: DiffSnapshots | undefined,
    mode: RoomMode,
    currentTick: number,
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

    // trait changes — per-field granularity with per-field rate gating
    const vInfo = getNodeVersionInfo(sg, node);
    const currentTraitIds = new Set<string>();
    const wireIndex = registry.traitWireIndex;

    for (const [traitSlot, instance] of node._traits) {
        const def = registry.traitsBySlot.get(traitSlot);
        if (!def) continue;
        currentTraitIds.add(def.id);

        const traitKnowledge = known.traits.get(def.id);

        if (!traitKnowledge) {
            // new trait — send add with full state (controls + syncs, no rate gating)
            updates.push({
                type: 'node_trait_added',
                id: node.id,
                traitNetIndex: wireIndex.idToIndex.get(def.id),
                traitId: undefined,
                fields: readAllFields(node, traitSlot, instance, snapshots),
                syncs: readAllSyncs(node, traitSlot, instance),
            });

            // snapshot knowledge for this new trait
            const fieldVersions = new Map<string, FieldKnowledge>();
            if (vInfo) {
                for (let i = 0; i < def.sync.length; i++) {
                    const key = `${traitSlot}:${i}`;
                    const v = vInfo.fieldVersions.get(key) ?? 0;
                    fieldVersions.set(key, { version: v, lastSentTick: currentTick });
                }
            }
            known.traits.set(def.id, {
                version: vInfo?.traitVersions.get(traitSlot) ?? 0,
                fieldVersions,
            });
        } else {
            // existing trait — send only changed fields, with per-field rate gating
            const currentFieldVersions = vInfo?.fieldVersions ?? new Map<string, number>();
            const sentFieldKeys: string[] = [];
            const changedFields = readChangedFields(
                node,
                traitSlot,
                instance,
                snapshots,
                traitKnowledge.fieldVersions,
                currentFieldVersions,
                currentTick,
                sentFieldKeys,
            );
            if (changedFields.length > 0) {
                updates.push({
                    type: 'node_trait_fields',
                    id: node.id,
                    traitNetIndex: wireIndex.idToIndex.get(def.id)!,
                    fields: changedFields,
                });
            }

            // update knowledge for sent fields only
            for (const key of sentFieldKeys) {
                const currentVersion = currentFieldVersions.get(key) ?? 0;
                traitKnowledge.fieldVersions.set(key, { version: currentVersion, lastSentTick: currentTick });
            }
            traitKnowledge.version = vInfo?.traitVersions.get(traitSlot) ?? 0;
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
            known.traits.set(id, { version: 0, fieldVersions: new Map() });
        }
        // note: unresolved traits can't change in-place (no live instance),
        // so we don't need to check version diffs for them
    }

    // removed traits — wire-compress when the id still has a current
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

    // prefab config change — edit mode only
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

    // update node version — if any fields were throttled (not yet sent), keep nodeVersion
    // stale so the node is re-checked next tick. we detect this by comparing each trait's
    // field knowledge against the current field versions.
    let allFieldsCurrent = true;
    if (vInfo) {
        for (const [traitSlot] of node._traits) {
            const def = registry.traitsBySlot.get(traitSlot);
            if (!def) continue;
            const tk = known.traits.get(def.id);
            if (!tk) continue;
            for (let i = 0; i < def.sync.length; i++) {
                const key = `${traitSlot}:${i}`;
                const currentFv = vInfo.fieldVersions.get(key) ?? 0;
                const knownFk = tk.fieldVersions.get(key);
                if (currentFv > (knownFk?.version ?? 0)) {
                    allFieldsCurrent = false;
                    break;
                }
            }
            if (!allFieldsCurrent) break;
        }
    }
    if (allFieldsCurrent) {
        known.nodeVersion = vInfo?.version ?? 0;
    }
    // if not all fields are current, nodeVersion stays stale — the node will
    // be re-checked next tick and the throttled fields will be retried
}

/* ── knowledge snapshotting ── */

/** snapshot the current state of a node into a knowledge map. */
export function snapshotNodeKnowledge(
    sg: Nodes,
    nodeKnowledge: Map<number, ClientNodeKnowledge>,
    node: Node,
    currentTick = 0,
): void {
    const parentId = node.parent?.id ?? 0;
    const childIndex = node.parent ? node.parent.children.indexOf(node) : 0;
    const vInfo = getNodeVersionInfo(sg, node);

    const traits = new Map<string, TraitKnowledge>();
    for (const [traitSlot] of node._traits) {
        const def = registry.traitsBySlot.get(traitSlot);
        if (!def) continue;

        // snapshot per-sync versions for this trait
        const fieldVersions = new Map<string, FieldKnowledge>();
        if (vInfo) {
            for (let i = 0; i < def.sync.length; i++) {
                const key = `${traitSlot}:${i}`;
                const v = vInfo.fieldVersions.get(key);
                if (v !== undefined) fieldVersions.set(key, { version: v, lastSentTick: currentTick });
            }
        }

        traits.set(def.id, {
            version: vInfo?.traitVersions.get(traitSlot) ?? 0,
            fieldVersions,
        });
    }
    // include unresolved traits so the diff system knows we already sent them
    for (const id of node._unresolvedTraits.keys()) {
        if (!traits.has(id)) {
            traits.set(id, { version: 0, fieldVersions: new Map() });
        }
    }

    nodeKnowledge.set(node.id, {
        nodeVersion: vInfo?.version ?? 0,
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
 * snapshot every (replicable) node in the scene graph into a knowledge map.
 * in play mode skips non-shared subtrees — those are never replicated and
 * should not appear in client knowledge.
 */
function snapshotAllNodeKnowledge(
    sg: Nodes,
    nodeKnowledge: Map<number, ClientNodeKnowledge>,
    mode: RoomMode,
): void {
    // include root: it's sent to the client as part of the packed scene
    // at join_room, so we must mark it known. otherwise the next diff loop
    // will see no knowledge entry and emit a redundant node_created.
    // root traits/scripts still diff normally on subsequent flushes.
    walkReplicable(sg.root, mode, 'shared', (node) => {
        snapshotNodeKnowledge(sg, nodeKnowledge, node);
    });
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
//   - send all unknown chunks each tick (Map.get is cheap)
//   - view-radius culled chunk_full sends (up to CHUNKS_PER_TICK per tick)
//   - coalesced ops (dedup by voxel index, keep last value)
//   - promotion threshold (too many ops → re-send as chunk_full)
//   - light epoch for full-recompute detection

/** max chunk_full messages per client per tick */
const CHUNKS_PER_TICK = 2;

/** max empty-chunk announcements per client per tick. each entry is ~12
 *  bytes so we can be generous — empties race ahead of full chunks so the
 *  client establishes the "known air" frontier quickly. */
const EMPTY_CHUNKS_PER_TICK = 256;

/** fallback view radius in chunks when the player node has no PlayerTrait
 *  (shouldn't happen in practice — createPlayerNode always adds it — but
 *  guards the flush against a partially-constructed scene). */
const DEFAULT_VIEW_RADIUS = 8;

/** hysteresis band (chunks) added to viewRadius to compute the eviction
 *  radius. chunks in [viewRadius, viewRadius + VIEW_RADIUS_MARGIN] are kept if
 *  already known but not freshly loaded — prevents thrash when the player
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

/** virtual "max users" used in the global light cap formula — same shape
 *  as luanti's max_users knob, sets the global ceiling for small rooms.
 *  globalCap = (currentPlayers + ROOM_MAX_USERS) * per_client_cap / 4 + 1.
 *  with 1 player and the default per-client cap, globalCap >> per-client
 *  cap so a solo player is gated by the per-client cap only. as the room
 *  fills, the global cap grows mildly, keeping cross-client fairness. */
const ROOM_MAX_USERS = 8;

/* ── voxel knowledge reset ── */

/** called on hot reload — reset all voxel knowledge so chunks re-stream */
export function resetAllVoxelKnowledge(state: Discovery): void {
    for (const cs of state.clients.values()) {
        for (const k of cs.voxelKnowledge.values()) {
            k.knownChunks.clear();
            k.knownEmptyChunks.clear();
            k.knownLightEpoch = 0;
            k.cursor = 0;
            k.pendingLight.clear();
        }
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
function getCompressedSnapshot(chunk: Chunk): { compressed: Uint8Array; palette: string[] } {
    if (chunk.compressedSnapshot && chunk.snapshotPalette) {
        return { compressed: chunk.compressedSnapshot, palette: chunk.snapshotPalette };
    }
    const compressed = encodeChunk(chunk.data, chunk.light);
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
 * produce voxel messages for every Player in a room — each Player has its
 * own streaming anchor and chunk-knowledge set, so views stay isolated
 * (matters when a client holds two Players in the same room — e.g. a
 * dev's edit camera + their play character).
 */
function flushVoxelsForRoom(state: Discovery, rooms: Rooms, room: Room, out: Array<[Client, ServerMessage]>): void {
    const voxels = room.voxels;
    const auth = voxels.authority;
    if (!auth) return;
    const changes = auth.changes;

    // per-player phase: cursor walks, ops, and absorb newly-dirty light chunks
    // into each client's pendingLight set. nothing is sent for light yet —
    // dispatch happens room-wide below.
    // fullShippedChunks tracks chunks that shipped via voxel_chunk_full to any
    // player this tick. those payloads carry the full light array, so any bits
    // in the chunk's lightDirtyMask are already known to the receivers — we
    // clear those masks at the end of dispatchLight to avoid re-shipping them
    // as redundant deltas next tick.
    const players: Player[] = [];
    const fullShippedChunks = new Set<Chunk>();
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
            };
            cs.voxelKnowledge.set(player.id, knowledge);
        }

        flushVoxelsForPlayer(room, voxels, changes, player, knowledge, out, fullShippedChunks);
        players.push(player);
    }

    dispatchLight(state, room, voxels, players, out, fullShippedChunks);
}

/**
 * room-wide light dispatch. each player's pendingLight set is drained by a
 * globally-sorted priority queue: candidates from all players are ranked by
 * d² from their own anchor, then walked in order until the global cap is
 * hit. a per-client cap prevents any one player from soaking the budget.
 * mirrors luanti's GetNextBlocks → PrioritySortedBlockTransfer → SendBlocks
 * pipeline (src/server/clientiface.cpp + src/server.cpp), but adapted for
 * event-fed light queues instead of discovery-fed block queues.
 */
function dispatchLight(
    state: Discovery,
    room: Room,
    voxels: Voxels,
    players: Player[],
    out: Array<[Client, ServerMessage]>,
    fullShippedChunks: Set<Chunk>,
): void {
    // even if no players are queued for delta dispatch, we still need to clear
    // masks for chunks that shipped via voxel_chunk_full this tick — otherwise
    // the bits leak across ticks and re-ship as redundant deltas later.
    if (players.length === 0 && fullShippedChunks.size === 0) return;

    type Candidate = { d2: number; key: string; pid: PlayerId; chunk: Chunk };
    const candidates: Candidate[] = [];
    const knowledgeByPid = new Map<PlayerId, ClientVoxelKnowledge>();

    for (const player of players) {
        const cs = state.clients.get(player.client);
        if (!cs) continue;
        const knowledge = cs.voxelKnowledge.get(player.id);
        if (!knowledge || knowledge.pendingLight.size === 0) continue;
        knowledgeByPid.set(player.id, knowledge);

        const [pcx, pcy, pcz] = getPlayerChunkCoord(room, player.id);
        for (const key of knowledge.pendingLight) {
            const chunk = voxels.chunks.get(key);
            if (!chunk) {
                knowledge.pendingLight.delete(key);
                continue;
            }
            const dx = chunk.cx - pcx;
            const dy = chunk.cy - pcy;
            const dz = chunk.cz - pcz;
            candidates.push({ d2: dx * dx + dy * dy + dz * dz, key, pid: player.id, chunk });
        }
    }

    if (candidates.length === 0) {
        // no delta candidates, but still clear masks for chunks that shipped
        // via voxel_chunk_full this tick.
        for (const chunk of fullShippedChunks) {
            if (chunk.lightDirtyCount > 0) {
                chunk.lightDirtyMask.fill(0);
                chunk.lightDirtyCount = 0;
            }
        }
        return;
    }

    candidates.sort((a, b) => a.d2 - b.d2);

    const globalCap = Math.floor((players.length + ROOM_MAX_USERS) * LIGHT_CHUNKS_PER_CLIENT_PER_TICK / 4) + 1;
    const perClientCount = new Map<PlayerId, number>();
    const perClientBatch = new Map<PlayerId, Array<{ cx: number; cy: number; cz: number; sky: Uint8Array; rgb: Uint8Array }>>();
    const perClientDeltaBatch = new Map<PlayerId, Array<{ cx: number; cy: number; cz: number; changes: Array<{ index: number; light: number }> }>>();
    // chunks whose delta/full payload was actually shipped to at least one
    // client this tick. their mask + count get cleared after the loop —
    // deferring until then lets two players queued for the same chunk both
    // see the same dirtyCount and ship matching payloads.
    const shippedChunks = new Set<Chunk>();
    let totalSent = 0;

    for (const c of candidates) {
        if (totalSent >= globalCap) break;
        const sent = perClientCount.get(c.pid) ?? 0;
        if (sent >= LIGHT_CHUNKS_PER_CLIENT_PER_TICK) continue;

        const dirtyCount = c.chunk.lightDirtyCount;
        if (dirtyCount > 0 && dirtyCount <= LIGHT_DELTA_THRESHOLD) {
            // per-voxel delta path — iterate set bits in the mask
            const mask = c.chunk.lightDirtyMask;
            const light = c.chunk.light;
            const changes: Array<{ index: number; light: number }> = new Array(dirtyCount);
            let w = 0;
            for (let i = 0; i < mask.length && w < dirtyCount; i++) {
                if (mask[i] !== 0) {
                    changes[w++] = { index: i, light: light[i]! };
                }
            }
            let dbatch = perClientDeltaBatch.get(c.pid);
            if (!dbatch) {
                dbatch = [];
                perClientDeltaBatch.set(c.pid, dbatch);
            }
            dbatch.push({ cx: c.chunk.cx, cy: c.chunk.cy, cz: c.chunk.cz, changes });
        } else {
            const { sky, rgb } = getCompressedLight(c.chunk);
            let batch = perClientBatch.get(c.pid);
            if (!batch) {
                batch = [];
                perClientBatch.set(c.pid, batch);
            }
            batch.push({ cx: c.chunk.cx, cy: c.chunk.cy, cz: c.chunk.cz, sky, rgb });
        }

        shippedChunks.add(c.chunk);
        knowledgeByPid.get(c.pid)!.pendingLight.delete(c.key);
        perClientCount.set(c.pid, sent + 1);
        totalSent++;
    }

    // clear masks for chunks whose current light state was fully synced to
    // every interested receiver this tick — either via delta/full-light ship
    // here, or via voxel_chunk_full earlier in flushVoxelsForPlayer. unshipped
    // delta candidates (cap-exhausted) keep their mask + count so next tick's
    // dispatch still has the info; new writes OR into the same mask via
    // setLight. lightDirty + dirty.light are cleared at end-of-tick.
    for (const chunk of shippedChunks) {
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

    for (const player of players) {
        const batch = perClientBatch.get(player.id);
        if (batch) {
            out.push([
                player.client,
                {
                    type: 'voxel_chunk_light',
                    playerId: player.id,
                    chunks: batch,
                },
            ]);
        }
        const dbatch = perClientDeltaBatch.get(player.id);
        if (dbatch) {
            out.push([
                player.client,
                {
                    type: 'voxel_chunk_light_delta',
                    playerId: player.id,
                    chunks: dbatch,
                },
            ]);
        }
    }
}

/**
 * sweep this player's known/knownEmpty sets and evict any chunks outside the
 * `evictRadius` sphere centered at `(pcx,pcy,pcz)`. emits voxel_chunk_del for
 * each evicted known chunk so the client drops its mesh + memory; empty
 * stubs are dropped silently (client keeps the all-air alias — harmless).
 *
 * called only on chunk-coord transitions in flushVoxelsForPlayer — known sets
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
        knowledge.knownChunks.delete(key);
        knowledge.pendingLight.delete(key);
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
        knowledge.knownEmptyChunks.delete(key);
    }
}

function flushVoxelsForPlayer(
    room: Room,
    voxels: Voxels,
    changes: VoxelChanges,
    player: Player,
    knowledge: ClientVoxelKnowledge,
    out: Array<[Client, ServerMessage]>,
    fullShippedChunks: Set<Chunk>,
): void {
    const client = player.client;

    // 0. light epoch check — if server did a full recompute, reset client knowledge
    if (knowledge.knownLightEpoch < changes.lightEpoch) {
        knowledge.knownChunks.clear();
        knowledge.knownEmptyChunks.clear();
        knowledge.knownLightEpoch = changes.lightEpoch;
        knowledge.cursor = 0;
    }

    const [pcx, pcy, pcz] = getPlayerChunkCoord(room, player.id);

    // per-player view radius — server picks 8 (play) or 24 (edit) at
    // createPlayerNode time. fall back to the default if PlayerTrait is
    // somehow missing.
    const playerNode = room.playerNodes.get(player.id);
    const playerTrait = playerNode ? getTrait(playerNode, PlayerTrait) : null;
    const viewRadius = playerTrait?.viewRadius ?? DEFAULT_VIEW_RADIUS;
    const expansionOrder = getExpansionOrder(viewRadius);

    // 1a. eviction — only on chunk-boundary crossings. evict knownChunks
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

    // 1b. addedChunks drain — chunks created this tick. drop any
    //     known-empty entry that's now occupied, and rewind the cursor so the
    //     walk picks them up (visited entries short-circuit cheaply on re-walk).
    if (changes.addedChunks.size > 0) {
        for (const chunk of changes.addedChunks) {
            const key = chunkKey(chunk.cx, chunk.cy, chunk.cz);
            knowledge.knownEmptyChunks.delete(key);
        }
        knowledge.cursor = 0;
    }

    // 2. chunk_full / chunk_empty — resume the sphere walk from the cursor.
    //    each tick we drain forward until the per-tick budget is hit; visited
    //    entries (knownChunks / knownEmptyChunks) short-circuit. when the
    //    cursor reaches expansionOrder.length the sphere is fully discovered
    //    and per-tick cost drops to zero until the next anchor cross or
    //    addedChunks drain.
    let sent = 0;
    const pendingEmpty: { cx: number; cy: number; cz: number }[] = [];
    // light for these chunks was already shipped inside a voxel_chunk_full
    // this tick; step 4 must skip them or the client decodes the same light
    // array twice.
    const lightSentInFull = new Set<string>();
    while (knowledge.cursor < expansionOrder.length) {
        if (sent >= CHUNKS_PER_TICK && pendingEmpty.length >= EMPTY_CHUNKS_PER_TICK) break;
        const [dx, dy, dz] = expansionOrder[knowledge.cursor]!;
        knowledge.cursor++;
        const cx = pcx + dx;
        const cy = pcy + dy;
        const cz = pcz + dz;
        const key = chunkKey(cx, cy, cz);
        if (knowledge.knownChunks.has(key)) continue;
        if (knowledge.knownEmptyChunks.has(key)) continue;
        const chunk = voxels.chunks.get(key);
        if (chunk) {
            if (sent >= CHUNKS_PER_TICK) {
                // budget exhausted for fulls — rewind one step so we revisit
                // this offset next tick. empties may still drain below us, but
                // their budget is checked at the top of the loop.
                knowledge.cursor--;
                break;
            }
            const { compressed, palette } = getCompressedSnapshot(chunk);
            out.push([
                client,
                {
                    type: 'voxel_chunk_full',
                    playerId: player.id,
                    cx,
                    cy,
                    cz,
                    paletteKeys: palette,
                    compressed,
                },
            ]);
            knowledge.knownChunks.add(key);
            lightSentInFull.add(key);
            fullShippedChunks.add(chunk);
            sent++;
        } else {
            if (pendingEmpty.length >= EMPTY_CHUNKS_PER_TICK) {
                knowledge.cursor--;
                break;
            }
            pendingEmpty.push({ cx, cy, cz });
            knowledge.knownEmptyChunks.add(key);
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

    // 3. block ops — coalesce and send for known chunks
    if (changes.ops.length > 0) {
        const blockChanges = coalesceBlockOps(changes.ops, knowledge.knownChunks, voxels.chunks);

        // promote chunks with too many block changes to chunk_full re-send.
        // dropping from knownChunks means the cursor walk needs to revisit
        // those offsets — rewind so it does.
        let promoted = false;
        for (const [key, entry] of blockChanges) {
            if (entry.changes.size > PROMOTION_THRESHOLD) {
                knowledge.knownChunks.delete(key);
                knowledge.pendingLight.delete(key);
                blockChanges.delete(key);
                promoted = true;
            }
        }
        if (promoted) knowledge.cursor = 0;

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

    // 4. light — absorb newly-dirty chunks into this client's pendingLight
    //    queue. actual dispatch happens at the room level after all players
    //    have absorbed, so we can apply a globally-sorted priority + per-tick
    //    cap across the room (luanti-style global priority + per-client cap).
    //    skip chunks whose light was just shipped inside a chunk_full this
    //    tick — that payload already carried fresh light.
    for (const chunk of voxels.dirty.light) {
        const key = chunkKey(chunk.cx, chunk.cy, chunk.cz);
        if (!knowledge.knownChunks.has(key)) continue;
        if (lightSentInFull.has(key)) continue;
        knowledge.pendingLight.add(key);
    }
}
