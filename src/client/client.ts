import type { Channel, ClientApp, ClientDriver, JsonValue } from 'bongle/interface';
import { registerFlushHandler, requestFlush } from '../core/capture/flush';
import * as Clock from '../core/clock';
import { CLIENT_TICK_HZ } from '../core/clock';
import { isStandalone, serverTickRate } from '../core/config';
import * as Content from '../core/content';
import * as Debug from '../core/debug';
import { acceptFrame, createReassembler } from '../core/net';
import * as Physics from '../core/physics/physics';
import type { RoomInfo } from '../core/protocol';
import * as Protocol from '../core/protocol';
import * as Registry from '../core/registry';
import {
    buildInboundProtocol,
    type InboundProtocol,
    localInbound,
    registry,
    reindexRegistry,
    resolveConfig,
} from '../core/registry';
import type { ResourceLoader } from '../core/resource-loader';
import * as Resources from '../core/resources';
import * as Rpc from '../core/rpc';
import * as Animation from '../core/scene/animation';
import * as Prefab from '../core/scene/prefab';
import { DEFAULT_SCENE_ID } from '../core/scene/scene-handle';
import * as SceneTree from '../core/scene/scene-tree';
import { loadAtlasMetadata } from '../core/sprites/atlas';
import * as Light from '../core/voxels/light';
import * as Voxels from '../core/voxels/voxels';
import type { Renderer } from '../render/backend';
import { loadRenderBackend } from '../render/load';
import * as Particles from '../render/particles/particles';
import * as Interpolation from '../render/transform/interpolation';
import * as Visibility from '../render/visibility/visibility';
import * as Ads from './ads';
import * as Audio from './audio/audio';
import * as Chat from './chat';
import * as Device from './device';
import * as Input from './input';
import * as Manifest from './manifest';
import * as Net from './net';
import * as Performance from './performance';
import { applyRegistryChanges, seedModels } from './registry-dispatch';
import * as Replication from './replication';
import * as Rooms from './rooms';
import * as ClientRpc from './rpc';
import * as Telemetry from './telemetry';
import * as Transfer from './transfer';
import { mountPlayUI } from './ui/play-ui';
import { useClient } from './ui/stores/client-store';
import * as Viewport from './viewport';
import * as VoxelNet from './voxel-net';

export type InitOptions = {
    mode: 'edit' | 'play';
    /** Transport for client actions that need to exit the engine, currently just
     *  `client.matchmake`. bongle dev wraps a `play` message send; deployed shells
     *  wrap the iframe-parent bridge so the parent disposes + re-enqueues. */
    driver: ClientDriver;
    /** The environment's resource-loading bag (byte loading, optional image decoder),
     *  so engine-client owns no environment-specific I/O. */
    resourceLoader: ResourceLoader;
    /** The element the engine mounts its UI root into. */
    domElement: HTMLElement;
};

// The resource refreshes the edit hosts call when a baked artifact changes on disk.
export { refreshAudioResources, refreshBlockResources, refreshSpriteResources } from './registry-dispatch';

// The play-mode UI mount, for a host that boots play mode by hand rather than
// through `app()`; the editor counterpart lives at `bongle/engine-client-editor`.
export { mountPlayUI };

export function init(opts: InitOptions) {
    const { mode, driver } = opts;

    const uiRoot = document.createElement('div');
    opts.domElement.appendChild(uiRoot);

    const device = Device.init();
    const initialInputMode = device.deviceType === 'touchOnly' || device.mobile ? 'touch' : 'mouse';
    const inputManager = Input.createInputManager();
    inputManager.inputMode = initialInputMode;
    useClient.getState().setInputMode(initialInputMode);

    const net = Net.init();
    const rpc = Rpc.init(ClientRpc.createDriver(net));

    const rooms = Rooms.init();
    const voxelNet = VoxelNet.init();
    const content = Content.init();
    const resources = Resources.init(opts.resourceLoader, 'client');
    const viewport = Viewport.init();
    const manifest = Manifest.init();
    const telemetry = Telemetry.init();
    const ads = Ads.init();
    const transfer = Transfer.init();
    const profiler = Debug.createProfiler(useClient.getState().debugOpen);

    // resolved during load(): renderer, decoded audio atlas, inbound decode table, perf tier
    const renderer: Renderer = null!;
    const audioResources: Audio.AudioResources = null!;
    const inbound: InboundProtocol = null!;
    const perf: Performance.Resolved = null!;

    return {
        mode,
        driver,
        domElement: uiRoot,
        deviceLost: false,
        accumulator: 0,
        // owner-authority uploads are gated to the SERVER's cadence, which the client
        // reads from the same config the server does. The sim stays at 60 (a 30Hz
        // character would feel like one), but sending twice per server tick just means
        // the server's inbox applies both and keeps the second.
        uploadAccumulator: 0,
        renderer,
        net,
        rpc,
        inputManager,
        rooms,
        voxelNet,
        content,
        resources,
        device,
        viewport,
        audioResources,
        inbound,
        manifest,
        profiler,
        perf,
        telemetry,
        ads,
        transfer,
    };
}

export type EngineClient = ReturnType<typeof init>;

/** Boot a self-contained room (no server, one local player) and make it active.
 *  Used by standalone builds, the editor play preview, and cli dev. sceneId
 *  defaults to the boot landing scene the server would otherwise pick. */
export function startStandaloneRoom(state: EngineClient, sceneId: string = DEFAULT_SCENE_ID): Rooms.ClientRoom {
    const room = Rooms.startLocalRoom({
        state,
        sceneId,
        clientId: 0,
        playerMode: 'play',
        roomMode: 'play',
    });
    Rooms.setActivePlayer(state.rooms, state.net, room.playerId);
    return room;
}

/** True for a client-only build (config({ server: false })), which self-boots its
 *  local room. Multiplayer builds are false and boot from the server's join_room. */
export function isStandaloneBuild(): boolean {
    return isStandalone(resolveConfig(registry));
}

/** Re-enter matchmaking. bongle dev's ClientDriver wraps this; deployed shells
 *  bypass the engine and signal the parent host instead. */
export function play(
    state: EngineClient,
    opts: { options: Record<string, string | number | boolean>; joinData?: Record<string, JsonValue> },
): void {
    Net.send(state.net, {
        type: 'play',
        sceneId: undefined,
        sourceRoomId: undefined,
        options: JSON.stringify(opts.options),
        joinData: opts.joinData ? JSON.stringify(opts.joinData) : undefined,
    });
}

/** Mount the single shared render canvas as the viewport backdrop (z 0, beneath
 *  each room's overlay) and route its touch gestures into the InputManager. */
function mountDisplayCanvas(state: EngineClient): void {
    const canvas = state.renderer.canvas;
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.zIndex = '0';
    canvas.style.pointerEvents = 'auto';
    // claim touch gestures so a drag drives the game, not browser pan/zoom.
    canvas.style.touchAction = 'none';
    useClient.getState().viewportElement?.appendChild(canvas);
    Input.installCanvasListeners(canvas, state.inputManager);
}

export async function load(state: EngineClient) {
    // fire these before the backend import + device handshake, which they'd otherwise
    // queue behind; the payloads are gated on the registry declaring content, so a game
    // with no blocks or sprites doesn't 404 an atlas the pipeline never emitted
    const { loader } = state.resources;
    loader.prefetch?.('voxels-atlas.json');
    loader.prefetch?.('sprites-atlas.json');
    loader.prefetch?.('audio-manifest.json');
    if (registry.tiles.byId.size > 0) {
        loader.prefetch?.('voxels-atlas.png');
        for (let level = 1; level <= 4; level++) loader.prefetch?.(`voxels-atlas.${level}.png`);
    }
    if (registry.sprites.byId.size > 0) loader.prefetch?.('sprites-atlas.png');

    // load-split the backend + run the device handshake (falls back WebGPU->WebGL2) before
    // anything touches the renderer
    const { renderer, caps } = await loadRenderBackend();
    state.renderer = renderer;
    useClient.getState().setRenderer(renderer);

    // tell the host which backend we landed on, since it only probed and doesn't
    // otherwise learn that we had to fall back
    state.driver.graphics?.started(renderer.kind);

    // a lost GPU device invalidates every resource; recreation isn't wired, so halt
    // the frame loop and tell the user to reload
    renderer.onDeviceLost = (info) => {
        state.deviceLost = true;
        state.driver.graphics?.deviceLost(renderer.kind);
        console.error(
            `[engine] render device lost (${info.api})${info.reason ? `: ${info.reason}` : ''}. ` +
                `The GPU context was invalidated; reload to restore rendering.`,
        );
    };

    reindexRegistry(registry);

    // safe default until the server's first wire_table lands, which arrives before any
    // packed payload so this is overwritten before join_room decodes
    state.inbound = localInbound(registry);

    seedModels(state);

    for (const [sceneId, handle] of registry.scenes.byId) {
        if (handle._payload) applyScenePayload(state, sceneId, handle._payload);
    }

    // device is live; resolve the tier + budgets every subsystem below derives from
    state.perf = Performance.resolve(caps);
    Performance.log(state.perf);

    state.renderer.initResources({ blockRegistry: registry.blockRegistry, voxelBudget: state.perf.voxelBudget });

    // sprite atlas metadata must be resident before the backend's atlas load reads it
    state.resources.spriteAtlas = await loadAtlasMetadata(state.resources.loader);

    const [audioResources] = await Promise.all([
        Audio.loadResources(state.resources.loader),
        state.renderer.loadResources({
            blockRegistry: registry.blockRegistry,
            settings: state.perf.settings,
            resources: state.resources,
        }),
    ]);
    state.audioResources = audioResources!;
    // the AudioContext boots suspended; wake it on the first user gesture
    Audio.installGestureUnlock(state.audioResources);

    mountDisplayCanvas(state);
    Viewport.bindToStore(state.viewport, state.renderer, state.perf.profile);
    Telemetry.bindToStore(state);

    useClient.getState().setClientProfiler(state.profiler);
    useClient.getState().setInputManager(state.inputManager);

    // drop the `added` events from initial declarations so the first HMR flush logs only real deltas
    Registry.clearPendingChanges([
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
        registry.sprites,
    ]);
}

/** one inbound frame from the host. Queues until the next update. */
export function receive(state: EngineClient, channel: Channel, bytes: Uint8Array): void {
    state.net.inbox[channel].push(bytes);
}

function processInbox(state: EngineClient, frameSeconds: number): void {
    for (let channel = 0; channel < state.net.inbox.length; channel++) {
        const frames = state.net.inbox[channel];
        for (const frame of frames) {
            // fragments of a big batch may span ticks, so the reassembler persists in net state
            let messages: Uint8Array[] | null;
            try {
                messages = acceptFrame(state.net.reassemblers[channel], frame);
            } catch (err) {
                console.error('[bongle] inbound framing error:', err);
                state.net.reassemblers[channel] = createReassembler();
                continue;
            }
            if (!messages) continue;

            for (const messageBytes of messages) {
                const message = Protocol.unpackServerMessage(messageBytes);

                if (!message) {
                    // TODO: warn
                    continue;
                }

                state.net.bytesInByType.set(
                    message.type,
                    (state.net.bytesInByType.get(message.type) ?? 0) + messageBytes.byteLength,
                );

                // one malformed/unexpected message must never take down the whole tick loop
                try {
                    dispatchInboundMessage(state, message);
                } catch (err) {
                    console.error(`[bongle] error handling '${message.type}' message, skipping:`, err);
                }
            }
        }
        frames.length = 0;
    }

    VoxelNet.flushAcks(state.voxelNet, state.net, frameSeconds);
}

function dispatchInboundMessage(state: EngineClient, message: Protocol.ServerMessage): void {
    switch (message.type) {
        case 'join_room':
            // (re)joined: force a manifest resend + re-subscribe, since the server dropped both on disconnect
            Manifest.reset(state.manifest);
            Telemetry.resetSubscriptions(state.telemetry);
            Rooms.applyJoinRoom(state, message);
            break;

        case 'server_clock':
            // fold against `wall`, the same render-behind base syncServer reads
            for (const room of Rooms.getRoomsByRoomId(state.rooms, message.roomId)) {
                Clock.observeSample(room.clock, message.serverClock, room.clock.wall);
            }
            break;

        case 'net_ping':
            state.net.lastServerStamp = message.serverStamp;
            state.net.pingMs = message.pingMs;
            break;

        case 'activate_room':
            Rooms.setActivePlayer(state.rooms, state.net, message.playerId);
            break;

        case 'room_left':
            Rooms.applyRoomLeft(state, message);
            break;

        case 'net_message':
            Rpc.dispatchNetMessage(state.rpc, state.inbound.commands, message, undefined);
            break;

        case 'scene_sync':
            Rooms.applySceneSync(state, message);
            break;

        case 'room_list':
            Rooms.applyServerRoomList(state.rooms, JSON.parse(message.rooms) as RoomInfo[]);
            break;

        case 'voxel_chunk_full': {
            // promotion channel, an already-known chunk re-sent in full at a fixed rate
            // (see discovery.ts), so unlike voxel_region_full below this isn't timed for pacing
            const room = state.rooms.rooms.get(message.playerId);
            if (room) VoxelNet.applyChunkFull(state.voxelNet, room.voxels, message);
            break;
        }

        case 'voxel_region_full': {
            const room = state.rooms.rooms.get(message.playerId);
            if (room) {
                // timed for adaptive pacing: the ack (flushed at end of processInbox) reports
                // the smoothed decode rate so the server can size its per-tick budget
                const decodeStart = performance.now();
                VoxelNet.applyRegionFull(state.voxelNet, room.voxels, message);
                VoxelNet.recordRegionDecodeTime(state.voxelNet, message.playerId, performance.now() - decodeStart);
            }
            break;
        }

        case 'voxel_chunk_ops': {
            const room = state.rooms.rooms.get(message.playerId);
            if (room) VoxelNet.applyChunkOps(room.voxels, message);
            break;
        }

        case 'voxel_chunk_light': {
            const room = state.rooms.rooms.get(message.playerId);
            if (room) VoxelNet.applyChunkLight(room.voxels, message);
            break;
        }

        case 'voxel_chunk_light_delta': {
            const room = state.rooms.rooms.get(message.playerId);
            if (room) VoxelNet.applyChunkLightDelta(room.voxels, message);
            break;
        }

        case 'voxel_region_del': {
            const room = state.rooms.rooms.get(message.playerId);
            if (room) VoxelNet.applyRegionDel(room.voxels, message);
            break;
        }

        case 'room_frames':
            Telemetry.applyRoomFrames(state.rooms, message);
            break;

        case 'debug_logs':
            Telemetry.applyDebugLogs(state.rooms, message);
            break;

        case 'wire_table':
            state.inbound = buildInboundProtocol(message, registry);
            break;

        case 'register_model':
            // serverUrl is unused on the client but required by the shape, so mirror clientUrl into it
            Resources.setModel(state.resources, message.id, {
                clientUrl: message.clientUrl,
                serverUrl: message.clientUrl,
                source: 'runtime',
                hash: message.hash,
                size: message.size,
            });
            break;

        case 'unregister_model':
            Resources.releaseModel(state.resources, message.id);
            Resources.deleteModel(state.resources, message.id);
            break;

        case 'chat_broadcast': {
            const room = Rooms.findRoomByRoomId(state.rooms, message.roomId);
            if (room) Chat.enqueueBroadcast(room.chat, { from: message.from, text: message.text, kind: message.kind });
            break;
        }
    }
}

/** Apply an authored scene payload to its handle and re-populate scene state. Called from
 *  `load()` and the dev boot template's `bongle:scene-update` HMR listener; mirrors the
 *  server function in `server/engine-server.ts` minus the disk-seed concern. */
export function applyScenePayload(state: EngineClient, id: string, payload: Content.ScenePayload): void {
    const previous = registry.scenes.byId.get(id);
    if (!previous) return;
    Content.populateScene(state.content, registry.blockRegistry, id, payload, 'client');
    Registry.setScenePayload(id, payload);
}

/** clear an authored scene from its handle; called from the dev boot template's
 *  `bongle:scene-clear` HMR listener. */
export function clearScene(state: EngineClient, id: string): void {
    const previous = registry.scenes.byId.get(id);
    Content.clearScene(state.content, id, 'client');
    if (previous) {
        Registry.setScenePayload(id, null);
    }
}

/** dt clamp guarding integrators against spikes after tab refocus, GC pauses, or
 *  debugger breaks. 0.2s is a 5fps floor; `wall` keeps the true unclamped elapsed. */
const MAX_DELTA_S = 0.2;

/** How long a room with no chunks is given to receive some before it counts as a
 *  game with no voxel world at all. One server tick plus a slow link's round trip;
 *  the host's own backstop covers anything past that. */
const VOXEL_ARRIVAL_GRACE_S = 1.5;

export function update(state: EngineClient, delta: number) {
    // a lost GPU device leaves nothing presentable; freeze on the last frame
    if (state.deviceLost) return;

    // clamped delta drives integrators; raw wallDelta drives the render/server clock
    const wallDelta = delta;
    if (delta > MAX_DELTA_S) delta = MAX_DELTA_S;
    Debug.frameStart(state.profiler);

    // advance each render clock up front so inbox receipt + the reads below share one `now`
    for (const room of state.rooms.rooms.values()) Clock.advanceWall(room.clock, wallDelta);

    processInbox(state, delta);

    Manifest.sync(state.manifest, state.net);

    // silence the game while a platform ad shows; no-ops unless the value changed
    if (state.audioResources) Audio.setOutputMuted(state.audioResources, state.ads.active);

    const activeRoom = Rooms.getActiveRoom(state.rooms);

    // only the active room receives input, so its controllers see zeroed deltas here
    if (activeRoom) {
        Debug.begin(state.profiler, 'on-input');
        SceneTree.runOnInput(activeRoom.scene, { delta }, state.profiler);
        Debug.end(state.profiler, 'on-input');
    }

    // inactive rooms keep advancing scripts/animation too
    for (const room of state.rooms.rooms.values()) {
        Clock.syncServer(room.clock, room.clock.wall, delta);

        Debug.begin(state.profiler, 'on-update');
        SceneTree.runOnUpdate(room.scene, { delta }, state.profiler);
        Debug.end(state.profiler, 'on-update');

        Debug.begin(state.profiler, 'particles-tick');
        Particles.update(room.particles, delta, performance.now() / 1000, room.voxels);
        Debug.end(state.profiler, 'particles-tick');
    }

    // one global accumulator drives lockstep across rooms
    state.accumulator += delta;
    const timestep = 1 / CLIENT_TICK_HZ;

    // the server's cadence, resolved from the game's own config (same bundle, same
    // registry), so owner uploads land at most one per server tick. A standalone game
    // has no server to send to; the interval is unused there.
    const uploadInterval = 1 / (serverTickRate(resolveConfig(registry)) ?? CLIENT_TICK_HZ);

    while (state.accumulator >= timestep) {
        for (const room of state.rooms.rooms.values()) {
            Debug.begin(state.profiler, 'room');

            Clock.tick(room.clock, timestep);
            Interpolation.snapshot(room.scene);
            SceneTree.runOnTick(room.scene, { step: timestep }, state.profiler);
            Prefab.tick(room.scene, room.context, state.resources, room.voxels, 'client');

            Debug.begin(state.profiler, 'physics/pre');
            Physics.preStep(room.physics, room.scene, state.resources, room.playerId, room.playerMode === 'play');
            Debug.end(state.profiler, 'physics/pre');

            Debug.begin(state.profiler, 'physics');
            Physics.tick(room.physics, room.scene, timestep);
            Debug.end(state.profiler, 'physics');

            Debug.begin(state.profiler, 'physics/post');
            Physics.postStep(room.physics, room.scene, room.playerId);
            Physics.flush(room.physics);
            Debug.end(state.profiler, 'physics/post');

            Debug.end(state.profiler, 'room');
        }

        // gated separately from the sim: the sim runs at 60 on every client, the upload
        // at the rate the server actually consumes.
        state.uploadAccumulator += timestep;
        if (state.uploadAccumulator >= uploadInterval) {
            // carry the remainder rather than zeroing, so a rate that doesn't divide the
            // timestep still averages out instead of drifting slow.
            state.uploadAccumulator -= uploadInterval * Math.floor(state.uploadAccumulator / uploadInterval);
            for (const room of state.rooms.rooms.values()) {
                Replication.sendOwnerSyncUpdates(state.net, room.scene, room.roomId, room.playerId, room.syncSnapshots);
            }
        }

        state.accumulator -= timestep;
    }

    // once per frame rather than per fixed step; a catch-up frame would otherwise walk the pool repeatedly.
    for (const room of state.rooms.rooms.values()) Physics.recordStats(state.profiler, room.physics);

    const alpha = state.accumulator / timestep;
    const settings = state.perf.settings;

    // every room advances (inactive viewports are display:none but stay live for fast tab
    // swaps); only the active room later meshes voxels
    for (const room of state.rooms.rooms.values()) {
        // interpolate first so rig roots sit at their visual pose before visibility; remote
        // transforms chase the latest received pose, so a bad link can't freeze a stale keyframe
        Debug.begin(state.profiler, 'interpolate');
        Interpolation.interpolate(room.scene, room.playerId, alpha, delta);
        Debug.end(state.profiler, 'interpolate');

        Debug.begin(state.profiler, 'on-frame');
        SceneTree.runOnFrame(room.scene, { delta }, state.profiler);
        Debug.end(state.profiler, 'on-frame');

        // after the frame's last writer, before its first reader (the mesher): a block write
        // marks the chunk dirty but only queues the light, so reading it first would bake a
        // black hole where the player dug
        Debug.begin(state.profiler, 'lighting');
        Light.flushPendingLight(room.voxels);
        Debug.end(state.profiler, 'lighting');

        Chat.tick(room.chat, state.net, room.roomId);

        // resolve the POV camera after frame scripts write its pose/fov, before any reader
        const povCamera = Rooms.resolveRoomCamera(state.renderer.camera, room);
        if (!povCamera) continue;

        // gated per-rig on `cull.visible`, which still holds last frame's result here since
        // Visibility.update rewrites it below; the animator forces a sample on its own
        // false->true edge so a rig entering view never renders a stale pose
        Debug.begin(state.profiler, 'animation');
        Animation.tick(room.animations, state.resources, delta);
        Debug.end(state.profiler, 'animation');

        Debug.begin(state.profiler, 'on-post-animate');
        SceneTree.runOnPostAnimate(room.scene, { delta }, state.profiler);
        Debug.end(state.profiler, 'on-post-animate');

        // everything below this line reads visual transforms; nothing below writes a local
        Debug.begin(state.profiler, 'concatenate');
        Interpolation.concatenate(room.scene);
        Debug.end(state.profiler, 'concatenate');

        Debug.begin(state.profiler, 'on-pre-render');
        SceneTree.runOnPreRender(room.scene, { delta }, state.profiler);
        Debug.end(state.profiler, 'on-pre-render');

        // same view radius as the chunk mesher, so rigs fade with chunks
        Debug.begin(state.profiler, 'visibility');
        Visibility.update(room.visibility, povCamera, settings.voxelViewChunkRadius * Voxels.CHUNK_SIZE);
        Debug.end(state.profiler, 'visibility');

        Debug.begin(state.profiler, 'audio');
        Audio.updateForFrame(room.audio, room);
        Debug.end(state.profiler, 'audio');
    }

    // the per-room loop left the camera on whichever room it visited last; resolve the
    // active room's POV back for the render tick + draw
    const activeCamera = activeRoom ? Rooms.resolveRoomCamera(state.renderer.camera, activeRoom) : null;

    // one render tick after the loop, so every room's animation is settled and a
    // backgrounded room can never be meshed; null activeRoom tears the slot down
    Debug.begin(state.profiler, 'visuals');
    state.renderer.updateFrame(activeRoom, {
        viewport: state.viewport,
        resources: state.resources,
        now: performance.now() / 1000,
        povCamera: activeCamera,
        profiler: state.profiler,
    });
    Debug.end(state.profiler, 'visuals');

    // only the active room renders to the GPU
    if (activeRoom) {
        Debug.begin(state.profiler, 'render');
        state.renderer.render(settings.voxelViewChunkRadius);
        Debug.end(state.profiler, 'render');

        const { debugOpen, showGpucatInspector } = useClient.getState();
        state.renderer.setInspectorVisible(debugOpen && showGpucatInspector);

        Telemetry.reconcileSubscriptions(state);

        // tell the host the game is up only once the frame with real geometry has gone
        // out, so the canvas it uncovers has the game on it rather than black; once per
        // room, a room switch builds a new one with the flag clear
        if (!activeRoom.readyReported) {
            activeRoom.renderedTimeS += wallDelta;
            // an empty world reads as drawable, and a streaming world looks the same for
            // its first frames until regions arrive; the grace distinguishes the two
            const streaming = activeRoom.voxels.chunks.size === 0 && activeRoom.renderedTimeS < VOXEL_ARRIVAL_GRACE_S;
            if (!streaming && state.renderer.voxelWorldDrawable()) {
                activeRoom.readyReported = true;
                state.driver.ready?.();
            }
        }

        const netStats = Net.drainNetStats(state.net);
        if (delta > 0) Telemetry.recordNetStats(state.profiler, netStats, delta);
        Debug.record(state.profiler, 'net/ping', state.net.pingMs, 'ms');
    }

    // no-op for inactive rooms, which saw no events
    for (const room of state.rooms.rooms.values()) Input.resetInput(room.input);

    // release pointer-lock here every frame; acquire only fires from user gestures
    Input.reconcilePointerLock(state.inputManager);

    // one-way mirror since React can't reach the React-free input layer
    if (useClient.getState().inputMode !== state.inputManager.inputMode) {
        useClient.getState().setInputMode(state.inputManager.inputMode);
    }

    // echo the latest server ping-stamp so the server measures our RTT
    Net.send(state.net, { type: 'net_ping_ack', serverStampAck: state.net.lastServerStamp });

    Net.flush(state.net, state.driver.send);

    Debug.frameEnd(state.profiler);
}

export function dispose(state: EngineClient): void {
    for (const room of state.rooms.rooms.values()) {
        Rooms.disposeRoom(room);
    }
    state.rooms.rooms.clear();
    state.rooms.activePlayerId = null;
    useClient.setState({ rooms: new Map(), activePlayerId: null, inputManager: null });

    if (state.inputManager) Input.disposeInputManager(state.inputManager);
    // renderer is null until load() runs; guard early dispose
    if (state.renderer) {
        state.renderer.canvas.remove();
        state.renderer.disposeResources();
        state.renderer.dispose();
    }
    state.domElement?.remove();
}

/** The play client as a `ClientApp`: what a bundle default-exports and a host (the play
 *  page, `bongle start`) drives. Edit hosts mount the editor instead and call these
 *  functions themselves. */
export function app(opts: Omit<InitOptions, 'mode' | 'driver'>): ClientApp<EngineClient> {
    return {
        init: (driver) => init({ ...opts, mode: 'play', driver }),
        load: async (state) => {
            // the Viewport owns the canvas, so it mounts before load: load's resize
            // needs the viewport element to size the renderer
            mountPlayUI(state.domElement);
            await load(state);
            if (isStandaloneBuild()) startStandaloneRoom(state);
        },
        update,
        dispose,
        receive,
    };
}

/** Re-apply registry changes to `state` on every settled flush (HMR / re-declare), plus an
 *  initial apply. Call after `load` so the first apply sees the render tier. Dev only. */
export function watchRegistry(state: EngineClient): () => void {
    const unregister = registerFlushHandler(() => applyRegistryChanges(state));
    requestFlush();
    return unregister;
}
