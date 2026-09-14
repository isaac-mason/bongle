import type {
    Channel,
    Client,
    Filesystem,
    JsonValue,
    ResolvedAvatar,
    ServerApp,
    ServerDriver,
    ServerInitOptions,
    TickStats,
    User,
} from 'bongle/interface';
import { registerFlushHandler, requestFlush } from '../core/capture/flush';
import * as Clock from '../core/clock';
import { DEFAULT_TICK_RATE, serverMaxPlayers, serverTickRate } from '../core/config';
import * as Content from '../core/content';
import * as Debug from '../core/debug';
import { acceptFrame, createReassembler } from '../core/net';
import * as physics from '../core/physics/physics';
import * as Protocol from '../core/protocol';
import * as RegistryStore from '../core/registry';
import {
    buildInboundProtocol,
    clearPendingChanges,
    localInbound,
    protocolManifest,
    registry,
    reindexRegistry,
    resolveConfig,
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
import { applyRegistryChanges, seedModels } from './registry-dispatch';
import * as ResourceManager from './resource-manager';
import * as Rooms from './rooms';
import * as ServerRpc from './rpc';
import * as Telemetry from './telemetry';

// runtime avatar swap (editor live preview): re-register the edited glb under a
// fresh modelId and re-stamp the player without a re-join.
export { reloadClientAvatar } from './avatars';
export { DEFAULT_SCENE_ID };

export type InitOptions = {
    mode: 'edit' | 'play';
    /** the project filesystem: scenes under `content/scenes/`, server model bins
     *  under `resources/server/`. host-provided so the engine stays node-free. */
    fs: Filesystem;
    /** zstd impl `{ compress(payload, level) }` for the voxel wire codec, host-provided
     *  so the engine never hard-depends on a node zlib. */
    zstd: Zstd;
    /** matchmaker grouping key for this server's `main` namespace, readable by
     *  scripts via `ctx.server.options`. */
    options?: Record<string, string | number | boolean>;
    /** persistent KV side-effect handle (projectStorage / userStorage); required,
     *  since scripts can call storage APIs at any point. */
    driver: ServerDriver;
    /** the host's outbound sink, called from inside `update` for every framed batch. */
    send: ServerInitOptions['send'];
};

/** where a server is in its `init`, `load`, `start`, `dispose` lifecycle; each step
 *  checks the previous one so a host calling them out of order gets a throw at the
 *  call site instead of a loop ticking a state that isn't ready. */
export type Phase = 'init' | 'loaded' | 'running' | 'disposed';

// runtime avatars carry absolute http(s) urls or a `file://` OPFS path (editor);
// branch on scheme.
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

    // the authored-scene store, seeded async at load(). the runtime only reads it.
    const contentManager = ContentManager.init();
    const resourceManager = ResourceManager.init({ resourcesDir: 'resources/server' });
    const content = Content.init();
    const resources = Resources.init(createResourceLoader(opts.fs, resourceManager), 'server');
    const discovery = Discovery.init(opts.zstd);
    // the game's own cadence, not the host's. A standalone game runs no server loop,
    // so the default is only a placeholder for a server that will never tick.
    const tickHz = serverTickRate(resolveConfig(registry)) ?? DEFAULT_TICK_RATE;
    // one shared rpc across all rooms; listen() scopes per-room via runtime.roomId.
    const rpc = Rpc.init(ServerRpc.createDriver(rooms, discovery));

    return {
        mode: opts.mode,
        fs: opts.fs,
        driver: opts.driver,
        send: opts.send,
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
        phase: 'init' as Phase,
        /** the sim loop's rate, resolved from the game's config. `start` paces on it
         *  and the send-path rate gate counts ticks against it. */
        tickHz,
        /** the fixed step every tick advances by (seconds); `1 / tickHz`. */
        step: 1 / tickHz,
        loop: {
            timer: null as ReturnType<typeof setTimeout> | null,
            last: 0,
            accumulator: 0,
            // tick timing since the host last drained it via `stats`.
            ticks: 0,
            maxMs: 0,
            totalMs: 0,
        },
        // nobody is watching at boot: enabled flips with the first panel subscribe.
        profiler: Debug.createProfiler(false) as Debug.Profiler,
        /** monotonic server time (ms), the clock the per-connection ping RTT is
         *  measured in; not performance.now. */
        netTimeMs: 0,
        telemetry: Telemetry.init(),
    };
}

export type EngineServer = ReturnType<typeof init>;

/** engine-side join: writes identity to ClientState, runs the cap check, places
 *  the client in the default room, and fires the `onJoin` script hook. `joinData`
 *  is a one-shot, scripts that want it past the join must copy it themselves. */
export function onClientJoin(
    state: EngineServer,
    clientId: Client,
    user: User,
    joinData: Record<string, JsonValue>,
    avatar?: ResolvedAvatar,
) {
    // seed the client's inbound wire-index tables from our local registry; both
    // peers build from the same source, so they match at connect time.
    Clients.onJoin(state.clients, clientId, user, localInbound(registry));

    // publish our protocol manifest before any packed payload reaches the client,
    // reconciling by id since module-load order can diverge across bundles.
    Net.send(state.net, clientId, { type: 'wire_table', ...protocolManifest(registry) });

    // record the resolved avatar identity and kick its payload load before player
    // nodes are created, so each node's CharacterTrait is stamped before onJoin fires.
    const cs = state.clients.connected.get(clientId);
    if (cs) Avatars.setClientAvatar(state, cs, avatar);

    // belt-and-suspenders cap check: the matchmaker is the primary gate, this drops
    // a past-cap client rather than silently growing the room. edit mode has no cap.
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
    Telemetry.dropClient(state, clientId);
    // drop queued frames and any partial reassembly buffer held for this client.
    state.net.inbox.delete(clientId);
    state.net.reassemblers.delete(clientId);
}

/** one inbound frame from the host. Queues until the next update. */
export function receive(state: EngineServer, client: Client, channel: Channel, bytes: Uint8Array): void {
    let channels = state.net.inbox.get(client);
    if (!channels) {
        channels = [[], []];
        state.net.inbox.set(client, channels);
    }
    channels[channel].push(bytes);
}

/** completes initialization after init(): loads module, creates rooms, loads
 *  scenes. async so scene loading can happen after module load. */
export async function load(state: EngineServer) {
    expectPhase(state, 'init', 'load');
    const mode = state.mode;

    // seed the authored-scene store from the project fs; async since the host's fs
    // is async, so this lives here rather than the sync init().
    const sceneText = new TextDecoder();
    for (const entry of await state.fs.list(ContentManager.SCENES_DIR)) {
        if (entry.kind !== 'file') continue;
        const sceneId = ContentManager.sceneIdFromPath(entry.path);
        if (sceneId === null) continue;
        ContentManager.putScene(state.contentManager, sceneId, sceneText.decode(await state.fs.read(entry.path)));
    }

    // in edit mode the editor's server commands have already upserted into the
    // registry by now, via `engine-server-editor.setup` running before this.

    // build the derived index fields once so scene population + room creation below
    // read a live `blockRegistry` / `protocol`; the flush handler reindexes again
    // on every HMR.
    reindexRegistry(registry);

    // lazy systems (renderer, animator, auto-collider) trigger ensureModel on first reference.
    seedModels(state);

    // a handle with `_payload === null` is declared but has no file on disk yet
    // (the codegen layer already warned at build time); it stays empty.
    for (const [sceneId, h] of registry.scenes.byId) {
        const handle = h;
        if (!handle._payload) continue;
        applyScenePayload(state, sceneId, handle._payload);
    }

    const defaultRoom =
        mode === 'edit' ? Rooms.findOrCreateEditRoom(state, DEFAULT_SCENE_ID) : Rooms.createPlayRoom(state, DEFAULT_SCENE_ID);
    state.defaultRoomId = defaultRoom.id;

    // drop the `added` events accumulated during initial registry population, so
    // the first HMR flush only logs real deltas.
    clearPendingChanges([
        registry.tiles,
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

    state.phase = 'loaded';
}

/** applies an authored scene payload: stores its json in the scene store so an
 *  identical editor save is a no-op, then `populateScene`. */
export function applyScenePayload(state: EngineServer, id: string, payload: Content.ScenePayload): void {
    const previous = registry.scenes.byId.get(id);
    if (!previous) return;
    ContentManager.putScene(state.contentManager, id, ContentManager.serializeScenePayload(payload));
    Content.populateScene(state.content, registry.blockRegistry, id, payload, 'server');
    RegistryStore.setScenePayload(id, payload);
}

/** clears a scene's authored payload and tears down its populated handle. */
export function clearScene(state: EngineServer, id: string): void {
    const previous = registry.scenes.byId.get(id);
    Content.clearScene(state.content, id, 'server');
    if (previous) {
        RegistryStore.setScenePayload(id, null);
    }
}

export function processInbox(state: EngineServer) {
    const inbox = state.net.inbox;

    for (const [client, channels] of inbox) {
        // decode frames back into message batches; fragments of a big batch may
        // span ticks, so the reassemblers persist per client and channel.
        let reassemblers = state.net.reassemblers.get(client);
        if (!reassemblers) {
            reassemblers = [createReassembler(), createReassembler()];
            state.net.reassemblers.set(client, reassemblers);
        }
        for (let channel = 0; channel < channels.length; channel++) {
            const frames = channels[channel];
            for (const frame of frames) {
                let messages: Uint8Array[] | null;
                try {
                    messages = acceptFrame(reassemblers[channel], frame);
                } catch (err) {
                    console.error(`[bongle] inbound framing error from client ${String(client)}:`, err);
                    reassemblers[channel] = createReassembler();
                    continue;
                }
                if (!messages) continue;

                for (const messageBytes of messages) {
                    const message = Protocol.unpackClientMessage(messageBytes);
                    if (!message) continue;
                    // zero-copy: packcat decodes uint8Array as a subarray view into the
                    // source packet, so this bills the original bytes view length.
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
                            // fold the round trip into this connection's smoothed ping,
                            // server clock so no offset entanglement.
                            const cs = state.clients.connected.get(client);
                            if (cs) Clients.recordPingAck(cs, message.serverStampAck, Math.round(state.netTimeMs) >>> 0);
                            break;
                        }

                        case 'voxel_ack':
                            Discovery.handleVoxelAck(state.discovery, client, message);
                            break;

                        case 'metrics_subscribe':
                            Telemetry.subscribeMetrics(state, client, message.enabled);
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

                        case 'chat_input': {
                            const room = Rooms.getRoom(state.rooms, message.roomId);
                            if (!room) break;
                            Chat.enqueueInput(room.chat, { line: message.line, from: client });
                            break;
                        }
                    }
                }
            }
            frames.length = 0;
        }
    }
}

/**
 * one tick. `step` is the fixed step the sim advances by; `wallDelta` is the real time
 * that elapsed for it. They diverge on an overrunning server, where the loop drops
 * backlog rather than catching up: the sim then runs slower than the wall. Clocks and
 * scripts take the fixed step so tick counting stays canonical, while the net clock and
 * telemetry take wall time so RTT and per-second rates keep describing reality.
 */
export function update(state: EngineServer, step: number, wallDelta: number = step) {
    Debug.frameStart(state.profiler);

    // advance the net clock first, so ping-ack RTT and the net_ping stamps sent
    // below read the same "now" this tick.
    state.netTimeMs += wallDelta * 1000;

    Debug.begin(state.profiler, 'inbox');
    processInbox(state);
    Debug.end(state.profiler, 'inbox');

    for (const room of state.rooms.rooms.values()) {
        Debug.begin(state.profiler, room.profileKey);

        room.tick++;
        Clock.tick(room.clock, step);
        Clock.advanceWall(room.clock, step); // server has no render frames, wall tracks time

        // sent every tick since the client stamps remote-transform snapshot keyframes
        // off the raw per-tick value, even though it decimates for its offset estimator.
        Net.broadcastToRoom(state.net, state.rooms, room, {
            type: 'server_clock',
            roomId: room.id,
            serverClock: room.clock.serverSmoothed,
        });

        Debug.begin(state.profiler, 'nodes/update');
        SceneTree.runOnUpdate(room.scene, { delta: step }, state.profiler);
        Debug.end(state.profiler, 'nodes/update');

        // game-script onTick, also timed per-script as `script/<key>`.
        Debug.begin(state.profiler, 'nodes/tick');
        SceneTree.runOnTick(room.scene, { step }, state.profiler);
        Debug.end(state.profiler, 'nodes/tick');

        // before physics so the teleport detector picks up the new pose this tick.
        Debug.begin(state.profiler, 'animation');
        Animation.tick(room.animations, state.resources, step);
        Debug.end(state.profiler, 'animation');

        // post-animation hooks: procedural overrides (head-look, springs, etc.)
        // run after animator sampling, before downstream consumers read world matrices.
        Debug.begin(state.profiler, 'nodes/post-animate');
        SceneTree.runOnPostAnimate(room.scene, { delta: step }, state.profiler);
        Debug.end(state.profiler, 'nodes/post-animate');

        Debug.begin(state.profiler, 'prefab');
        Prefab.tick(room.scene, room.context, state.resources, room.voxels, 'server');
        Debug.end(state.profiler, 'prefab');

        Debug.begin(state.profiler, 'physics/pre');
        physics.preStep(room.physics, room.scene, state.resources, null, room.mode === 'play');
        Debug.end(state.profiler, 'physics/pre');

        Debug.begin(state.profiler, 'physics');
        physics.tick(room.physics, room.scene, step);
        Debug.end(state.profiler, 'physics');

        Debug.begin(state.profiler, 'physics/post');
        physics.postStep(room.physics, room.scene, null);
        Debug.end(state.profiler, 'physics/post');

        // inside the room's scope, so the counters ride with that room's subtree.
        physics.recordStats(state.profiler, room.physics);

        // block hooks settle inline per write; this flushes accumulated light recompute.
        Debug.begin(state.profiler, 'lighting');
        Light.flushPendingLight(room.voxels);
        Debug.end(state.profiler, 'lighting');

        Debug.begin(state.profiler, 'nodes/frame');
        SceneTree.runOnFrame(room.scene, { delta: step }, state.profiler);
        Debug.end(state.profiler, 'nodes/frame');

        Debug.begin(state.profiler, 'chat');
        Chat.tick(room.chat, state.net, state.rooms, room, state.clients);
        Debug.end(state.profiler, 'chat');

        // must come after every subShapeId consumer (contact listeners,
        // getSurfaceNormal, getSupportingFace) has run.
        physics.flush(room.physics);

        Debug.end(state.profiler, room.profileKey);
    }

    // queued reset/stop requests, now that no room is mid-tick.
    Debug.begin(state.profiler, 'rooms/drain');
    Rooms.drainPending(state);
    Debug.end(state.profiler, 'rooms/drain');

    // runs diff detection per room (serialize once), then distributes updates to
    // clients based on per-client knowledge.
    Debug.begin(state.profiler, 'discovery');
    const pending = Discovery.flush(state.discovery, state.rooms, state.resources, state.profiler, state.tickHz);
    const discoveryMs = Debug.end(state.profiler, 'discovery');

    for (const [client, message] of pending) {
        Net.send(state.net, client, message);
    }

    // after scene distribution, so a command never lands before the scene state
    // it depends on (an onJoin command arrives after join_room, listeners already
    // registered). see discovery.ts "RPC command ordering".
    Discovery.flushCommands(state.discovery, state.net, state.rooms);

    // discovery is process-wide work, recorded once: every room's panel reads the
    // same number, as it did when it was copied onto each room's bag.
    Debug.record(state.profiler, 'discovery', discoveryMs, 'ms');

    Telemetry.pushDebugLogs(state);
    Telemetry.pushRoomFrames(state, wallDelta);

    // per-connection ping beacon: stamps each client with the net clock (echoed back
    // via net_ping_ack) and its current server-measured ping for the HUD.
    const netStamp = Math.round(state.netTimeMs) >>> 0;
    for (const cs of state.clients.connected.values()) {
        Net.send(state.net, cs.id, { type: 'net_ping', serverStamp: netStamp, pingMs: Math.min(65535, cs.pingMs) });
    }

    Debug.begin(state.profiler, 'netflush');
    Net.flush(state.net, state.send);
    Debug.end(state.profiler, 'netflush');

    const netStats = Net.drainNetStats(state.net);
    Telemetry.recordNetStats(state.profiler, netStats, wallDelta, state.rooms.rooms.size || 1);
    Telemetry.recordProcessStats(state.profiler, wallDelta);

    Debug.frameEnd(state.profiler);
}

/** how much backlog a slow tick may work off before the rest is dropped. One step:
 *  an overrunning server ticks late rather than spiralling, and the room clock simply
 *  advances slower than the wall (which `update` keeps telemetry honest about). */
const MAX_CATCHUP_STEPS = 1;

function expectPhase(state: EngineServer, expected: Phase, step: string): void {
    if (state.phase === expected) return;
    throw new Error(`[engine-server] ${step}() called in phase '${state.phase}', expected '${expected}'`);
}

/**
 * start the sim loop at the game's configured rate. Self-rescheduling `setTimeout`
 * rather than `setInterval`: it re-reads `state.step` every wake-up, so an HMR config
 * edit re-paces a live server, and it corrects for its own lateness instead of letting
 * it accumulate. A second call while running is a no-op; any other phase throws.
 */
export function start(state: EngineServer): void {
    if (state.phase === 'running') return;
    expectPhase(state, 'loaded', 'start');
    state.phase = 'running';
    state.loop.last = performance.now();
    state.loop.accumulator = 0;
    scheduleTick(state, 0);
}

function scheduleTick(state: EngineServer, delayMs: number): void {
    state.loop.timer = setTimeout(() => {
        state.loop.timer = null;
        runTicks(state);
    }, delayMs);
}

function runTicks(state: EngineServer): void {
    const step = state.step;
    const loop = state.loop;

    const now = performance.now();
    const elapsed = (now - loop.last) / 1000;
    loop.last = now;
    loop.accumulator += elapsed;

    const budget = step * (1 + MAX_CATCHUP_STEPS);
    if (loop.accumulator > budget) loop.accumulator = budget;

    const steps = Math.floor(loop.accumulator / step);
    // the reschedule is in a finally and nothing here catches: game script errors are
    // already contained per hook (scripts.ts logScriptError), so anything that escapes
    // `update` is an engine bug, and what that means is the host runtime's call. Node's
    // default takes the room down to be respawned; a dev host's error handler logs it
    // and the loop, still scheduled, carries on.
    try {
        if (steps > 0) {
            // each tick is told the share of real time it stands for; a catch-up tick
            // reporting ~0 wall seconds would send every kb/s rate to infinity.
            const wallPerTick = elapsed / steps;
            loop.accumulator -= steps * step;
            for (let i = 0; i < steps; i++) {
                const tickStart = performance.now();
                update(state, step, wallPerTick);
                const ms = performance.now() - tickStart;
                loop.ticks++;
                loop.totalMs += ms;
                if (ms > loop.maxMs) loop.maxMs = ms;
            }
        }
    } finally {
        // a dispose from inside a tick (a script asking the host to shut down) leaves
        // no timer to replace; anything else reschedules, even after a throw.
        if (state.phase === 'running') {
            // floor, so we wake a touch early and the accumulator carries the remainder,
            // rather than rounding up every tick into a slow drift.
            scheduleTick(state, Math.max(0, Math.floor((step - loop.accumulator) * 1000)));
        }
    }
}

/** drain tick timing accumulated since the previous call; a host samples this on its
 *  own cadence rather than being called back every tick. */
export function stats(state: EngineServer): TickStats {
    const loop = state.loop;
    const out = { tickHz: state.tickHz, ticks: loop.ticks, maxMs: loop.maxMs, totalMs: loop.totalMs };
    loop.ticks = 0;
    loop.maxMs = 0;
    loop.totalMs = 0;
    return out;
}

/** tear down the server: stop the loop, then destroy all rooms. An edit host lands
 *  unsaved edits first (engine-server-editor's `dispose`); the runtime knows nothing
 *  about saving. Async because tearing down will grow things to await (draining
 *  in-flight script storage writes); hosts bound the wait themselves. */
export async function dispose(state: EngineServer): Promise<void> {
    // before anything else: a queued tick must never land on a disposed state, and a
    // tick mid-flight must not reschedule past this point.
    state.phase = 'disposed';
    if (state.loop.timer !== null) {
        clearTimeout(state.loop.timer);
        state.loop.timer = null;
    }

    for (const roomId of [...state.rooms.rooms.keys()]) {
        Rooms.destroyRoom(state.rooms, roomId);
    }

    state.defaultRoomId = null;
}

/** The server as a `ServerApp`: what a bundle default-exports and a host (the play
 *  room, `bongle start`, the dev transports) drives. `mode` is the one choice a
 *  host makes at build or boot time; everything else arrives per init. */
export function app(mode: InitOptions['mode']): ServerApp<EngineServer> {
    return {
        init: (opts) => init({ mode, ...opts }),
        load,
        start,
        dispose,
        stats,
        onClientJoin,
        onClientLeave,
        receive,
    };
}

/** re-applies registry changes to `state` on every settled flush (HMR / re-declare),
 *  plus an initial apply. Call after `load` so the first apply sees the loaded
 *  rooms. Dev only: a deployed server applies the registry once in `load()`. */
export function watchRegistry(state: EngineServer): () => void {
    const unregister = registerFlushHandler(() => applyRegistryChanges(state));
    requestFlush();
    return unregister;
}
