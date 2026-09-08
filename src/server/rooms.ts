import type { Client, JsonValue } from 'bongle/interface';
import { addPlayerTraits } from '../builtins/player-node';
import { attachWorldTrait } from '../builtins/world';
import type { PlayerId } from '../core/client';
import * as Clock from '../core/clock';
import { createLogs, createMetrics, type Logs, type Metrics } from '../core/debug';
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

/* ── Errors ─────────────────────────────────────────────────────── */

export class RoomNotFoundError extends Error {
    constructor(roomId: string) {
        super(`[bongle] room not found: ${roomId}`);
        this.name = 'RoomNotFoundError';
    }
}

/* ── Room ───────────────────────────────────────────────────────── */

export type { RoomMode as RoomKind } from '../core/protocol';

export type Room = {
    /** Unique runtime id (e.g. "room_1"). */
    id: string;

    /** Scene file path (e.g. "scenes/main.scene.json"). */
    sceneId: string;

    /** The live scene tree. */
    scene: SceneTree;

    /** Players (per (client, mode)) currently in this room. */
    players: Set<PlayerId>;

    /** Room mode. */
    mode: RoomMode;

    /** Play rooms: which edit room they were created from. */
    sourceRoomId: string | null;

    /** Scene tree context */
    context: SceneTreeContext;

    /** PlayerId → in-scene node bearing PlayerTrait. one body per Player. */
    playerNodes: Map<PlayerId, Node>;

    /** per-room voxel data. always present (may be empty). */
    voxels: Voxels;

    /** per-room physics world. always present. */
    physics: Physics.Physics;

    /** per-room game clock (monotonic seconds). advanced once per server
     *  tick; pauses when ticks don't fire. read via `ctx.clock.time`. */
    clock: Clock.Clock;

    /** per-room animation state, caches the [AnimatorTrait] query consumed by
     *  `Animation.tick`. */
    animations: Animation.Animations;

    /** per-room server-side chat: command registry + broadcast transport. */
    chat: ChatServer;

    /** per-room performance metrics. */
    metrics: Metrics;

    /** per-room log buffer, script logs and tagged engine logs land here. */
    logs: Logs;

    /** monotonically incrementing tick counter. incremented each update(). */
    tick: number;

    /**
     * Namespace this room belongs to. Authored scripts' rooms.* APIs are
     * scoped to caller's namespace, so a play-session room cannot see/touch
     * the editor's edit room. Defaults to 'main' (production); editor edit
     * rooms use 'editor'; each play session allocates 'play-<uuid>'.
     */
    namespace: string;
};

/* ── Player ─────────────────────────────────────────────────────── */

/**
 * A `Player` is a client's specific instance of being in a room, a child
 * concept of `Client` (which is the connection itself). One Player exists
 * per (client, room, mode) triple, identified by a server-allocated
 * `PlayerId`. A single client may hold multiple Players in the same room
 * if their modes differ (e.g. an editor view + a play view of the same
 * room, each shown as a separate tab).
 *
 * Each Player owns one in-scene node bearing PlayerTrait, accessed via
 * `room.playerNodes.get(player.id)`, which is where world observation
 * (camera, input, physics ownership) is anchored.
 */
export type { PlayerId };

export type Player = {
    id: PlayerId;
    client: Client;
    roomId: string;
    mode: PlayerMode;
};

/* ── Namespace ──────────────────────────────────────────────────── */

/**
 * A namespace is the grouping concept that ties one matchmaking allocation
 * together. Every Room belongs to exactly one Namespace (Room.namespace
 * matches Namespace.id). Production = one 'main' namespace. Editor "Play" =
 * a fresh `play-<uuid>`. Game `client.matchmake({options})` keys a namespace
 * on `canonicalJson(opts)`. The namespace stores its own options so
 * scripts can read them back via `ctx.server.options` without the engine
 * needing a separate per-client cache.
 *
 * The 'main' and 'editor' ids are conventional roots that auto-cleanup
 * leaves alone (they live for the process lifetime).
 */
export type Namespace = {
    id: string;
    options: Record<string, string | number | boolean>;
};

/**
 * Stable JSON serialisation with lexicographically sorted keys. Same shape
 * as the matchmaker's canonicalisation in `apps/service/src/matchmaking/core.ts`,
 * so namespaces minted by `client.matchmake` here key into the same bucket
 * the matchmaker would.
 */
export function canonicalJson(opts: Record<string, string | number | boolean>): string {
    const sorted = Object.fromEntries(Object.entries(opts).sort(([a], [b]) => a.localeCompare(b)));
    return JSON.stringify(sorted);
}

/* ── Rooms registry ─────────────────────────────────────────────── */

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
    /**
     * Namespaces registered with this server. Lives alongside rooms so the
     * room module owns the namespace concept end-to-end. createRoom auto-
     * registers on first reference; destroyRoom auto-removes when the last
     * room in a non-root namespace ('main'/'editor' excluded) is destroyed.
     */
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

/* ── Namespace CRUD ─────────────────────────────────────────────── */

/**
 * Look up an existing namespace or create a fresh one. Idempotent on
 * options: if the namespace exists, `options` is ignored (use
 * `setNamespaceOptions` to overwrite). Called by `createRoom` so
 * every room is paired with a registered namespace.
 */
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

/**
 * Overwrite the options on an existing namespace (creates if absent).
 * Runtime calls this once at boot in deployed (game-room) to stamp the
 * matchmaking options onto the 'main' namespace so scripts can read it.
 */
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

/* ── Room lifecycle ─────────────────────────────────────────────── */

export type CreateRoomOptions = {
    sceneId: string;
    kind: 'edit' | 'play';
    sourceRoomId?: string;
    rpc: SceneTreeContext['rpc'];
    resources: Resources.Resources;
    /** Namespace for this room. Defaults to 'main'. */
    namespace?: string;
};

/**
 * Create a new room with a fresh scene graph.
 */
export function createRoom(state: Rooms, opts: CreateRoomOptions): Room {
    const id = `room_${state._nextRoomId++}`;
    const namespace = opts.namespace ?? 'main';
    // ensure the namespace exists in the registry before the room references
    // it. metadata (options) is set separately via setNamespaceOptions
    // or by the `play` handler when an options-keyed namespace is born.
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
        metrics: createMetrics(),
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
            authority: true, // the server owns the simulation
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

    // NOTE: the WorldTrait (system host) is attached in initializeRoom, NOT
    // here. Attaching it here fires its systems' onInit
    // while context.server is still undefined (it's wired at the top of
    // initializeRoom) — a system's onInit reaching for ctx.server would blow up.
    // Every createRoom caller runs initializeRoom immediately after, so nothing
    // observes the root without these traits. Attaching once there — after the
    // server is wired and after loadSceneTree — makes onInit fire exactly once.
    return room;
}

/**
 * Destroy a room. Fires leave hooks for every Player, tears down player
 * nodes + scene graph + physics, removes every Player belonging to this
 * room (across all clients/modes), and deletes it from the registry.
 */
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

    // the root's systems dispose last, after the entities they iterate: the same
    // order loadSceneTree uses when it replaces a scene. (the root node itself is
    // permanent, so destroyNode never reaches these.)
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

    // auto-cleanup empty namespaces (except 'main' and 'editor', these live
    // for the process lifetime and are conventional roots). `play`-minted
    // play-<uuid> namespaces vanish when their last room is destroyed.
    if (room.namespace !== 'main' && room.namespace !== 'editor') {
        const stillUsed = findRoomByNamespace(state, room.namespace);
        if (!stillUsed) state.namespaces.delete(room.namespace);
    }
}

/* ── Client membership ──────────────────────────────────────────── */

/**
 * Find an existing Player for (client, roomId, mode). Linear scan over the
 * client's Player set; the cardinality is small (one Player per open tab).
 */
export function findPlayer(state: Rooms, client: Client, roomId: string, mode: PlayerMode): Player | undefined {
    const ids = state.playersByClient.get(client);
    if (!ids) return undefined;
    for (const id of ids) {
        const p = state.players.get(id);
        if (p && p.roomId === roomId && p.mode === mode) return p;
    }
    return undefined;
}

/**
 * Allocate a Player for a (client, room, mode). Idempotent, returns the
 * existing Player if one already matches.
 *
 * Does NOT create the in-scene player node; that's `createPlayerNode`,
 * called from `addClientToRoom` / `buildUpRoomContent`.
 */
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

/**
 * Remove a Player by id. Does NOT destroy the in-scene player node,
 * caller's job (typically through leaveClientFromRoom or stopRoomInner /
 * destroyRoom).
 */
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

/**
 * Remove every Player belonging to a client. Used on disconnect.
 */
export function leaveAllRooms(state: Rooms, client: Client): void {
    const ids = state.playersByClient.get(client);
    if (!ids) return;
    for (const id of [...ids]) {
        leaveRoom(state, id);
    }
}

/* ── Active Player (presence only) ──────────────────────────────── */

/**
 * Set which Player the client has flagged as their active focus. Purely
 * informational, used for presence, not for command routing.
 */
export function setActivePlayer(state: Rooms, client: Client, playerId: PlayerId): void {
    if (!state.players.has(playerId)) return;
    state.activePlayer.set(client, playerId);
}

/**
 * The Player the client has flagged as their active focus, or undefined.
 */
export function getActivePlayer(state: Rooms, client: Client): Player | undefined {
    const id = state.activePlayer.get(client);
    if (!id) return undefined;
    return state.players.get(id);
}

export function getActivePlayerId(state: Rooms, client: Client): PlayerId | undefined {
    return state.activePlayer.get(client);
}

/* ── Queries ────────────────────────────────────────────────────── */

export function getRoom(state: Rooms, roomId: string): Room | undefined {
    return state.rooms.get(roomId);
}

export function getPlayer(state: Rooms, playerId: PlayerId): Player | undefined {
    return state.players.get(playerId);
}

/**
 * All Players for a client (may include multiple per roomId, with different
 * modes).
 */
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

/**
 * Unique room ids a client has any Player in (deduped across modes).
 */
export function getRoomsForClient(state: Rooms, client: Client): Set<string> {
    const out = new Set<string>();
    for (const p of getPlayersForClient(state, client)) {
        out.add(p.roomId);
    }
    return out;
}

/**
 * Distinct clients currently in a room, deduped across modes (a client
 * holding both an edit and a play Player in the same room counts once).
 */
export function getClientsInRoom(state: Rooms, room: Room): Set<Client> {
    const out = new Set<Client>();
    for (const id of room.players) {
        const p = state.players.get(id);
        if (p) out.add(p.client);
    }
    return out;
}

/**
 * All Players currently in a room (every (client, mode) combination).
 */
export function getPlayersInRoom(state: Rooms, room: Room): Player[] {
    const out: Player[] = [];
    for (const id of room.players) {
        const p = state.players.get(id);
        if (p) out.push(p);
    }
    return out;
}

/**
 * Find an existing edit room for a given scene file, if one exists.
 */
export function findEditRoomBySceneId(state: Rooms, sceneId: string): Room | undefined {
    for (const room of state.rooms.values()) {
        if (room.mode === 'edit' && room.sceneId === sceneId) {
            return room;
        }
    }
    return undefined;
}

/**
 * All rooms that share the given namespace. Used by the play-session
 * lifecycle (e.g. cascading stops on a namespace-root room) and by the
 * authored rooms.* API to enforce namespace scoping on cross-room calls.
 */
export function findRoomsInNamespace(state: Rooms, namespace: string): Room[] {
    const out: Room[] = [];
    for (const room of state.rooms.values()) {
        if (room.namespace === namespace) out.push(room);
    }
    return out;
}

/**
 * The (at most one) room currently occupying the given namespace. Used
 * by the matchmaking-style join flow to find-or-create a play room keyed
 * on canonicalJson(options). Returns the first match, namespaces
 * are unique per session, so there's only ever one root.
 */
export function findRoomByNamespace(state: Rooms, namespace: string): Room | undefined {
    for (const room of state.rooms.values()) {
        if (room.namespace === namespace) return room;
    }
    return undefined;
}

/* ── higher-level room ops ─────────────────────────────────────── */

export function initializeRoom(state: EngineServer, room: Room): void {
    const t0 = performance.now();
    // wire server context before loading the scene so onInit handlers can
    // safely access ctx.server.state and ctx.server.room
    room.context.server = {
        state,
        room,
        get options() {
            return state.rooms.namespaces.get(room.namespace)?.options ?? {};
        },
    };

    // dispose the placeholder physics from createRoom, re-init below.
    // The Jolt world from createRoom isn't explicitly destroyed (no
    // world-destroy fn exists today); WASM-side leak is one world per
    // room boot.
    const disposeT0 = performance.now();
    Physics.dispose(room.physics);
    const disposeMs = performance.now() - disposeT0;

    // single scene file read covers both halves. load voxels BEFORE
    // loading the scene graph: loadSceneTree fires script onInit hooks
    // synchronously, and those hooks may call setBlock to author terrain.
    // loadVoxels clears voxels.chunks, so it must run first or it will
    // wipe whatever the scripts wrote.
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
        // seed dedupe cache so the first flush compares against real disk
        // bytes, see saveScene / engine-server boot loop for context.
        ContentManager.putScene(state.contentManager, room.sceneId, sceneFile.raw);
    }

    const physT0 = performance.now();
    room.physics = Physics.init(room.scene, room.voxels);
    const physMs = performance.now() - physT0;
    room.context.physics = room.physics;

    // Attach the WorldTrait (system host) HERE — the single point,
    // reached after context.server is wired (top of this fn) and after
    // loadSceneTree. So each system's factory + onInit fires exactly once, with
    // ctx.server live. (loadSceneTree wouldn't carry these anyway: persist: false.)
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

/**
 * Attach a client to a room as a Player. Allocates a new Player if one does
 * not already exist for (client, room, mode). Creates an in-scene player
 * node + fires join hooks for the new Player, sets it active, invalidates
 * discovery. Returns the Player.
 */
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
    // Stamp the resolved avatar onto the player's CharacterTrait BEFORE
    // firing join hooks, so onJoin observes the right modelId/rigType and
    // JoinArgs carries it.
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

/**
 * Create + initialize a room in an explicit namespace. Used by editor
 * command handlers to mint play-session and editor namespaces. Authored
 * scripts cannot reach this, api/rooms.create inherits the caller's
 * namespace.
 */
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

    // snapshot Players before mutating room.players. each (client, mode)
    // gets its own outbound room_left.
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

    // route any client whose active Player was here to a fallback Player
    // they already hold in the fallback room. We don't auto-mint Players in
    // the fallback, leaveClientFromRoom handles that path explicitly.
    if (fallback) {
        for (const client of affectedClients) {
            if (state.rooms.activePlayer.has(client)) continue;
            const fp = findPlayer(state.rooms, client, fallback.id, fallback.mode);
            if (fp) setActivePlayer(state.rooms, client, fp.id);
        }
    }

    Discovery.invalidateRoomList(state.discovery);
}

/* ── Deferred lifecycle (drained post-tick) ─────────────────────── */

/**
 * Queue a stop to be applied after the current tick block. Use this
 * from any caller that may run inside a per-room tick (script hooks,
 * physics callbacks), direct stopRoom() during iteration would tear
 * down nodes mid-loop.
 */
export function queueStopRoom(state: Rooms, roomId: string): void {
    state.pendingStops.add(roomId);
}

/**
 * Apply queued stops. Called from engine-server.update once per tick
 * after every room has ticked.
 */
export function drainPending(state: EngineServer): void {
    if (state.rooms.pendingStops.size > 0) {
        const ids = [...state.rooms.pendingStops];
        state.rooms.pendingStops.clear();
        for (const id of ids) stopRoom(state, id);
    }
}

/**
 * Drop a single Player. Destroys its in-scene node, notifies the client
 * the room was left, and routes the client back to the default room if
 * they have no remaining active Player.
 */
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

/**
 * Create the in-scene player node and attach the trait stack every
 * player wears (Transform + Player + Character). Does NOT fire join
 * hooks or drive the avatar lifecycle, both are owned by the caller
 * (`addClientToRoom` for fresh joins; the reseed branch of
 * `leaveClientFromRoom` for fallback Players).
 *
 * CharacterTrait is the engine's default visual; it boots with the
 * builtin baseAvatar `modelId` and converges to the user's resolved
 * avatar once the avatar subsystem stamps the real id onto it. Game
 * code can replace or remove the trait from `onJoin` if it wants a
 * different visual.
 */
export function createPlayerNode(state: EngineServer, room: Room, player: Player): Node {
    const sg = room.scene;
    const node = createNode({ name: `player:${player.id}`, persist: false });
    addChild(sg.root, node);
    setOwner(sg, node, player.id);
    const cs = state.clients.connected.get(player.client);
    // shared with client-authoritative local rooms (see addPlayerTraits): Transform +
    // Player + character rig, and default humanoid controls for play-mode players.
    // edit rooms want a much larger streaming radius so editors can see/edit most of
    // the world without the camera clipping the streaming frontier.
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

/**
 * Handle a `play` message. Dual-purpose: the editor "Play" button (mints a fresh
 * `play-<uuid>` namespace each press) and game `client.matchmake({options})`
 * (keys the namespace on canonicalJson(options) so same-opts callers converge).
 * Finds-or-creates the room, drops any prior play membership elsewhere, joins,
 * and activates.
 */
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

    // drop any prior play-mode membership in a different room so a re-entry
    // doesn't accumulate Players.
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

/**
 * Apply an owner client's `sync_update`: validate the sender owns the target
 * node in the named room, resolve the trait by the client's wire index, then
 * hand the fields to Discovery (which updates the diff snapshot + client
 * knowledge). Drops silently on any ownership / resolution mismatch.
 */
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
