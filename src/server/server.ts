import type { Client, Filesystem, JsonValue, ResolvedAvatar, ServerDriver, User } from 'bongle/interface';
import * as Clock from '../core/clock';
import { serverMaxPlayers } from '../core/config';
import * as Content from '../core/content';
import * as Debug from '../core/debug';
import { acceptFrame, createReassembler } from '../core/net';
import * as physics from '../core/physics/physics';
import * as Protocol from '../core/protocol';
import {
    buildInboundProtocol,
    clearPendingChanges,
    localInbound,
    protocolManifest,
    registry,
    reindexRegistry,
    resolveConfig,
    touch,
} from '../core/registry';
import * as Resources from '../core/resources';
import * as Rpc from '../core/rpc';
import * as Animation from '../core/scene/animation';
import * as Prefab from '../core/scene/prefab';
import { DEFAULT_SCENE_ID } from '../core/scene/scene-handle';
import * as SceneTree from '../core/scene/scene-tree';
import * as Scripts from '../core/scene/scripts';
import type { Zstd } from '../core/voxels/chunk-codec';
import * as Light from '../core/voxels/light';
import * as Avatars from './avatars';
import * as Chat from './chat';
import * as Clients from './clients';
import * as ContentManager from './content-manager';
import * as Discovery from './discovery';
import * as Net from './net';
import { seedModels } from './registry-dispatch';
import * as ResourceManager from './resource-manager';
import * as Rooms from './rooms';
import * as ServerRpc from './rpc';
import * as Save from './save';
import * as Telemetry from './telemetry';

// runtime avatar swap (editor live preview — re-register the edited glb under a
// fresh modelId + re-stamp the player without a re-join).
export { reloadClientAvatar } from './avatars';
// Re-export the registry-dispatch entry so the cli play realms (a dev loop over
// the play interface) can call `EngineServer.applyRegistryChanges(state)` from
// their flush handler. The editor + cli EDIT realms go through
// `engine-server-editor.watchRegistry` instead, so this stays off their path.
export { applyRegistryChanges } from './registry-dispatch';
export { DEFAULT_SCENE_ID };

export type InitOptions = {
    mode: 'edit' | 'play';
    /**
     * The project filesystem: authored scenes under `content/scenes/`, server
     * model bins under `resources/server/`. Host-provided (node fs / OPFS / vfs)
     * so the engine stays node-free; the engine owns the path conventions. Scene
     * edits persist back through `fs.write` in edit mode; play/solo are read-only.
     */
    fs: Filesystem;
    /**
     * zstd impl `{ compress(payload, level) }` for the voxel wire codec.
     * Host-provided so the engine never hard-depends on a node zlib: node hosts
     * pass the native zstd (`nodeZstd` from engine-server-node), the browser
     * editor / cli dev loop wrap zstd-wasm's `zstdCompress`.
     */
    zstd: Zstd;
    /**
     * Matchmaker grouping key for this server's `main` namespace. Stamped at
     * init so scripts can read it via `ctx.server.options`.
     */
    options?: Record<string, string | number | boolean>;
    /**
     * Side-effect handle for persistent KV (projectStorage / userStorage).
     * Deployed: HTTP driver pointed at the service. bongle dev / editor: an
     * in-memory impl. Required, scripts can call storage APIs at any
     * point so a missing driver would only manifest at first call.
     */
    driver: ServerDriver;
    /**
     * Notified when a queued scene persist (write/delete) rejects, so the host can
     * surface it to the user — the edit did NOT reach disk. Edit mode only (play is
     * read-only, no persist).
     */
    onPersistError?: (op: 'write' | 'delete', sceneId: string, err: unknown) => void;
};

// model bins: ModelHandle.bin.server is a path relative to resourcesDir, joined
// under `resources/server/` for fs.read. Runtime avatars carry absolute http(s)
// (R2) urls, or a `file://` OPFS path (editor); branch on scheme.
function createResourceLoader(fs: Filesystem, resourceManager: ReturnType<typeof ResourceManager.init>) {
    return {
        loadBytes: (url: string): Promise<Uint8Array> => {
            if (url.startsWith('http:') || url.startsWith('https:')) {
                return fetch(url).then(async (r) => {
                    if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
                    return new Uint8Array(await r.arrayBuffer());
                });
            }
            if (url.startsWith('file:')) return fs.read(new URL(url).pathname.replace(/^\/+/, ''));
            if (url.startsWith('/')) return fs.read(url.replace(/^\/+/, ''));
            return fs.read(ResourceManager.resolveModelBin(resourceManager, url));
        },
    };
}

export function init(opts: InitOptions) {
    const net = Net.init();
    const clients = Clients.init();
    const rooms = Rooms.init();
    if (opts.options && Object.keys(opts.options).length > 0) {
        Rooms.setNamespaceOptions(rooms, 'main', opts.options);
    }

    // scene edits persist back through the project fs in edit mode; play/solo are
    // read-only. the store is seeded async at load().
    const sceneBytes = new TextEncoder();
    const contentManager = ContentManager.init({
        persist:
            opts.mode === 'edit'
                ? {
                      write: (sceneId, content) => opts.fs.write(ContentManager.scenePath(sceneId), sceneBytes.encode(content)),
                      delete: (sceneId) => opts.fs.remove(ContentManager.scenePath(sceneId)),
                      onError: opts.onPersistError,
                  }
                : undefined,
    });
    const resourceManager = ResourceManager.init({ resourcesDir: 'resources/server' });
    const content = Content.init();
    const resources = Resources.init(createResourceLoader(opts.fs, resourceManager), 'server');
    const discovery = Discovery.init(opts.zstd);
    // one shared rpc across all rooms; listen() scopes per-room via runtime.roomId.
    const rpc = Rpc.init(ServerRpc.createDriver(rooms, discovery));

    return {
        mode: opts.mode,
        fs: opts.fs,
        driver: opts.driver,
        net,
        clients,
        rooms,
        contentManager,
        resourceManager,
        content,
        resources,
        discovery,
        rpc,
        defaultRoomId: null as string | null,
        metrics: Debug.createMetrics() as Debug.Metrics,
        /** monotonic server time (ms), the engine clock the per-connection ping RTT
         *  is measured in (NOT performance.now). connection-level, so server-global. */
        netTimeMs: 0,
        telemetry: Telemetry.init(),
        save: Save.init(),
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
 * options are NOT routed here, they live on namespaces (set by the
 * runtime at boot for deployed, or by the `play` handler for in-game
 * `client.matchmake`). The default room's namespace is pre-stamped.
 */
export function onClientJoin(
    state: EngineServer,
    clientId: Client,
    user: User,
    joinData: Record<string, JsonValue>,
    avatar?: ResolvedAvatar,
) {
    // seed the client's inbound wire-index tables from our local registry.
    // both peers built from the same source, so the client's outbound
    // tables match ours at connect time. subsequent `wire_table` messages
    // from this client refresh these as its HMR cycles diverge ours.
    Clients.onJoin(state.clients, clientId, user, localInbound(registry));

    // publish our protocol manifest before any packed payload reaches the
    // client, so it decodes our traits/commands/sync-slots by id. both peers
    // build tables from module-load order, which can diverge across bundles;
    // the manifest reconciles that by id rather than by coincidental position.
    Net.send(state.net, clientId, { type: 'wire_table', ...protocolManifest(registry) });

    // Record the resolved avatar identity (or builtin, dev/edit) and
    // kick its payload load, BEFORE the player nodes are created below,
    // so each node's CharacterTrait is stamped with the right
    // modelId/rigType before its onJoin fires.
    const cs = state.clients.connected.get(clientId);
    if (cs) Avatars.setClientAvatar(state, cs, avatar);

    // belt-and-suspenders cap check. the matchmaker (and gatho admission)
    // are the primary gates and shouldn't let a past-cap client reach
    // here, but if one does (race, manual connection, whatever), drop
    // it on the floor rather than silently growing the room. edit mode
    // is a single-user editor; the cap doesn't apply. by this point
    // ClientState already includes the new client, so compare against `>`.
    if (state.mode === 'play') {
        // only server configs carry a cap; a standalone (client-only) game has
        // no server so no cap to enforce here.
        const cap = serverMaxPlayers(resolveConfig(registry));
        if (cap !== null && state.clients.connected.size > cap) {
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
        if (playerNode) Scripts.fireLeaveHooks(room.context, clientId, playerNode);
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
    Telemetry.dropClient(state.telemetry, clientId);
    // drop any partial reassembly buffer held for this client.
    state.net.reassemblers.delete(clientId);
}

/**
 * Complete initialization after init() - loads module, creates rooms, loads scenes.
 * This is async so scene loading can happen after module load.
 */
export async function load(state: EngineServer) {
    const mode = state.mode;

    // seed the authored-scene store from the project fs. Async (the host's fs is
    // async), so it lives here rather than the sync init(); the sync engine reads
    // ContentManager during room creation below. sceneId = the path under
    // `content/scenes/` with `.scene.json` stripped.
    const sceneText = new TextDecoder();
    for (const entry of await state.fs.list(ContentManager.SCENES_DIR, { recursive: true })) {
        if (entry.kind !== 'file') continue;
        const sceneId = ContentManager.sceneIdFromPath(entry.path);
        if (sceneId === null) continue;
        ContentManager.seedLastWrittenRaw(state.contentManager, sceneId, sceneText.decode(await state.fs.read(entry.path)));
    }

    // In edit mode the realm calls `engine-server-editor.setup(state)` BEFORE this
    // (mirroring the client's `engine-client-editor.setup`), so the editor's server
    // commands have already upserted into the registry by now — keeping this runtime
    // entry free of the `env.editor` branch.

    // user + editor modules have registered by now (loadModule ran before this).
    // build the derived index fields once so scene population + room creation below
    // read a live `blockRegistry` / `protocol`. in dev the flush handler reindexes
    // again on every HMR.
    reindexRegistry(registry);

    // seed Resources.models from the registry. lazy systems (renderer,
    // animator, auto-collider) trigger ensureModel on first reference.
    seedModels(state);

    // walk declared scenes and apply each handle's authored `_payload` (set
    // by the codegen barrel's `_registerScenePayload` at module-eval, drained
    // by `scene()`). `applyScenePayload` also seeds ContentManager's
    // `_lastWritten` so a subsequent identical flush is skipped (no redundant
    // write or dev-watcher echo). a handle with `_payload === null` is declared
    // but has no file on disk yet, the codegen layer already warned at build
    // time; handle stays empty.
    for (const [sceneId, h] of registry.scenes.byId) {
        const handle = h;
        if (!handle._payload) continue;
        applyScenePayload(state, sceneId, handle._payload);
    }

    // create the default room.
    const defaultRoom =
        mode === 'edit' ? Rooms.findOrCreateEditRoom(state, DEFAULT_SCENE_ID) : Rooms.createPlayRoom(state, DEFAULT_SCENE_ID);
    state.defaultRoomId = defaultRoom.id;

    // initial registry population is consumed directly via the registry,
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
        registry.config,
        registry.sounds,
    ]);
}

/**
 * apply an authored scene payload: stamp it onto the handle's `_payload`,
 * seed `ContentManager._lastWritten` so an identical flush is skipped (no
 * redundant write or dev-watcher echo), then `populateScene`. invoked by:
 *   - `load()` at boot for every declared handle whose `_payload` was
 *     seeded by the codegen barrel.
 *   - the boot template's `bongle:scene-update` HMR listener for live
 *     content edits.
 *   - the server registry-dispatch scenes branch for `added` / `changed`.
 */
export function applyScenePayload(state: EngineServer, id: string, payload: Content.ScenePayload): void {
    const handle = registry.scenes.byId.get(id);
    if (!handle) return;
    handle._payload = payload;
    ContentManager.seedLastWrittenRaw(state.contentManager, id, ContentManager.serializeScenePayload(payload));
    Content.populateScene(state.content, registry.blockRegistry, id, payload, 'server');
    touch(registry.scenes, id);
}

/**
 * clear a scene's authored payload and tear down its populated handle.
 * invoked by the boot template's `bongle:scene-clear` HMR listener (file
 * deletion) and the server registry-dispatch scenes branch for `removed`.
 */
export function clearScene(state: EngineServer, id: string): void {
    const handle = registry.scenes.byId.get(id);
    if (handle) handle._payload = null;
    Content.clearScene(state.content, id, 'server');
    touch(registry.scenes, id);
}

export function processInbox(state: EngineServer) {
    // process inbox, count ingress bytes
    const inbox = state.net.inbox;

    for (const [client, frames] of inbox) {
        // decode frames back into message batches; fragments of a big batch may
        // span ticks, so the reassembler persists per client.
        let reassembler = state.net.reassemblers.get(client);
        if (!reassembler) {
            reassembler = createReassembler();
            state.net.reassemblers.set(client, reassembler);
        }
        for (const frame of frames) {
            let messages: Uint8Array[] | null;
            try {
                messages = acceptFrame(reassembler, frame);
            } catch (err) {
                console.error(`[bongle] inbound framing error from client ${String(client)}:`, err);
                reassembler = createReassembler();
                state.net.reassemblers.set(client, reassembler);
                continue;
            }
            if (!messages) continue;

            for (const messageBytes of messages) {
                const message = Protocol.unpackClientMessage(messageBytes);
                if (!message) continue;
                // bill ingress per message.type using the original bytes
                // view length, packcat decodes uint8Array as a subarray
                // view into the source packet, so this is zero-copy.
                state.net.bytesInByType.set(
                    message.type,
                    (state.net.bytesInByType.get(message.type) ?? 0) + messageBytes.byteLength,
                );

                switch (message.type) {
                    case 'set_active_room': {
                        // presence only, update which Player the client is focused on
                        const player = Rooms.getPlayer(state.rooms, message.playerId);
                        if (player && player.client === client) {
                            Rooms.setActivePlayer(state.rooms, client, player.id);
                        }
                        break;
                    }
                    case 'ping':
                        Net.send(state.net, client, { type: 'pong' });
                        break;

                    case 'net_ping_ack': {
                        // client echoed the latest net_ping.serverStamp — fold the round trip
                        // into this connection's smoothed ping (server clock, so no offset).
                        const cs = state.clients.connected.get(client);
                        if (cs) Clients.recordPingAck(cs, message.serverStampAck, Math.round(state.netTimeMs) >>> 0);
                        break;
                    }

                    case 'voxel_ack':
                        Discovery.handleVoxelAck(state.discovery, client, message);
                        break;

                    case 'metrics_subscribe':
                        Telemetry.subscribeMetrics(state.telemetry, client, message.enabled);
                        break;

                    case 'debug_subscribe':
                        Telemetry.subscribeDebugLogs(state.telemetry, client, message.enabled);
                        break;

                    case 'net_message': {
                        const cs = state.clients.connected.get(client);
                        if (!cs) break;
                        Rpc.dispatchNetMessage(state.rpc, cs.inbound.commands, message, client);
                        break;
                    }

                    case 'wire_table': {
                        const cs = state.clients.connected.get(client);
                        if (!cs) break;
                        cs.inbound = buildInboundProtocol(message, registry);
                        break;
                    }

                    case 'sync_update':
                        Rooms.applyOwnerSync(state, client, message);
                        break;

                    case 'open_scene': {
                        // editor edit rooms all share the 'editor' namespace; reuse
                        // existing room when the scene is already open, otherwise mint
                        // a new one.
                        const room = Rooms.findOrCreateEditRoom(state, message.sceneId);
                        const player = Rooms.addClientToRoom(state, client, room, 'edit');
                        Net.send(state.net, client, { type: 'activate_room', playerId: player.id });
                        break;
                    }

                    case 'play':
                        Rooms.joinPlay(state, client, message);
                        break;

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

                    case 'save_scene': {
                        Save.saveScene(state, message.sceneId);
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

    // advance the server-global net clock first, so both the ping-ack RTT (in processInbox)
    // and the net_ping stamps sent below read the same "now" this tick.
    state.netTimeMs += delta * 1000;

    // inbox drains client messages, joins/room-creates do scene instantiation here,
    // a one-frame spike source distinct from the per-room tick stages.
    Debug.begin(state.metrics, 'inbox');
    processInbox(state);
    Debug.end(state.metrics, 'inbox');

    // tick all rooms
    for (const room of state.rooms.rooms.values()) {
        Debug.begin(room.metrics, 'room');

        room.tick++;
        Clock.tick(room.clock, delta);
        Clock.advanceWall(room.clock, delta); // server has no render frames, wall tracks time

        // push this room's authoritative `server` clock to its clients every tick so
        // they keep their own locked to it (batched into the per-tick packet, no extra
        // ws frame). the client decimates this to ~10Hz for the offset estimator but
        // stamps remote-transform snapshot keyframes off the raw per-tick value, so it
        // must send every tick. clients render one-way latency behind it, see core/clock.
        Net.broadcastToRoom(state.net, state.rooms, room, {
            type: 'server_clock',
            roomId: room.id,
            serverClock: room.clock.serverSmoothed,
        });

        Debug.begin(room.metrics, 'nodes/update');
        SceneTree.runOnUpdate(room.scene, { delta }, room.metrics);
        Debug.end(room.metrics, 'nodes/update');

        // game-script onTick, the usual home of game-logic spikes (ai, projectile
        // sweeps, the round reset). also timed per-script as `script/<key>`.
        Debug.begin(room.metrics, 'nodes/tick');
        SceneTree.runOnTick(room.scene, { delta }, room.metrics);
        Debug.end(room.metrics, 'nodes/tick');

        // sample animations into rig TransformTraits before physics so the
        // teleport detector picks up the new pose this tick (matches client).
        Debug.begin(room.metrics, 'animation');
        Animation.tick(room.animations, state.resources, delta);
        Debug.end(room.metrics, 'animation');

        // post-animation hooks: procedural overrides (head-look, springs, etc.)
        // run after animator sampling, before downstream consumers read world matrices.
        Debug.begin(room.metrics, 'nodes/post-animate');
        SceneTree.runOnPostAnimate(room.scene, { delta }, room.metrics);
        Debug.end(room.metrics, 'nodes/post-animate');

        // tick prefab system, discovers and re-instantiates stale prefab nodes
        Debug.begin(room.metrics, 'prefab');
        Prefab.tick(room.scene, room.context, state.resources, room.voxels, 'server');
        Debug.end(room.metrics, 'prefab');

        Debug.begin(room.metrics, 'physics/pre');
        physics.preStep(room.physics, room.scene, state.resources, null, room.mode === 'play');
        Debug.end(room.metrics, 'physics/pre');

        Debug.begin(room.metrics, 'physics');
        physics.tick(room.physics, room.scene, delta);
        Debug.end(room.metrics, 'physics');

        Debug.begin(room.metrics, 'physics/post');
        physics.postStep(room.physics, room.scene, null);
        Debug.end(room.metrics, 'physics/post');

        Telemetry.recordPhysicsStats(room.metrics, room.physics);

        // block hooks settle inline per write (see block-hooks.ts); nothing to
        // drain here. flush the tick's accumulated light recompute.
        Debug.begin(room.metrics, 'lighting');
        Light.flushPendingLight(room.voxels);
        Debug.end(room.metrics, 'lighting');

        Debug.begin(room.metrics, 'nodes/frame');
        SceneTree.runOnFrame(room.scene, { delta }, room.metrics);
        Debug.end(room.metrics, 'nodes/frame');

        // drain chat inbox/outbox: parse queued `chat_input` lines from
        // clients (consumed by local handlers or promoted into outbox),
        // then broadcast every outbox entry as `chat_broadcast`.
        Debug.begin(room.metrics, 'chat');
        Chat.tick(room.chat, state.net, state.rooms, room, state.clients);
        Debug.end(room.metrics, 'chat');

        // release per-tick physics scratch (voxel hit pool). MUST come after
        // every subShapeId consumer for this room, contact listeners,
        // getSurfaceNormal, getSupportingFace, has run.
        physics.flush(room.physics);

        Debug.end(room.metrics, 'room');
    }

    // drain queued reset/stop requests now that no room is mid-tick.
    Debug.begin(state.metrics, 'rooms/drain');
    Rooms.drainPending(state);
    Debug.end(state.metrics, 'rooms/drain');

    // flush discovery, runs diff detection per room (serialize once),
    // then distributes updates to clients based on per-client knowledge
    Debug.begin(state.metrics, 'discovery');
    const pending = Discovery.flush(state.discovery, state.rooms, state.resources, state.metrics);
    const discoveryMs = Debug.end(state.metrics, 'discovery');

    for (const [client, message] of pending) {
        Net.send(state.net, client, message);
    }

    // drain this tick's queued RPC commands AFTER scene distribution, so a
    // command never lands before the scene state it depends on (e.g. an
    // onJoin command arrives after the joiner's join_room → its listeners
    // are already registered). see discovery.ts "RPC command ordering".
    Discovery.flushCommands(state.discovery, state.net, state.rooms);

    // record discovery time on each room
    for (const room of state.rooms.rooms.values()) {
        Debug.record(room.metrics, 'discovery', discoveryMs);
    }

    Telemetry.pushDebugLogs(state);
    Telemetry.pushRoomMetrics(state, delta);

    // per-connection ping beacon: stamp each client with the server-global net clock (it
    // echoes it back via net_ping_ack) + hand it its current server-measured ping for the HUD.
    // rides the per-tick packet the client already receives (server_clock), no extra ws frame.
    const netStamp = Math.round(state.netTimeMs) >>> 0;
    for (const cs of state.clients.connected.values()) {
        Net.send(state.net, cs.id, { type: 'net_ping', serverStamp: netStamp, pingMs: Math.min(65535, cs.pingMs) });
    }

    // pack typed outbox messages into Uint8Array packets for the runtime
    Debug.begin(state.metrics, 'netflush');
    Net.flush(state.net);
    Debug.end(state.metrics, 'netflush');

    // net throughput per room (global bytes split evenly across rooms) + process
    // CPU/memory onto the global bag; both ride the room_metrics push.
    const netStats = Net.drainNetStats(state.net);
    const roomCount = state.rooms.rooms.size || 1;
    for (const room of state.rooms.rooms.values()) {
        Telemetry.recordNetStats(room.metrics, netStats, delta, roomCount);
    }
    Telemetry.recordProcessStats(state.metrics, delta);

    Debug.end(state.metrics, 'tick');

    // auto-flush dirty edit rooms to disk on an interval (no-op when clean).
    Save.tick(state, delta);
}

/* ── dispose ── */

/** tear down the server: flush any unsaved edits, then destroy all rooms. */
export function dispose(state: EngineServer): void {
    // final flush before exit so the last edits since the interval auto-flush
    // aren't lost. dirty-gated + incremental, so it's a no-op when clean.
    Save.flushDirty(state);

    for (const roomId of [...state.rooms.rooms.keys()]) {
        Rooms.destroyRoom(state.rooms, roomId);
    }

    state.defaultRoomId = null;
}

/** await every in-flight scene persist. The host calls this AFTER `dispose()` on a
 *  graceful stop — dispose's final flush enqueues the last saves synchronously, so
 *  draining here guarantees the bytes reach disk before a fresh realm reloads. */
export function drainPersist(state: EngineServer): Promise<void> {
    return ContentManager.drainPersist(state.contentManager);
}
