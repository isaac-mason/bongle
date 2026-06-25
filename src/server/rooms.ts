import type { Client, JsonValue } from 'bongle/interface';
import type { PlayerId } from '../core/client';
import { env, PlayerTrait, TransformTrait } from 'bongle';
import { addCharacter } from '../builtins/character';
import { CharacterControllerTrait } from '../builtins/character-controller';
import { PlayerControllerTrait } from '../builtins/player-controller';
import { attachWorldTrait } from '../builtins/world';
import { createLogs, createMetrics, type Logs, type Metrics } from '../core/debug';
import * as Clock from '../core/clock';
import * as Physics from '../core/physics/physics';
import type { PlayerMode, RoomMode } from '../core/protocol';
import * as Content from '../core/content';
import { registry } from '../core/registry';
import type * as Resources from '../core/resources';
import * as Animation from '../core/scene/animation';
import {
    addChild,
    addTrait,
    bumpNodeVersion,
    createNode,
    createSceneGraph,
    destroyNode,
    hasTrait,
    loadSceneGraph,
    setOwner,
    type Node,
    type Nodes,
} from '../core/scene/nodes';
import * as Scripts from '../core/scene/scripts';
import type { NodesContext } from '../core/scene/scripts';
import { SetBlockFlags } from '../core/voxels/block-flags';
import type { Voxels } from '../core/voxels/voxels';
import { createVoxels, createVoxelsAuthority, setBlock } from '../core/voxels/voxels';
import { loadVoxels, type VoxelSaveCache } from '../core/voxels/voxel-savefile';
import * as Save from './save';
import { formatKey } from '../core/voxels/block-registry';
import * as Light from '../core/voxels/light';
import * as Avatars from './avatars';
import * as Chat from './chat';
import type { ChatServer } from './chat';
import * as Discovery from './discovery';
import * as ContentManager from './content-manager';
import type { EngineServer } from './engine-server';

/* ── Errors ─────────────────────────────────────────────────────── */

export class RoomNotFoundError extends Error {
    constructor(roomId: string) {
        super(`[bongle] room not found: ${roomId}`);
        this.name = 'RoomNotFoundError';
    }
}

/* ── Room ───────────────────────────────────────────────────────── */

export type { RoomMode as RoomKind } from '../core/protocol';

/** server-side state only edit rooms carry. lives on `Room.edit`, which is null
 *  on play rooms — so the type forbids dirtying or persisting a runtime room. */
export type RoomEditState = {
    /** unsaved edits since the last flush — gates the interval auto-flush. */
    dirty: boolean;
    /** per-chunk serialized-byte cache for incremental voxel save: seeded on
     *  load, refreshed on each flush, so `saveRoom` re-gzips only the chunks
     *  whose data version moved. */
    voxelSaveCache: VoxelSaveCache;
};

export type Room = {
    /** Unique runtime id (e.g. "room_1"). */
    id: string;

    /** Scene file path (e.g. "scenes/main.scene.json"). */
    sceneId: string;

    /** The live scene graph. */
    nodes: Nodes;

    /** Players (per (client, mode)) currently in this room. */
    players: Set<PlayerId>;

    /** edit-mode-only state (unsaved-edits flag + incremental-save cache). null
     *  on play rooms, which never persist. */
    edit: RoomEditState | null;

    /** Room mode. */
    mode: RoomMode;

    /** Play rooms: which edit room they were created from. */
    sourceRoomId: string | null;

    /** Runtime env for scripts in this room */
    scriptRuntime: NodesContext;

    /** PlayerId → in-scene node bearing PlayerTrait. one body per Player. */
    playerNodes: Map<PlayerId, Node>;

    /** per-room voxel data. always present (may be empty). */
    voxels: Voxels;

    /** per-room physics world. always present. */
    physics: Physics.Physics;

    /** per-room game clock (monotonic seconds). advanced once per server
     *  tick; pauses when ticks don't fire. read via `ctx.clock.time`. */
    clock: Clock.Clock;

    /** per-room animation state — caches the [AnimatorTrait] query consumed by
     *  `Animation.tick`. */
    animations: Animation.Animations;

    /** per-room server-side chat: command registry + broadcast transport. */
    chat: ChatServer;

    /** per-room performance metrics. */
    metrics: Metrics;

    /** per-room log buffer — script logs and tagged engine logs land here. */
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
 * A `Player` is a client's specific instance of being in a room — a child
 * concept of `Client` (which is the connection itself). One Player exists
 * per (client, room, mode) triple, identified by a server-allocated
 * `PlayerId`. A single client may hold multiple Players in the same room
 * if their modes differ (e.g. an editor view + a play view of the same
 * room, each shown as a separate tab).
 *
 * Each Player owns one in-scene node bearing PlayerTrait — accessed via
 * `room.playerNodes.get(player.id)` — which is where world observation
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
 * a fresh `play-<uuid>`. Game `client.matchmake({gameOptions})` keys a namespace
 * on `canonicalJson(opts)`. The namespace stores its own gameOptions so
 * scripts can read them back via `ctx.server.gameOptions` without the engine
 * needing a separate per-client cache.
 *
 * The 'main' and 'editor' ids are conventional roots that auto-cleanup
 * leaves alone (they live for the process lifetime).
 */
export type Namespace = {
    id: string;
    gameOptions: Record<string, string | number | boolean>;
};

/**
 * Stable JSON serialisation with lexicographically sorted keys. Same shape
 * as the matchmaker's canonicalisation in `apps/service/src/matchmaking/core.ts`,
 * so namespaces minted by `client.matchmake` here key into the same bucket
 * the matchmaker would.
 */
export function canonicalJson(opts: Record<string, string | number | boolean>): string {
    const sorted = Object.fromEntries(
        Object.entries(opts).sort(([a], [b]) => a.localeCompare(b)),
    );
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
 * gameOptions: if the namespace exists, `gameOptions` is ignored (use
 * `setNamespaceGameOptions` to overwrite). Called by `createRoom` so
 * every room is paired with a registered namespace.
 */
export function getOrCreateNamespace(
    state: Rooms,
    id: string,
    gameOptions?: Record<string, string | number | boolean>,
): Namespace {
    const existing = state.namespaces.get(id);
    if (existing) return existing;
    const ns: Namespace = { id, gameOptions: gameOptions ?? {} };
    state.namespaces.set(id, ns);
    return ns;
}

export function getNamespace(state: Rooms, id: string): Namespace | undefined {
    return state.namespaces.get(id);
}

/**
 * Overwrite the gameOptions on an existing namespace (creates if absent).
 * Runtime calls this once at boot in deployed (game-room) to stamp gatho's
 * `joinData.gameOptions` onto the 'main' namespace so scripts can read it.
 */
export function setNamespaceGameOptions(
    state: Rooms,
    id: string,
    gameOptions: Record<string, string | number | boolean>,
): void {
    const ns = state.namespaces.get(id);
    if (ns) {
        ns.gameOptions = gameOptions;
    } else {
        state.namespaces.set(id, { id, gameOptions });
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
    rpc: NodesContext['rpc'];
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
    // it. metadata (gameOptions) is set separately via setNamespaceGameOptions
    // or by the `play` handler when a gameOptions-keyed namespace is born.
    getOrCreateNamespace(state, namespace);

    const sceneGraph = createSceneGraph({
        mode: opts.kind,
        roomMode: opts.kind,
    });

    const blocks = registry.blockRegistry;
    const voxels = createVoxels(blocks);
    voxels.authority = createVoxelsAuthority();

    const physics = Physics.init(sceneGraph, voxels, blocks);

    const chat = Chat.init();
    const clock = Clock.init();

    const room: Room = {
        id,
        sceneId: opts.sceneId,
        nodes: sceneGraph,
        players: new Set(),
        edit: opts.kind === 'edit' ? { dirty: false, voxelSaveCache: new Map() } : null,
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
        scriptRuntime: {
            roomId: id,
            resources: opts.resources,
            client: undefined,
            server: undefined,
            rpc: opts.rpc,
            voxels,
            physics,
            clock,
            blocks,
            instances: new Map(),
        },
    };

    // wire the runtime into the scene graph so addTrait/registerSubtree can instantiate
    sceneGraph.runtime = room.scriptRuntime;

    state.rooms.set(id, room);

    // WorldTrait — always-attached scene-scoped script host. lives on
    // root so script(WorldTrait, …) factories fire exactly once per room.
    attachWorldTrait(room.nodes.root);

    // server-side editor concerns are always-attached on the room root in
    // dev builds. no-op when env.editor is false (the editor module never
    // registers the trait). per-player client activation lives on player
    // nodes — see createPlayerNode for edit rooms.
    attachEditorServerTrait(room);

    return room;
}

/**
 * Destroy a room. Fires leave hooks for every Player, tears down player
 * nodes + scene graph + physics, removes every Player belonging to this
 * room (across all clients/modes), and deletes it from the registry.
 */
/** flip a room's unsaved-edits flag. purely server-side: it gates the interval
 *  auto-flush (see engine-server `update`). set true on edits, false on flush. */
export function setRoomDirty(room: Room, value: boolean): void {
    // no-op on play rooms (edit === null) — they never persist.
    if (room.edit) room.edit.dirty = value;
}

export function destroyRoom(state: Rooms, roomId: string): void {
    const room = state.rooms.get(roomId);
    if (!room) return;

    for (const id of room.players) {
        const player = state.players.get(id);
        if (!player) continue;
        const playerNode = room.playerNodes.get(id);
        if (playerNode) Scripts.fireLeaveHooks(room.scriptRuntime, player.client, playerNode);
        destroyPlayerNode(room, id);
    }

    const children = room.nodes.root.children.slice();
    for (const child of children) {
        destroyNode(room.nodes, child);
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

    // auto-cleanup empty namespaces (except 'main' and 'editor' — these live
    // for the process lifetime and are conventional roots). `play`-minted
    // play-<uuid> namespaces vanish when their last room is destroyed.
    if (room.namespace !== 'main' && room.namespace !== 'editor') {
        const stillUsed = findRoomByNamespace(state, room.namespace);
        if (!stillUsed) state.namespaces.delete(room.namespace);
    }
}

/* ── Client membership ──────────────────────────────────────────── */

/**
 * Editor traits are looked up by id from the global trait registry (registered
 * by the editor module at import time). When env.editor is false the editor
 * module never loads, so these handles resolve to undefined and the helpers
 * no-op — keeping rooms.ts free of any editor/* import.
 *
 * Both traits are non-persisted (`persist: false`) so they never reach scene
 * files. The scripts bound to them run automatically as the trait attaches:
 *   - 'editor.server' (EditorServerTrait) on the room root → server-side
 *     command listeners + /relight
 *   - 'editor.state' (EditorTrait) on a player node → per-player client
 *     editor activation (replication delivers the trait to the owning
 *     client; the script body env.client-gates server-side replicas)
 */
const EDITOR_SERVER_TRAIT_ID = 'editor.server';
const EDITOR_STATE_TRAIT_ID = 'editor.state';

function attachEditorServerTrait(room: Room): void {
    const handle = registry.traits.byId.get(EDITOR_SERVER_TRAIT_ID)?.payload.handle;
    if (!handle) return;
    if (hasTrait(room.nodes.root, handle)) return;
    addTrait(room.nodes.root, handle);
}

function attachEditorStateTrait(node: Node): void {
    const handle = registry.traits.byId.get(EDITOR_STATE_TRAIT_ID)?.payload.handle;
    if (!handle) return;
    if (hasTrait(node, handle)) return;
    addTrait(node, handle);
}

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
 * Allocate a Player for a (client, room, mode). Idempotent — returns the
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
 * Remove a Player by id. Does NOT destroy the in-scene player node —
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
 * informational — used for presence, not for command routing.
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
 * Distinct clients currently in a room — deduped across modes (a client
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
 * on canonicalJson(gameOptions). Returns the first match — namespaces
 * are unique per session, so there's only ever one root.
 */
export function findRoomByNamespace(state: Rooms, namespace: string): Room | undefined {
    for (const room of state.rooms.values()) {
        if (room.namespace === namespace) return room;
    }
    return undefined;
}

/* ── higher-level room ops ─────────────────────────────────────── */

/**
 * seed a brand-new edit-mode scene with a 3x3 floor of the first registered
 * user block, centered on origin at y=0. gives the user something to stand
 * on and click instead of facing a void. only runs when no voxel file
 * exists on disk; once we save, subsequent boots load from there.
 */
function seedStarterFloor(room: Room): void {
    const blockRegistry = registry.blockRegistry;
    const firstUser = blockRegistry.defs.find((d) => d.id !== 'air');
    if (!firstUser) return;
    const key = formatKey(firstUser.id, firstUser.states, 0);
    for (let x = -1; x <= 1; x++) {
        for (let z = -1; z <= 1; z++) {
            setBlock(room.voxels, x, 0, z, key, SetBlockFlags.BULK);
        }
    }
    Light.propagateAllLight(room.voxels);
}

export function initializeRoom(state: EngineServer, room: Room): void {
    const t0 = performance.now();
    // wire server context before loading the scene so onInit handlers can
    // safely access ctx.server.state and ctx.server.room
    room.scriptRuntime.server = {
        state,
        room,
        get gameOptions() {
            return state.rooms.namespaces.get(room.namespace)?.gameOptions ?? {};
        },
    };

    let snapshotMs = 0;
    if (env.editor && room.mode === 'play' && room.sourceRoomId) {
        const sourceRoom = getRoom(state.rooms, room.sourceRoomId);
        // flush the source edit room so the play room boots from its live state —
        // but only if it's actually dirty (clean editor → no disk write), and
        // clear dirty after since this IS a save (no lingering false-dirty).
        if (sourceRoom?.edit?.dirty) {
            const snapT0 = performance.now();
            Save.saveRoom(state, sourceRoom);
            setRoomDirty(sourceRoom, false);
            snapshotMs = performance.now() - snapT0;
        }
    }

    // dispose the placeholder physics from createRoom — re-init below.
    // The Jolt world from createRoom isn't explicitly destroyed (no
    // world-destroy fn exists today); WASM-side leak is one world per
    // room boot.
    const disposeT0 = performance.now();
    Physics.dispose(room.physics);
    const disposeMs = performance.now() - disposeT0;

    // single scene file read covers both halves. load voxels BEFORE
    // loading the scene graph: loadSceneGraph fires script onInit hooks
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
            // seed the incremental-save cache from the on-disk bytes so the
            // first flush only re-gzips chunks edited since boot.
            Save.seedRoom(room, sceneFile.data.voxels);
            voxDeserMs = performance.now() - desT0;
        }
        const parseT0 = performance.now();
        loadSceneGraph(room.nodes, sceneFile.data.nodes);
        sceneParseMs = performance.now() - parseT0;
        // seed dedupe cache so the first flush compares against real disk
        // bytes — see saveScene / engine-server boot loop for context.
        ContentManager.seedLastWrittenRaw(state.contentManager, room.sceneId, sceneFile.raw);
    } else if (env.editor && room.mode === 'edit') {
        seedStarterFloor(room);
        // initial persist of a brand-new scene (empty cache → full serialize,
        // then seeds the cache for subsequent incremental flushes).
        Save.saveRoom(state, room);
    }

    const physT0 = performance.now();
    room.physics = Physics.init(room.nodes, room.voxels, registry.blockRegistry);
    const physMs = performance.now() - physT0;
    room.scriptRuntime.physics = room.physics;

    // re-attach after loadSceneGraph: it clears root._traits and re-populates
    // from persisted data, which never includes these traits (persist: false).
    // idempotent — no-op when createRoom already attached and load was skipped.
    attachWorldTrait(room.nodes.root);
    attachEditorServerTrait(room);

    Discovery.invalidateRoomList(state.discovery);

    const totalMs = performance.now() - t0;
    const chunkCount = room.voxels.chunks.size;
    const nodeCount = room.nodes.nodes.size;
    console.log(
        `[room-start]   initializeRoom mode=${room.mode} chunks=${chunkCount} nodes=${nodeCount} ` +
        `snapshot=${snapshotMs.toFixed(1)} dispose=${disposeMs.toFixed(1)} ` +
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
        room.scriptRuntime,
        client,
        user,
        joinData ?? {},
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
 * scripts cannot reach this — api/rooms.create inherits the caller's
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
        leaveRoom(state.rooms, snap.id);
        destroyPlayerNode(room, snap.id);
        if (player) Discovery.notifyPlayerLeft(state.discovery, state.net, player);
    }

    destroyRoom(state.rooms, roomId);

    // route any client whose active Player was here to a fallback Player
    // they already hold in the fallback room. We don't auto-mint Players in
    // the fallback — leaveClientFromRoom handles that path explicitly.
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
 * physics callbacks) — direct stopRoom() during iteration would tear
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
                Scripts.fireJoinHooks(
                    def.scriptRuntime,
                    client,
                    user,
                    {},
                    playerNode,
                    Avatars.clientAvatarIdentity(cs),
                );
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

export function renameScene(state: EngineServer, oldSceneId: string, newSceneId: string): void {
    if (!newSceneId.trim() || oldSceneId === newSceneId) return;

    const ok = ContentManager.renameScene(state.contentManager, oldSceneId, newSceneId);
    if (!ok) return;

    for (const room of state.rooms.rooms.values()) {
        if (room.sceneId === oldSceneId) room.sceneId = newSceneId;
    }

    Discovery.invalidateRoomList(state.discovery);
}

export function deleteScene(state: EngineServer, sceneId: string): void {
    if (!sceneId.trim()) return;

    // stop all rooms that use this scene
    for (const room of [...state.rooms.rooms.values()]) {
        if (room.sceneId === sceneId) {
            stopRoom(state, room.id);
        }
    }

    // clear the declared scene handle (no-op if not declared) + disk file
    Content.clearScene(state.content, sceneId, 'server');
    ContentManager.deleteScene(state.contentManager, sceneId);

    Discovery.invalidateRoomList(state.discovery);
}

/**
 * Create the in-scene player node and attach the trait stack every
 * player wears (Transform + Player + Character). Does NOT fire join
 * hooks or drive the avatar lifecycle — both are owned by the caller
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
    const sg = room.nodes;
    const node = createNode({ name: `player:${player.id}`, persist: false });
    addChild(sg.root, node);
    setOwner(sg, node, player.id);
    addTrait(node, TransformTrait);
    const trait = addTrait(node, PlayerTrait);
    trait.playerId = player.id;
    trait.client = player.client;
    // edit rooms want a much larger streaming radius so editors can see/edit
    // most of the world without the camera clipping the streaming frontier.
    trait.viewRadius = room.mode === 'edit' ? 24 : 8;
    const cs = state.clients.connected.get(player.client);
    if (cs) {
        trait.userId = cs.user.id;
        trait.username = cs.user.username;
    }
    // Add CharacterTrait + mount the rig now (not on the reconciler's first
    // frame) so join hooks can `findByName(playerNode, 'hand_right')` to attach
    // held items synchronously. The reconciler swaps in the resolved avatar later.
    addCharacter(node);
    // Default play-mode players to the standard humanoid controls (movement +
    // input/camera). It's the 90% case; games with a different control scheme
    // (or none) remove these in `onJoin`. Edit-mode players drive via the editor
    // lens, so they're left without.
    if (player.mode === 'play') {
        addTrait(node, CharacterControllerTrait);
        addTrait(node, PlayerControllerTrait);
    }
    // per-player editor activation follows the player's mode, not the room's
    // auth mode: an 'edit' player joining a play room (inspect-server) gets
    // the editor too. play-mode players use a client-local lens node instead
    // (enterLocalEditorView), so no server-side attach for those.
    if (player.mode === 'edit') attachEditorStateTrait(node);
    bumpNodeVersion(sg, node);
    room.playerNodes.set(player.id, node);
    return node;
}

export function destroyPlayerNode(room: Room, playerId: PlayerId): void {
    const node = room.playerNodes.get(playerId);
    if (!node) return;
    room.playerNodes.delete(playerId);
    destroyNode(room.nodes, node);
}
