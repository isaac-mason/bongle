import fs from 'node:fs/promises';
import type { Client, JsonValue, ServerDriver, User } from '@bongle/interface';
import { env } from 'bongle';
import * as Clock from '../core/clock';
import * as Debug from '../core/debug';
import * as physics from '../core/physics/physics';
import * as Protocol from '../core/protocol';
import * as Nodes from '../core/scene/nodes';
import * as Prefab from '../core/scene/prefab';
import * as Animation from '../core/scene/animation';
import { buildWireIndex, registry, touch } from '../core/registry';
import * as Scripts from '../core/scene/scripts';
import { runBlockEventHooks } from '../core/voxels/block-hooks';
import * as Light from '../core/voxels/light';
import { saveVoxels } from '../core/voxels/voxel-savefile';
import * as Avatars from './avatars';
import * as Chat from './chat';
import * as Clients from './clients';
import type { ClientState } from './clients';
import * as Discovery from './discovery';
import * as Net from './net';
import * as Rooms from './rooms';
import * as Rpc from '../core/rpc';
import * as ServerRpc from './rpc';
import * as ContentManager from './content-manager';
import * as ResourceManager from './resource-manager';
import * as Content from '../core/content';
import * as Resources from '../core/resources';
import { DEFAULT_SCENE_ID } from '../core/scene/scene-handle';
import type * as EditorModule from '../editor/index';
import { clearPendingChanges } from '../core/registry';

// Re-export the registry-dispatch entry so consumers (kit boot entries,
// kit internals) can call `EngineServer.applyRegistryChanges(state)`
// through the existing namespace without reaching into engine internals
// directly.
export { applyRegistryChanges } from './registry-dispatch';
export { DEFAULT_SCENE_ID };
const FLUSH_INTERVAL_MS = 1000; // 5000;

/** cached editor module ref — populated by load() when env.editor */
let _editor: typeof EditorModule | undefined;

export type InitOptions = {
    mode: 'edit' | 'play';
    /**
     * Absolute path to the project's `content/` root. Wrapper bakes this
     * via `import.meta.url`-relative resolution so engine code never
     * resolves authored content against process cwd.
     */
    contentDir: string;
    /**
     * Absolute path to the project's `resources/server/` root. Same
     * baking story as `contentDir`. Model bins live under
     * `<resourcesDir>/models/<id>.<hash>.server.bin`.
     */
    resourcesDir: string;
    /**
     * Matchmaker grouping key for this server's `main` namespace. Stamped at
     * init so scripts can read it via `ctx.server.gameOptions`.
     */
    options?: Record<string, string | number | boolean>;
    /**
     * Side-effect handle for persistent KV (gameStorage / userStorage).
     * Deployed: HTTP driver pointed at the service. Kit-dev / editor: an
     * in-memory impl. Required — scripts can call storage APIs at any
     * point so a missing driver would only manifest at first call.
     */
    driver: ServerDriver;
};

export function init(opts: InitOptions) {
    const net = Net.init();
    const clients = Clients.init();
    const rooms = Rooms.init();
    if (opts.options && Object.keys(opts.options).length > 0) {
        Rooms.setNamespaceGameOptions(rooms, 'main', opts.options);
    }
    const contentManager = ContentManager.init({ contentDir: opts.contentDir });
    const resourceManager = ResourceManager.init({ resourcesDir: opts.resourcesDir });
    const content = Content.init();
    // model bins: ModelHandle.bin.server stores a path relative to
    // resourcesDir (asset-pipeline's SERVER_URL_PREFIX). resolveModelBin
    // joins it onto the absolute resourcesDir baked above — independent
    // of process cwd. Runtime-source models (avatars) carry absolute
    // https URLs (R2) — branch on scheme.
    const resources = Resources.init(
        (url) => {
            if (url.startsWith('http:') || url.startsWith('https:')) {
                return fetch(url).then(async (r) => {
                    if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
                    return new Uint8Array(await r.arrayBuffer());
                });
            }
            return fs.readFile(ResourceManager.resolveModelBin(resourceManager, url));
        },
        'server',
    );
    const discovery = Discovery.init();

    // server-side rpc. driver constructed by ./rpc; listener registry +
    // dispatch live in core/rpc. one shared instance across all rooms;
    // listen() scopes per-room via runtime.roomId.
    const rpc = Rpc.init(ServerRpc.createDriver(net, rooms));

    return {
        net,
        clients,
        rooms,
        contentManager,
        resourceManager,
        content,
        resources,
        discovery,
        driver: opts.driver,
        mode: opts.mode,
        defaultRoomId: null as string | null,
        /** timestamp of last flush to disk */
        lastFlushTime: 0,
        rpc,
        /** Clients whose avatar resolve has landed but whose model is
         *  still loading into Resources. Drained per update tick by
         *  `Avatars.drainPending`. */
        pendingAvatarClients: new Set<ClientState>(),
        /** global metrics (tick timing) */
        metrics: Debug.createMetrics() as Debug.Metrics,
        /**
         * debug log subscribers: per-client `roomId → last cursor sent`
         * cache. presence in the outer map = client wants pushes; the inner
         * map's roomIds are discovered lazily from the client's Players.
         * cleaned up on disconnect and when rooms vanish.
         */
        debugLogSubscribers: new Map<Client, Map<string, number>>(),
    };
}

export type EngineServer = ReturnType<typeof init>;

/* ── client join / leave ── */

/**
 * Engine-side join: writes identity to ClientState, runs the cap check,
 * pushes declared scenes, places the client in the default room, and fires
 * the `onJoin` script hook with `user` + `joinData`. The runtime/wrapper
 * calls this directly. `joinData` is a one-shot: scripts that want it past
 * the join must copy it themselves.
 *
 * gameOptions are NOT routed here — they live on namespaces (set by the
 * runtime at boot for deployed, or by the `play` handler for in-game
 * `client.matchmake`). The default room's namespace is pre-stamped.
 */
export function onClientJoin(
    state: EngineServer,
    clientId: Client,
    user: User,
    joinData: Record<string, JsonValue>,
) {
    // seed the client's inbound wire-index tables from our local registry.
    // both peers built from the same source, so the client's outbound
    // tables match ours at connect time. subsequent `wire_table` messages
    // from this client refresh these as its HMR cycles diverge ours.
    Clients.onJoin(
        state.clients,
        clientId,
        user,
        registry.traitWireIndex,
        registry.commandWireIndex,
    );

    // sync wire tables before any packed payload reaches the client.
    // client and server build their `traitWireIndex` from module-load
    // order, which can diverge across builds — we can't rely on the
    // optimistic "both peers built from the same source" assumption
    // at first connect.
    Net.send(state.net, clientId, {
        type: 'wire_table',
        traits: registry.traitWireIndex.indexToId,
        commands: registry.commandWireIndex.indexToId,
    });

    // kick the avatar resolve as soon as identity is in place. resolve
    // runs unconditionally for every client; bundled and runtime alike
    // flow through the same hasModel poll before the avatar is stamped
    // onto each waiting Player's CharacterTrait.
    const cs = state.clients.connected.get(clientId);
    if (cs) Avatars.kickResolve(state, cs);

    // belt-and-suspenders cap check. the matchmaker (and gatho admission)
    // are the primary gates and shouldn't let a past-cap client reach
    // here — but if one does (race, manual connection, whatever), drop
    // it on the floor rather than silently growing the room. edit mode
    // is a single-user editor; the cap doesn't apply. by this point
    // ClientState already includes the new client, so compare against `>`.
    if (state.mode === 'play') {
        const cap = registry.matchmakingConfig.maxPlayers;
        if (state.clients.connected.size > cap) {
            console.warn(`[engine-server] rejecting client ${clientId}: room at maxPlayers (${cap})`);
            Clients.onLeave(state.clients, clientId);
            return;
        }
    }

    Discovery.addClient(state.discovery, clientId);

    // scenes are baked into the client bundle (codegen barrel
    // `src/generated/scenes.ts`); no per-join wire push needed.

    const defaultRoomId = state.defaultRoomId;
    const targetRoom = defaultRoomId ? Rooms.getRoom(state.rooms, defaultRoomId) : undefined;

    if (targetRoom) {
        const player = Rooms.addClientToRoom(state, clientId, targetRoom, undefined, joinData);
        Net.send(state.net, clientId, { type: 'activate_room', playerId: player.id });
    }
}

export function onClientLeave(state: EngineServer, clientId: Client) {
    // fire leave hooks and destroy player nodes for every Player this
    // client holds (across rooms and modes) before dropping the registry
    // entries.
    const leavingName = state.clients.connected.get(clientId)?.user.username || 'anon';
    for (const player of Rooms.getPlayersForClient(state.rooms, clientId)) {
        const room = Rooms.getRoom(state.rooms, player.roomId);
        if (!room) continue;
        const playerNode = room.playerNodes.get(player.id);
        if (playerNode) Scripts.fireLeaveHooks(room.scriptRuntime, clientId, playerNode);
        Chat.broadcast(room.chat, {
            from: 'system',
            text: `${leavingName} left`,
            kind: 'system',
        });
        Rooms.destroyPlayerNode(room, player.id);
    }
    Rooms.leaveAllRooms(state.rooms, clientId);
    const cs = state.clients.connected.get(clientId);
    if (cs) Avatars.releaseClientAvatar(state, cs);
    Clients.onLeave(state.clients, clientId);
    Discovery.removeClient(state.discovery, clientId);
    Discovery.invalidateRoomList(state.discovery);
    state.debugLogSubscribers.delete(clientId);
}

/**
 * (re)seed `state.resources.models` + `state.resources.modelPayloads` from
 * the captured `ProjectModule.models`. drops any old entries first —
 * covers the hot-reload case where models were renamed/removed/changed
 * bins. callers must have already loaded the new project module so the
 * captured handles reflect the new build.
 */
function seedModels(state: EngineServer): void {
    state.resources.modelPayloads.clear();
    state.resources.models.clear();
    for (const [id, h] of registry.models.byId) {
        const handle = h.payload;
        Resources.setModel(state.resources, id, {
            clientUrl: handle.bin.client,
            serverUrl: handle.bin.server,
            source: 'bundled',
            handle,
        });
    }
}

/**
 * record per-message-type net metrics + game/total aggregates onto a
 * room's Metrics bag. byteCounts are split across rooms (1/roomCount) so
 * the per-room number reflects this room's share of global throughput.
 *
 * - `net/in/<type>` / `net/out/<type>` — per-type kb/s (breakdown widget).
 * - `net/ingress` / `net/egress` — "game" headline (excludes debug types).
 * - `net/in/total` / `net/out/total` — true totals (incl. debug).
 */
function recordNetStats(metrics: Debug.Metrics, stats: Net.NetStats, delta: number, roomCount: number): void {
    let inGame = 0;
    let outGame = 0;
    for (const [type, bytes] of stats.bytesInByType) {
        const kbps = bytes / 1024 / delta / roomCount;
        Debug.record(metrics, `net/in/${type}`, kbps);
        if (!Protocol.DEBUG_MESSAGE_TYPES.has(type)) inGame += bytes;
    }
    for (const [type, bytes] of stats.bytesOutByType) {
        const kbps = bytes / 1024 / delta / roomCount;
        Debug.record(metrics, `net/out/${type}`, kbps);
        if (!Protocol.DEBUG_MESSAGE_TYPES.has(type)) outGame += bytes;
    }
    Debug.record(metrics, 'net/ingress', inGame / 1024 / delta / roomCount);
    Debug.record(metrics, 'net/egress', outGame / 1024 / delta / roomCount);
    Debug.record(metrics, 'net/in/total', stats.bytesIn / 1024 / delta / roomCount);
    Debug.record(metrics, 'net/out/total', stats.bytesOut / 1024 / delta / roomCount);
}

/* ── sync_update handling ── */
// per-sync sync_update handling is inline in the processInbox switch case.
// authority:'owner' checks use def.syncDefs[syncIdx].authority.

/**
 * Complete initialization after init() - loads module, creates rooms, loads scenes.
 * This is async so scene loading can happen after module load.
 */
export async function load(state: EngineServer) {
    const mode = state.mode;

    // import editor module before loading user module so editor commands
    // upsert into the registry first.
    if (env.editor) {
        _editor = await import('../editor/index');
        await _editor.registerServer(state);
        // expose state + api on globalThis for ad-hoc inspection via
        // `bun --inspect` / chrome devtools. `_state` is the full
        // EngineServer; `_api` is the same surface user scripts import
        // from 'bongle'. dynamic import keeps the api module out of
        // non-editor bundles.
        const api = await import('bongle');
        const g = globalThis as unknown as { _state: typeof state; _api: typeof api };
        g._state = state;
        g._api = api;
    }

    // seed Resources.models from the registry. lazy systems (renderer,
    // animator, auto-collider) trigger ensureModel on first reference.
    seedModels(state);

    // walk declared scenes and apply each handle's authored `_payload` (set
    // by the codegen barrel's `_registerScenePayload` at module-eval, drained
    // by `scene()`). `applyScenePayload` also seeds ContentManager's
    // `_lastWritten` so subsequent file writes can dedupe their watcher
    // events against the actual disk bytes. a handle with `_payload === null`
    // is declared but has no file on disk yet — the codegen layer already
    // warned at build time; handle stays empty.
    for (const [sceneId, h] of registry.scenes.byId) {
        const handle = h.payload;
        if (!handle._payload) continue;
        applyScenePayload(state, sceneId, handle._payload);
    }

    // create the default room. editor scripts (if env.editor) attach
    // automatically when the first edit-mode client joins, driven by
    // edit-membership refcount in Rooms.joinRoom.
    const defaultRoom =
        mode === 'edit' ? Rooms.findOrCreateEditRoom(state, DEFAULT_SCENE_ID) : Rooms.createPlayRoom(state, DEFAULT_SCENE_ID);
    state.defaultRoomId = defaultRoom.id;

    // initial registry population is consumed directly via the registry —
    // drop the `added` events accumulated on `pendingChanges` so the first
    // HMR flush only logs real deltas. (Symmetric with EngineClient.load.)
    clearPendingChanges([
        registry.blockTextures,
        registry.blocks,
        registry.models,
        registry.prefabs,
        registry.scenes,
        registry.traits,
        registry.controls,
        registry.sync,
        registry.scripts,
        registry.commands,
        registry.matchmaking,
        registry.sounds,
    ]);
}

/**
 * apply an authored scene payload: stamp it onto the handle's `_payload`,
 * seed `ContentManager._lastWritten` so the editor's own writes dedupe
 * against their own watcher events, then `populateScene`. invoked by:
 *   - `load()` at boot for every declared handle whose `_payload` was
 *     seeded by the codegen barrel.
 *   - the boot template's `bongle:scene-update` HMR listener for live
 *     content edits.
 *   - the server registry-dispatch scenes branch for `added` / `changed`.
 */
export function applyScenePayload(state: EngineServer, id: string, payload: Content.ScenePayload): void {
    const handle = registry.scenes.byId.get(id)?.payload;
    if (!handle) return;
    handle._payload = payload;
    ContentManager.seedLastWrittenRaw(
        state.contentManager,
        id,
        ContentManager.serializeScenePayload(payload),
    );
    Content.populateScene(state.content, registry.blockRegistry, id, payload, 'server');
    touch(registry.scenes, id);
}

/**
 * clear a scene's authored payload and tear down its populated handle.
 * invoked by the boot template's `bongle:scene-clear` HMR listener (file
 * deletion) and the server registry-dispatch scenes branch for `removed`.
 */
export function clearScene(state: EngineServer, id: string): void {
    const handle = registry.scenes.byId.get(id)?.payload;
    if (handle) handle._payload = null;
    Content.clearScene(state.content, id, 'server');
    touch(registry.scenes, id);
}

export function processInbox(state: EngineServer) {
    // process inbox — count ingress bytes
    const inbox = state.net.inbox;

    for (const [client, packets] of inbox) {
        for (const packet of packets) {
            const unpacked = Protocol.unpackClientPacket(packet);

            for (const messageBytes of unpacked.messages) {
                const message = Protocol.unpackClientMessage(messageBytes);
                if (!message) continue;
                // bill ingress per message.type using the original bytes
                // view length — packcat decodes uint8Array as a subarray
                // view into the source packet, so this is zero-copy.
                state.net.bytesInByType.set(
                    message.type,
                    (state.net.bytesInByType.get(message.type) ?? 0) + messageBytes.byteLength,
                );

                switch (message.type) {
                    case 'set_active_room': {
                        // presence only — update which Player the client is focused on
                        const player = Rooms.getPlayer(state.rooms, message.playerId);
                        if (player && player.client === client) {
                            Rooms.setActivePlayer(state.rooms, client, player.id);
                        }
                        break;
                    }
                    case 'ping':
                        Net.send(state.net, client, { type: 'pong' });
                        break;

                    case 'request_metrics': {
                        const room = Rooms.getRoom(state.rooms, message.roomId);
                        if (!room) break;
                        // merge room metrics with global tick metric
                        const values = {
                            ...Debug.getLatestValues(room.metrics),
                            tick: Debug.getLatestValues(state.metrics).tick ?? 0,
                        };
                        Net.send(state.net, client, { type: 'room_metrics', roomId: room.id, values });
                        break;
                    }

                    case 'debug_subscribe': {
                        if (message.enabled) {
                            if (!state.debugLogSubscribers.has(client)) {
                                state.debugLogSubscribers.set(client, new Map());
                            }
                        } else {
                            state.debugLogSubscribers.delete(client);
                        }
                        break;
                    }

                    case 'net_message': {
                        const cs = state.clients.connected.get(client);
                        if (!cs) break;
                        Rpc.dispatchNetMessage(state.rpc, cs.inboundCommandWireIndex, message, client);
                        break;
                    }

                    case 'wire_table': {
                        const cs = state.clients.connected.get(client);
                        if (!cs) break;
                        cs.inboundTraitWireIndex = buildWireIndex(message.traits);
                        cs.inboundCommandWireIndex = buildWireIndex(message.commands);
                        break;
                    }

                    case 'sync_update': {
                        const room = Rooms.getRoom(state.rooms, message.roomId);
                        if (!room) break;

                        const node = Nodes.getNodeById(room.nodes, message.nodeId);
                        if (!node || node.owner === null) break;
                        const ownerPlayer = state.rooms.players.get(node.owner);
                        if (!ownerPlayer || ownerPlayer.client !== client || ownerPlayer.roomId !== room.id) break;

                        const cs = state.clients.connected.get(client);
                        if (!cs) break;
                        const traitId = cs.inboundTraitWireIndex.indexToId[message.traitNetIndex];
                        if (traitId === undefined) break;
                        const def = registry.traits.byId.get(traitId)?.payload;
                        if (!def) break;

                        const instance = node._traits.get(def.slot);
                        if (!instance) break;

                        // apply values, update diff snapshot + client knowledge in one op
                        Discovery.acceptOwnerFields(
                            state.discovery,
                            state.rooms,
                            room.id,
                            client,
                            room.nodes,
                            node,
                            def,
                            instance,
                            message.fields,
                            room.mode,
                        );

                        break;
                    }

                    case 'open_scene': {
                        // editor edit rooms all share the 'editor' namespace; reuse
                        // existing room when the scene is already open, otherwise mint
                        // a new one.
                        const room = Rooms.findOrCreateEditRoom(state, message.sceneId);
                        const player = Rooms.addClientToRoom(state, client, room, 'edit');
                        Net.send(state.net, client, { type: 'activate_room', playerId: player.id });
                        break;
                    }

                    case 'play': {
                        // dual-purpose:
                        // - editor "Play" button: { sceneId, sourceRoomId }; mints a
                        //   fresh `play-<uuid>` namespace each press (matchmaking-free
                        //   preview).
                        // - game `client.matchmake({gameOptions, joinData})`: keys the
                        //   namespace on canonicalGameOptions so callers with the same
                        //   opts converge into one room. The namespace metadata stamps
                        //   `gameOptions` so scripts can read it back via
                        //   `ctx.server.gameOptions`.
                        const sceneId = message.sceneId ?? DEFAULT_SCENE_ID;
                        const t0 = performance.now();

                        let namespace: string;
                        let joinData: Record<string, JsonValue> = {};
                        if (message.gameOptions) {
                            const gameOptions = JSON.parse(message.gameOptions) as Record<string, string | number | boolean>;
                            namespace = Rooms.canonicalJson(gameOptions);
                            Rooms.getOrCreateNamespace(state.rooms, namespace, gameOptions);
                            if (message.joinData) joinData = JSON.parse(message.joinData) as Record<string, JsonValue>;
                        } else {
                            namespace = `play-${Nodes.generateUuid()}`;
                            Rooms.getOrCreateNamespace(state.rooms, namespace, {});
                        }

                        let room = Rooms.findRoomByNamespace(state.rooms, namespace);
                        const createT0 = performance.now();
                        let createdRoom = false;
                        if (!room) {
                            room = Rooms.createRoomInNamespace(state, sceneId, 'play', namespace, true, message.sourceRoomId);
                            createdRoom = true;
                        }
                        const createMs = performance.now() - createT0;

                        // drop any prior play-mode membership in a different room so
                        // a client.matchmake re-entry doesn't accumulate Players.
                        const prior = Rooms.findPlayer(state.rooms, client, room.id, 'play');
                        if (!prior) {
                            for (const p of Rooms.getPlayersForClient(state.rooms, client)) {
                                if (p.mode === 'play' && p.roomId !== room.id) Rooms.leaveClientFromRoom(state, p.id);
                            }
                        }

                        const joinT0 = performance.now();
                        const player = Rooms.addClientToRoom(state, client, room, 'play', joinData);
                        const joinMs = performance.now() - joinT0;
                        Net.send(state.net, client, { type: 'activate_room', playerId: player.id });
                        const totalMs = performance.now() - t0;
                        console.log(
                            `[room-start] play sceneId=${sceneId} created=${createdRoom} ` +
                            `create=${createMs.toFixed(1)}ms join=${joinMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms`,
                        );
                        break;
                    }

                    case 'stop_room': {
                        Rooms.stopRoom(state, message.roomId);
                        break;
                    }

                    case 'leave_room': {
                        const player = Rooms.findPlayer(state.rooms, client, message.roomId, message.mode);
                        if (!player) break;
                        Rooms.leaveClientFromRoom(state, player.id);
                        break;
                    }

                    case 'join_room_as': {
                        const room = Rooms.getRoom(state.rooms, message.roomId);
                        if (!room) break;
                        const player = Rooms.addClientToRoom(state, client, room, message.mode);
                        Net.send(state.net, client, { type: 'activate_room', playerId: player.id });
                        break;
                    }

                    case 'rename_scene': {
                        Rooms.renameScene(state, message.oldSceneId, message.newSceneId);
                        break;
                    }

                    case 'delete_scene': {
                        Rooms.deleteScene(state, message.sceneId);
                        break;
                    }

                    case 'chat_input': {
                        const room = Rooms.getRoom(state.rooms, message.roomId);
                        if (!room) break;
                        Chat.enqueueInput(room.chat, { line: message.line, from: client });
                        break;
                    }
                }
            }
        }
    }

    inbox.clear();
}

export function update(state: EngineServer, delta: number) {
    Debug.begin(state.metrics, 'tick');

    processInbox(state);

    // tick all rooms
    for (const room of state.rooms.rooms.values()) {
        Debug.begin(room.metrics, 'room');

        room.tick++;
        Clock.tick(room.clock, delta);

        Nodes.runOnUpdate(room.nodes, { delta });

        Nodes.runOnTick(room.nodes, { delta });

        // sample animations into rig TransformTraits before physics so the
        // teleport detector picks up the new pose this tick (matches client).
        Animation.tick(room.animations, state.resources, delta);

        // post-animation hooks: procedural overrides (head-look, springs, etc.)
        // run after animator sampling, before downstream consumers read world matrices.
        Nodes.runOnPostAnimate(room.nodes, { delta });

        // tick prefab system — discovers and re-instantiates stale prefab nodes
        Prefab.tick(room.nodes, room.scriptRuntime, state.resources, room.voxels, 'server');

        physics.preStep(room.physics, room.nodes, state.resources, null, room.mode === 'play');

        Debug.begin(room.metrics, 'physics');
        physics.tick(room.physics, room.nodes, delta);
        Debug.end(room.metrics, 'physics');

        physics.postStep(room.physics, room.nodes, null);

        // run block hooks (recompute + observer events + onNeighbourChanged)
        // before light flush so lighting sees settled block state.
        Debug.begin(room.metrics, 'block-hooks');
        runBlockEventHooks(room.voxels);
        Debug.end(room.metrics, 'block-hooks');

        // batch light update for all blocks changed during this tick
        Debug.begin(room.metrics, 'lighting');
        Light.flushPendingLight(room.voxels);
        Debug.end(room.metrics, 'lighting');

        Nodes.runOnFrame(room.nodes, { delta });

        // drain chat inbox/outbox: parse queued `chat_input` lines from
        // clients (consumed by local handlers or promoted into outbox),
        // then broadcast every outbox entry as `chat_broadcast`.
        Chat.tick(room.chat, state.net, state.rooms, room, state.clients);

        // release per-tick physics scratch (voxel hit pool). MUST come after
        // every subShapeId consumer for this room — contact listeners,
        // getSurfaceNormal, getSupportingFace — has run.
        physics.flush(room.physics);

        Debug.end(room.metrics, 'room');
    }

    // drain queued reset/stop requests now that no room is mid-tick.
    Rooms.drainPending(state);

    // advance pending avatar loads — stamps the resolved modelId onto
    // each waiting Player's CharacterTrait once the model lands.
    Avatars.drainPending(state);

    // auto-persist edit rooms to disk on a fixed interval
    if (Date.now() - state.lastFlushTime > FLUSH_INTERVAL_MS) {
        flushAllRooms(state);
        state.lastFlushTime = Date.now();
    }

    // flush discovery — runs diff detection per room (serialize once),
    // then distributes updates to clients based on per-client knowledge
    Debug.begin(state.metrics, 'discovery');
    const pending = Discovery.flush(state.discovery, state.rooms, state.resources);
    const discoveryMs = Debug.end(state.metrics, 'discovery');

    for (const [client, message] of pending) {
        Net.send(state.net, client, message);
    }

    // record discovery time on each room
    for (const room of state.rooms.rooms.values()) {
        Debug.record(room.metrics, 'discovery', discoveryMs);
    }

    // push debug log deltas to subscribed clients. for each client with the
    // bit on, walk every room they hold a Player in, readDelta its log ring,
    // and emit one `debug_logs` per room with new entries since the cached
    // cursor. fresh rooms start at cursor 0 (sees the buffer's current tail).
    if (state.debugLogSubscribers.size > 0) {
        for (const [client, cursors] of state.debugLogSubscribers) {
            const seen = new Set<string>();
            for (const player of Rooms.getPlayersForClient(state.rooms, client)) {
                const roomId = player.roomId;
                if (seen.has(roomId)) continue;
                seen.add(roomId);
                const room = Rooms.getRoom(state.rooms, roomId);
                if (!room) continue;
                const cursor = cursors.get(roomId) ?? 0;
                const delta = Debug.readDelta(room.logs, cursor);
                if (delta.entries.length === 0 && delta.dropped === 0) continue;
                cursors.set(roomId, delta.cursor);
                Net.send(state.net, client, {
                    type: 'debug_logs',
                    roomId,
                    entries: delta.entries,
                    dropped: delta.dropped,
                });
            }
            // drop stale cursors for rooms the client no longer observes
            for (const key of cursors.keys()) {
                if (!seen.has(key)) cursors.delete(key);
            }
        }
    }

    // pack typed outbox messages into Uint8Array packets for the runtime
    Net.flush(state.net);

    // record net throughput per room. global bytes are split evenly across
    // rooms today — coarse but matches the per-room metric model. each
    // type lands as its own `net/{in,out}/<type>` metric so the debug
    // panel can break the rate down; `net/ingress` / `net/egress` are the
    // "game" headlines (excludes debug-typed bytes) so opening the panel
    // doesn't inflate its own number.
    const netStats = Net.drainNetStats(state.net);
    const roomCount = state.rooms.rooms.size || 1;
    for (const room of state.rooms.rooms.values()) {
        recordNetStats(room.metrics, netStats, delta, roomCount);
    }

    Debug.end(state.metrics, 'tick');
}

/* ── auto-persist ── */

/**
 * flush all edit rooms to disk. called on a fixed interval and on shutdown.
 */
function flushAllRooms(state: EngineServer): void {
    for (const room of state.rooms.rooms.values()) {
        if (room.mode !== 'edit') continue;

        const payload = {
            nodes: Nodes.saveSceneGraph(room.nodes),
            voxels: saveVoxels(room.voxels),
        };
        const sceneChanged = ContentManager.saveScene(state.contentManager, room.sceneId, payload);

        // bump the scene handle version so in-process consumers (cross-room
        // prefab readers in the same tick) see the new state immediately —
        // the file-watcher → HMR fan-out reaches the client out-of-band.
        if (sceneChanged) {
            Content.populateScene(state.content, registry.blockRegistry, room.sceneId, payload, 'server');
        }
    }
}

/* ── dispose ── */

/** tear down the server: destroy all rooms. */
export function dispose(state: EngineServer): void {
    for (const roomId of [...state.rooms.rooms.keys()]) {
        Rooms.destroyRoom(state.rooms, roomId);
    }

    state.defaultRoomId = null;
}
