import type { Client, JsonValue } from 'bongle/interface';
import { addPlayerTraits } from '../builtins/player-node';
import { attachWorldTrait } from '../builtins/world';
import type { PlayerId } from '../core/client';
import * as Clock from '../core/clock';
import { createLogs, type Logs } from '../core/debug';
import * as Physics from '../core/physics/physics';
import type * as Protocol from '../core/protocol';
import type { PlayerMode, RoomMode } from '../core/protocol';
import { registry } from '../core/registry';
import type * as Resources from '../core/resources';
import * as Animation from '../core/scene/animation';
import { DEFAULT_SCENE_ID } from '../core/scene/scene-handle';
import {
    addChild,
    bumpNodeVersion,
    createNode,
    createSceneTree,
    destroyNode,
    generateUuid,
    getNodeById,
    loadSceneTree,
    type Node,
    type SceneTree,
    setOwner,
} from '../core/scene/scene-tree';
import type { SceneTreeContext } from '../core/scene/scripts';
import * as Scripts from '../core/scene/scripts';
import { loadVoxels } from '../core/voxels/voxel-savefile';
import type { Voxels } from '../core/voxels/voxels';
import { createVoxels, createVoxelsAuthority } from '../core/voxels/voxels';
import * as Avatars from './avatars';
import type { ChatServer } from './chat';
import * as Chat from './chat';
import * as ContentManager from './content-manager';
import * as Discovery from './discovery';
import * as Net from './net';
import type { EngineServer } from './server';

export class RoomNotFoundError extends Error {
    constructor(roomId: string) {
        super(`[bongle] room not found: ${roomId}`);
        this.name = 'RoomNotFoundError';
    }
}

export type { RoomMode as RoomKind } from '../core/protocol';

export type Room = {
    /** unique runtime id (e.g. "room_1"). */
    id: string;

    /** scene file path (e.g. "scenes/main.scene.json"). */
    sceneId: string;

    scene: SceneTree;

    /** players (per (client, mode)) currently in this room. */
    players: Set<PlayerId>;

    mode: RoomMode;

    /** play rooms: which edit room they were created from. */
    sourceRoomId: string | null;

    context: SceneTreeContext;

    /** PlayerId -> in-scene node bearing PlayerTrait, one per Player. */
    playerNodes: Map<PlayerId, Node>;

    /** per-room voxel data. always present (may be empty). */
    voxels: Voxels;

    /** per-room physics world. always present. */
    physics: Physics.Physics;

    /** per-room game clock (monotonic seconds), advanced once per server tick; read via `ctx.clock.time`. */
    clock: Clock.Clock;

    /** per-room animation state, caches the AnimatorTrait query consumed by `Animation.tick`. */
    animations: Animation.Animations;

    /** per-room server-side chat: command registry + broadcast transport. */
    chat: ChatServer;

    /** this room's scope key in the server's one profiler (`room:<id>`); the whole tick is a span under it. */
    profileKey: string;

    /** per-room log buffer, script logs and tagged engine logs land here. */
    logs: Logs;

    /** monotonically incrementing tick counter, incremented each update(). */
    tick: number;

    /** namespace this room belongs to; defaults to 'main', editor edit rooms use 'editor', each play session allocates 'play-<uuid>'. */
    namespace: string;
};

/** a Player is a client's specific instance of being in a room, one per (client, room, mode) triple. */
export type { PlayerId };

export type Player = {
    id: PlayerId;
    client: Client;
    roomId: string;
    mode: PlayerMode;
};

/** a namespace ties one matchmaking allocation together; every Room belongs to exactly one. */
export type Namespace = {
    id: string;
    options: Record<string, string | number | boolean>;
};

/** stable JSON serialisation with sorted keys, matching the matchmaker's canonicalisation. */
export function canonicalJson(opts: Record<string, string | number | boolean>): string {
    const sorted = Object.fromEntries(Object.entries(opts).sort(([a], [b]) => a.localeCompare(b)));
    return JSON.stringify(sorted);
}

export type Rooms = {
    rooms: Map<string, Room>;
    /** all Players, keyed by PlayerId. */
    players: Map<PlayerId, Player>;
    /** PlayerIds belonging to each Client (may include multiple per roomId, with different modes). */
    playersByClient: Map<Client, Set<PlayerId>>;
    /** which Player the client has flagged as their active focus. */
    activePlayer: Map<Client, PlayerId>;
    /** Room ids queued for stop, drained at the end of each tick. */
    pendingStops: Set<string>;
    /** createRoom auto-registers on first reference; destroyRoom auto-removes the last room in a non-root namespace. */
    namespaces: Map<string, Namespace>;
    _nextRoomId: number;
    _nextPlayerId: number;
};

export function init(): Rooms {
    return {
        rooms: new Map(),
        players: new Map(),
        playersByClient: new Map(),
        activePlayer: new Map(),
        pendingStops: new Set(),
        namespaces: new Map(),
        _nextRoomId: 1,
        _nextPlayerId: 1,
    };
}

/** looks up an existing namespace or creates one; `options` is ignored if the namespace already exists. */
export function getOrCreateNamespace(state: Rooms, id: string, options?: Record<string, string | number | boolean>): Namespace {
    const existing = state.namespaces.get(id);
    if (existing) return existing;
    const ns: Namespace = { id, options: options ?? {} };
    state.namespaces.set(id, ns);
    return ns;
}

export function getNamespace(state: Rooms, id: string): Namespace | undefined {
    return state.namespaces.get(id);
}

/** overwrites the options on an existing namespace, creating it if absent. */
export function setNamespaceOptions(state: Rooms, id: string, options: Record<string, string | number | boolean>): void {
    const ns = state.namespaces.get(id);
    if (ns) {
        ns.options = options;
    } else {
        state.namespaces.set(id, { id, options });
    }
}

export function deleteNamespace(state: Rooms, id: string): void {
    state.namespaces.delete(id);
}

export type CreateRoomOptions = {
    sceneId: string;
    kind: 'edit' | 'play';
    sourceRoomId?: string;
    rpc: SceneTreeContext['rpc'];
    resources: Resources.Resources;
    /** namespace for this room, defaults to 'main'. */
    namespace?: string;
};

export function createRoom(state: Rooms, opts: CreateRoomOptions): Room {
    const id = `room_${state._nextRoomId++}`;
    const namespace = opts.namespace ?? 'main';
    // metadata (options) is set separately via setNamespaceOptions or the `play` handler.
    getOrCreateNamespace(state, namespace);

    const sceneGraph = createSceneTree();

    const blocks = registry.blockRegistry;
    const voxels = createVoxels(blocks);
    voxels.authority = createVoxelsAuthority();

    const physics = Physics.init(sceneGraph, voxels);

    const chat = Chat.init();
    const clock = Clock.init();

    const room: Room = {
        id,
        sceneId: opts.sceneId,
        scene: sceneGraph,
        players: new Set(),
        mode: opts.kind,
        sourceRoomId: opts.sourceRoomId ?? null,
        playerNodes: new Map(),
        voxels,
        physics,
        clock,
        animations: Animation.init(sceneGraph),
        chat,
        profileKey: `room:${id}`,
        logs: createLogs(),
        tick: 0,
        namespace,
        context: {
            roomId: id,
            playerMode: opts.kind,
            roomMode: opts.kind,
            resources: opts.resources,
            client: undefined,
            server: undefined,
            authority: true, // the server owns the simulation here
            rpc: opts.rpc,
            voxels,
            physics,
            clock,
            get blocks() {
                return voxels.registry;
            },
            instances: new Map(),
        },
    };

    // wire the runtime into the scene graph so addTrait/registerSubtree can instantiate
    sceneGraph.context = room.context;

    state.rooms.set(id, room);

    // WorldTrait attaches in initializeRoom, not here: context.server is still undefined at this point.
    return room;
}

/** fires leave hooks for every Player, tears down player nodes + scene graph + physics, and deletes the room. */
export function destroyRoom(state: Rooms, roomId: string): void {
    const room = state.rooms.get(roomId);
    if (!room) return;

    for (const id of room.players) {
        const player = state.players.get(id);
        if (!player) continue;
        const playerNode = room.playerNodes.get(id);
        if (playerNode) Scripts.fireLeaveHooks(room.context, player.client, playerNode);
        destroyPlayerNode(room, id);
    }

    const children = room.scene.root.children.slice();
    for (const child of children) {
        destroyNode(room.scene, child);
    }

    // root systems dispose last, after the entities they iterate.
    const rootInstances = room.scene.context?.instances.get(room.scene.root.id);
    if (rootInstances) {
        for (const instance of rootInstances.values()) Scripts.disposeScriptInstance(instance);
        room.scene.context!.instances.delete(room.scene.root.id);
    }

    Physics.dispose(room.physics);

    for (const playerId of room.players) {
        const p = state.players.get(playerId);
        if (p) {
            const set = state.playersByClient.get(p.client);
            if (set) {
                set.delete(playerId);
                if (set.size === 0) state.playersByClient.delete(p.client);
            }
            if (state.activePlayer.get(p.client) === playerId) {
                state.activePlayer.delete(p.client);
            }
        }
        state.players.delete(playerId);
    }
    room.players.clear();

    state.rooms.delete(roomId);

    // 'main' and 'editor' live for the process lifetime; play-<uuid> namespaces vanish with their last room.
    if (room.namespace !== 'main' && room.namespace !== 'editor') {
        const stillUsed = findRoomByNamespace(state, room.namespace);
        if (!stillUsed) state.namespaces.delete(room.namespace);
    }
}

/** finds an existing Player for (client, roomId, mode); linear scan, cardinality is small. */
export function findPlayer(state: Rooms, client: Client, roomId: string, mode: PlayerMode): Player | undefined {
    const ids = state.playersByClient.get(client);
    if (!ids) return undefined;
    for (const id of ids) {
        const p = state.players.get(id);
        if (p && p.roomId === roomId && p.mode === mode) return p;
    }
    return undefined;
}

/** allocates a Player for a (client, room, mode), idempotent; does not create the in-scene player node. */
export function joinRoom(state: Rooms, client: Client, roomId: string, mode: PlayerMode): Player {
    const room = state.rooms.get(roomId);
    if (!room) throw new RoomNotFoundError(roomId);

    const existing = findPlayer(state, client, roomId, mode);
    if (existing) return existing;

    const id = state._nextPlayerId++;
    const player: Player = { id, client, roomId, mode };
    state.players.set(id, player);

    let set = state.playersByClient.get(client);
    if (!set) {
        set = new Set();
        state.playersByClient.set(client, set);
    }
    set.add(id);

    room.players.add(id);

    return player;
}

/** removes a Player by id; does not destroy the in-scene player node, that's the caller's job. */
export function leaveRoom(state: Rooms, playerId: PlayerId): void {
    const player = state.players.get(playerId);
    if (!player) return;
    state.players.delete(playerId);

    const room = state.rooms.get(player.roomId);
    if (room) {
        room.players.delete(playerId);
    }

    const set = state.playersByClient.get(player.client);
    if (set) {
        set.delete(playerId);
        if (set.size === 0) state.playersByClient.delete(player.client);
    }
    if (state.activePlayer.get(player.client) === playerId) {
        state.activePlayer.delete(player.client);
    }
}

/** removes every Player belonging to a client. used on disconnect. */
export function leaveAllRooms(state: Rooms, client: Client): void {
    const ids = state.playersByClient.get(client);
    if (!ids) return;
    for (const id of [...ids]) {
        leaveRoom(state, id);
    }
}

/** sets which Player the client has flagged as active focus; presence-only, not used for command routing. */
export function setActivePlayer(state: Rooms, client: Client, playerId: PlayerId): void {
    if (!state.players.has(playerId)) return;
    state.activePlayer.set(client, playerId);
}

export function getActivePlayer(state: Rooms, client: Client): Player | undefined {
    const id = state.activePlayer.get(client);
    if (!id) return undefined;
    return state.players.get(id);
}

export function getActivePlayerId(state: Rooms, client: Client): PlayerId | undefined {
    return state.activePlayer.get(client);
}

export function getRoom(state: Rooms, roomId: string): Room | undefined {
    return state.rooms.get(roomId);
}

export function getPlayer(state: Rooms, playerId: PlayerId): Player | undefined {
    return state.players.get(playerId);
}

/** all Players for a client, may include multiple per roomId with different modes. */
export function getPlayersForClient(state: Rooms, client: Client): Player[] {
    const ids = state.playersByClient.get(client);
    if (!ids) return [];
    const out: Player[] = [];
    for (const id of ids) {
        const p = state.players.get(id);
        if (p) out.push(p);
    }
    return out;
}

/** unique room ids a client has any Player in, deduped across modes. */
export function getRoomsForClient(state: Rooms, client: Client): Set<string> {
    const out = new Set<string>();
    for (const p of getPlayersForClient(state, client)) {
        out.add(p.roomId);
    }
    return out;
}

/** distinct clients currently in a room, deduped across modes. */
export function getClientsInRoom(state: Rooms, room: Room): Set<Client> {
    const out = new Set<Client>();
    for (const id of room.players) {
        const p = state.players.get(id);
        if (p) out.add(p.client);
    }
    return out;
}

/** all Players currently in a room, every (client, mode) combination. */
export function getPlayersInRoom(state: Rooms, room: Room): Player[] {
    const out: Player[] = [];
    for (const id of room.players) {
        const p = state.players.get(id);
        if (p) out.push(p);
    }
    return out;
}

export function findEditRoomBySceneId(state: Rooms, sceneId: string): Room | undefined {
    for (const room of state.rooms.values()) {
        if (room.mode === 'edit' && room.sceneId === sceneId) {
            return room;
        }
    }
    return undefined;
}

/** all rooms sharing the given namespace; used for cascading stops and namespace scoping. */
export function findRoomsInNamespace(state: Rooms, namespace: string): Room[] {
    const out: Room[] = [];
    for (const room of state.rooms.values()) {
        if (room.namespace === namespace) out.push(room);
    }
    return out;
}

/** the at most one room occupying the given namespace. */
export function findRoomByNamespace(state: Rooms, namespace: string): Room | undefined {
    for (const room of state.rooms.values()) {
        if (room.namespace === namespace) return room;
    }
    return undefined;
}

export function initializeRoom(state: EngineServer, room: Room): void {
    const t0 = performance.now();
    // wire server context before loading the scene so onInit handlers can safely access ctx.server.
    room.context.server = {
        state,
        room,
        get options() {
            return state.rooms.namespaces.get(room.namespace)?.options ?? {};
        },
    };

    // dispose the placeholder physics from createRoom; the Jolt world isn't explicitly destroyed, so this leaks one WASM-side world per room boot.
    const disposeT0 = performance.now();
    Physics.dispose(room.physics);
    const disposeMs = performance.now() - disposeT0;

    // load voxels before the scene graph: loadSceneTree fires script onInit hooks that may call setBlock, which loadVoxels would wipe.
    let voxDeserMs = 0;
    let sceneParseMs = 0;
    const sceneLoadT0 = performance.now();
    const sceneFile = ContentManager.loadSceneRaw(state.contentManager, room.sceneId);
    const sceneLoadMs = performance.now() - sceneLoadT0;
    if (sceneFile) {
        if (sceneFile.data.voxels) {
            const desT0 = performance.now();
            loadVoxels(room.voxels, sceneFile.data.voxels, registry.blockRegistry);
            voxDeserMs = performance.now() - desT0;
        }
        const parseT0 = performance.now();
        loadSceneTree(room.scene, sceneFile.data.nodes);
        sceneParseMs = performance.now() - parseT0;
        // seed the dedupe cache so the first flush compares against real disk bytes.
        ContentManager.putScene(state.contentManager, room.sceneId, sceneFile.raw);
    }

    const physT0 = performance.now();
    room.physics = Physics.init(room.scene, room.voxels);
    const physMs = performance.now() - physT0;
    room.context.physics = room.physics;

    // attached here, after context.server is wired and after loadSceneTree, so onInit fires with ctx.server live.
    attachWorldTrait(room.scene.root);

    Discovery.invalidateRoomList(state.discovery);

    const totalMs = performance.now() - t0;
    const chunkCount = room.voxels.chunks.size;
    const nodeCount = room.scene.nodes.size;
    console.log(
        `[room-start]   initializeRoom mode=${room.mode} chunks=${chunkCount} nodes=${nodeCount} ` +
            `dispose=${disposeMs.toFixed(1)} ` +
            `sceneLoad=${sceneLoadMs.toFixed(1)} voxDeser=${voxDeserMs.toFixed(1)} sceneParse=${sceneParseMs.toFixed(1)} ` +
            `physics=${physMs.toFixed(1)} total=${totalMs.toFixed(1)}ms`,
    );
}

/** attaches a client to a room as a Player, allocating one if it doesn't already exist; creates the in-scene node and fires join hooks. */
export function addClientToRoom(
    state: EngineServer,
    client: Client,
    room: Room,
    mode?: PlayerMode,
    joinData?: Record<string, JsonValue>,
): Player {
    const playerMode = mode ?? room.mode;

    const existing = findPlayer(state.rooms, client, room.id, playerMode);
    if (existing) {
        setActivePlayer(state.rooms, client, existing.id);
        Discovery.invalidateRoomList(state.discovery);
        return existing;
    }

    const t0 = performance.now();
    const player = joinRoom(state.rooms, client, room.id, playerMode);

    const clientState = state.clients.connected.get(client);
    const user = clientState?.user ?? { id: '', username: '' };
    const playerNodeT0 = performance.now();
    const playerNode = createPlayerNode(state, room, player);
    const playerNodeMs = performance.now() - playerNodeT0;
    // stamp the resolved avatar before firing join hooks, so onJoin observes the right modelId/rigType.
    const avatarT0 = performance.now();
    Avatars.enqueuePlayer(state, room, player);
    const avatarMs = performance.now() - avatarT0;
    const joinHooksT0 = performance.now();
    Scripts.fireJoinHooks(
        room.context,
        client,
        user,
        joinData ?? {},
        player.mode,
        playerNode,
        Avatars.clientAvatarIdentity(clientState),
    );
    const joinHooksMs = performance.now() - joinHooksT0;
    Chat.broadcast(room.chat, {
        from: 'system',
        text: `${user.username || 'anon'} joined`,
        kind: 'system',
    });
    setActivePlayer(state.rooms, client, player.id);
    const discoveryT0 = performance.now();
    Discovery.invalidatePlayer(state.discovery, state.net, state.rooms, state.resources, player);
    const discoveryMs = performance.now() - discoveryT0;
    Discovery.invalidateRoomList(state.discovery);
    const totalMs = performance.now() - t0;
    console.log(
        `[room-start]   addClientToRoom mode=${playerMode} ` +
            `playerNode=${playerNodeMs.toFixed(1)} joinHooks=${joinHooksMs.toFixed(1)} ` +
            `avatars=${avatarMs.toFixed(1)} discovery=${discoveryMs.toFixed(1)} total=${totalMs.toFixed(1)}ms`,
    );
    return player;
}

export function findOrCreateEditRoom(state: EngineServer, sceneId: string): Room {
    let room = findEditRoomBySceneId(state.rooms, sceneId);

    if (!room) {
        room = createRoom(state.rooms, {
            sceneId,
            kind: 'edit',
            rpc: state.rpc,
            resources: state.resources,
            namespace: 'editor',
        });
        initializeRoom(state, room);
    }

    return room;
}

export function createPlayRoom(state: EngineServer, sceneId: string, sourceRoomId?: string): Room {
    const room = createRoom(state.rooms, {
        sceneId,
        kind: 'play',
        sourceRoomId,
        rpc: state.rpc,
        resources: state.resources,
    });
    initializeRoom(state, room);
    return room;
}

/** creates + initializes a room in an explicit namespace; authored scripts cannot reach this directly. */
export function createRoomInNamespace(
    state: EngineServer,
    sceneId: string,
    mode: RoomMode,
    namespace: string,
    sourceRoomId?: string,
): Room {
    const room = createRoom(state.rooms, {
        sceneId,
        kind: mode,
        sourceRoomId,
        rpc: state.rpc,
        resources: state.resources,
        namespace,
    });
    initializeRoom(state, room);
    return room;
}

export function stopRoom(state: EngineServer, roomId: string): void {
    const room = getRoom(state.rooms, roomId);
    if (!room) return;

    if (room.mode === 'edit' && roomId === state.defaultRoomId) return;

    stopRoomInner(state, roomId);
}

function stopRoomInner(state: EngineServer, roomId: string): void {
    const room = getRoom(state.rooms, roomId);
    if (!room) return;

    const fallbackId = room.mode === 'play' ? (room.sourceRoomId ?? state.defaultRoomId) : state.defaultRoomId;
    const fallback = fallbackId ? state.rooms.rooms.get(fallbackId) : undefined;

    // snapshot Players before mutating room.players; each (client, mode) gets its own outbound room_left.
    const playerSnapshots: Array<{ id: PlayerId; client: Client; mode: PlayerMode }> = [];
    for (const id of room.players) {
        const p = state.rooms.players.get(id);
        if (p) playerSnapshots.push({ id, client: p.client, mode: p.mode });
    }
    const affectedClients = new Set(playerSnapshots.map((s) => s.client));

    for (const snap of playerSnapshots) {
        const player = state.rooms.players.get(snap.id);
        // leave hooks fire while the player is still a member, as on disconnect.
        const playerNode = room.playerNodes.get(snap.id);
        if (playerNode) Scripts.fireLeaveHooks(room.context, snap.client, playerNode);
        leaveRoom(state.rooms, snap.id);
        destroyPlayerNode(room, snap.id);
        if (player) Discovery.notifyPlayerLeft(state.discovery, state.net, player);
    }

    destroyRoom(state.rooms, roomId);

    // route to a fallback Player already held in the fallback room; we don't auto-mint Players there.
    if (fallback) {
        for (const client of affectedClients) {
            if (state.rooms.activePlayer.has(client)) continue;
            const fp = findPlayer(state.rooms, client, fallback.id, fallback.mode);
            if (fp) setActivePlayer(state.rooms, client, fp.id);
        }
    }

    Discovery.invalidateRoomList(state.discovery);
}

/** queues a stop to apply after the current tick block, so a caller running inside a per-room tick doesn't tear down nodes mid-loop. */
export function queueStopRoom(state: Rooms, roomId: string): void {
    state.pendingStops.add(roomId);
}

/** applies queued stops; called from engine-server.update once per tick after every room has ticked. */
export function drainPending(state: EngineServer): void {
    if (state.rooms.pendingStops.size > 0) {
        const ids = [...state.rooms.pendingStops];
        state.rooms.pendingStops.clear();
        for (const id of ids) stopRoom(state, id);
    }
}

/** drops a single Player: destroys its in-scene node, notifies the client, and routes it back to the default room if needed. */
export function leaveClientFromRoom(state: EngineServer, playerId: PlayerId): void {
    const player = state.rooms.players.get(playerId);
    if (!player) return;

    const { client, roomId } = player;
    if (roomId === state.defaultRoomId) return;

    const room = getRoom(state.rooms, roomId);
    if (!room) return;

    const leavingCs = state.clients.connected.get(client);
    const leavingName = leavingCs?.user.username || 'anon';
    Chat.broadcast(room.chat, {
        from: 'system',
        text: `${leavingName} left`,
        kind: 'system',
    });

    // leave hooks fire while the player is still a member, as on disconnect.
    const leavingNode = room.playerNodes.get(playerId);
    if (leavingNode) Scripts.fireLeaveHooks(room.context, client, leavingNode);
    leaveRoom(state.rooms, playerId);
    destroyPlayerNode(room, playerId);

    Discovery.notifyPlayerLeft(state.discovery, state.net, player);

    const defaultRoomId = state.defaultRoomId;
    if (state.rooms.activePlayer.get(client) === undefined && defaultRoomId) {
        const def = state.rooms.rooms.get(defaultRoomId);
        if (def) {
            const fp =
                findPlayer(state.rooms, client, defaultRoomId, def.mode) ??
                joinRoom(state.rooms, client, defaultRoomId, def.mode);
            if (!def.playerNodes.has(fp.id)) {
                const cs = state.clients.connected.get(client);
                const user = cs?.user ?? { id: '', username: '' };
                const playerNode = createPlayerNode(state, def, fp);
                // stamp avatar before join hooks (see addClientToRoom)
                Avatars.enqueuePlayer(state, def, fp);
                Scripts.fireJoinHooks(def.context, client, user, {}, fp.mode, playerNode, Avatars.clientAvatarIdentity(cs));
                Chat.broadcast(def.chat, {
                    from: 'system',
                    text: `${user.username || 'anon'} joined`,
                    kind: 'system',
                });
            }
            setActivePlayer(state.rooms, client, fp.id);
            Discovery.invalidatePlayer(state.discovery, state.net, state.rooms, state.resources, fp);
        }
    }

    if (room.mode === 'edit' && room.players.size === 0) {
        destroyRoom(state.rooms, roomId);
    }

    Discovery.invalidateRoomList(state.discovery);
}

/** point every room on `oldSceneId` at `newSceneId`: the scene was renamed. */
export function retargetScene(state: EngineServer, oldSceneId: string, newSceneId: string): void {
    for (const room of state.rooms.rooms.values()) {
        if (room.sceneId === oldSceneId) room.sceneId = newSceneId;
    }
    Discovery.invalidateRoomList(state.discovery);
}

/** stop every room on `sceneId`: the scene is being deleted. */
export function stopScene(state: EngineServer, sceneId: string): void {
    for (const room of [...state.rooms.rooms.values()]) {
        if (room.sceneId === sceneId) stopRoom(state, room.id);
    }
    Discovery.invalidateRoomList(state.discovery);
}

/** creates the in-scene player node and attaches the trait stack every player wears; does not fire join hooks or drive the avatar lifecycle. */
export function createPlayerNode(state: EngineServer, room: Room, player: Player): Node {
    const sg = room.scene;
    const node = createNode({ name: `player:${player.id}`, persist: false });
    addChild(sg.root, node);
    setOwner(sg, node, player.id);
    const cs = state.clients.connected.get(player.client);
    // edit rooms get a much larger streaming radius so editors can see/edit most of the world.
    addPlayerTraits(node, {
        playerId: player.id,
        clientId: player.client,
        mode: player.mode,
        viewRadius: room.mode === 'edit' ? 24 : 8,
        userId: cs?.user.id,
        username: cs?.user.username,
    });
    bumpNodeVersion(sg, node);
    room.playerNodes.set(player.id, node);
    return node;
}

export function destroyPlayerNode(room: Room, playerId: PlayerId): void {
    const node = room.playerNodes.get(playerId);
    if (!node) return;
    room.playerNodes.delete(playerId);
    destroyNode(room.scene, node);
}

/** handles a `play` message: finds-or-creates the namespaced room, drops any prior play membership elsewhere, joins, and activates. */
export function joinPlay(state: EngineServer, client: Client, message: Protocol.Play): void {
    const sceneId = message.sceneId ?? DEFAULT_SCENE_ID;
    const t0 = performance.now();

    let namespace: string;
    let joinData: Record<string, JsonValue> = {};
    if (message.options) {
        const options = JSON.parse(message.options) as Record<string, string | number | boolean>;
        namespace = canonicalJson(options);
        getOrCreateNamespace(state.rooms, namespace, options);
        if (message.joinData) joinData = JSON.parse(message.joinData) as Record<string, JsonValue>;
    } else {
        namespace = `play-${generateUuid()}`;
        getOrCreateNamespace(state.rooms, namespace, {});
    }

    let room = findRoomByNamespace(state.rooms, namespace);
    const createT0 = performance.now();
    let createdRoom = false;
    if (!room) {
        room = createRoomInNamespace(state, sceneId, 'play', namespace, message.sourceRoomId);
        createdRoom = true;
    }
    const createMs = performance.now() - createT0;

    // drop any prior play-mode membership in a different room so a re-entry doesn't accumulate Players.
    const prior = findPlayer(state.rooms, client, room.id, 'play');
    if (!prior) {
        for (const p of getPlayersForClient(state.rooms, client)) {
            if (p.mode === 'play' && p.roomId !== room.id) leaveClientFromRoom(state, p.id);
        }
    }

    const joinT0 = performance.now();
    const player = addClientToRoom(state, client, room, 'play', joinData);
    const joinMs = performance.now() - joinT0;
    Net.send(state.net, client, { type: 'activate_room', playerId: player.id });
    const totalMs = performance.now() - t0;
    console.log(
        `[room-start] play sceneId=${sceneId} created=${createdRoom} ` +
            `create=${createMs.toFixed(1)}ms join=${joinMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms`,
    );
}

/** applies an owner client's `sync_update`: validates ownership, resolves the trait, then hands the fields to Discovery. */
export function applyOwnerSync(
    state: EngineServer,
    client: Client,
    message: Extract<Protocol.ClientMessage, { type: 'sync_update' }>,
): void {
    const room = getRoom(state.rooms, message.roomId);
    if (!room) return;

    const node = getNodeById(room.scene, message.nodeId);
    if (!node || node.owner === null) return;
    const ownerPlayer = state.rooms.players.get(node.owner);
    if (!ownerPlayer || ownerPlayer.client !== client || ownerPlayer.roomId !== room.id) return;

    const cs = state.clients.connected.get(client);
    if (!cs) return;
    const traitId = cs.inbound.traits.indexToId[message.traitNetIndex];
    if (traitId === undefined) return;
    const handle = registry.traits.handles.get(traitId);
    if (!handle) return;

    const instance = node.traits[handle.slot];
    if (!instance) return;

    Discovery.acceptOwnerFields(
        state.discovery,
        state.rooms,
        room.id,
        client,
        room.scene,
        node,
        handle.def,
        instance,
        message.fields,
        room.mode,
        cs.inbound.syncRemap.get(traitId),
    );
}
