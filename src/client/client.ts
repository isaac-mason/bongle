import type { ClientDriver, JsonValue } from 'bongle/interface';
import * as Clock from '../core/clock';
import { isStandalone } from '../core/config';
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
import * as ModelLighting from '../render/models/model-lighting';
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
import { seedModels } from './registry-dispatch';
import * as Replication from './replication';
import * as Rooms from './rooms';
import * as ClientRpc from './rpc';
import * as Telemetry from './telemetry';
import * as Transfer from './transfer';
import { useClient } from './ui/stores/client-store';
import * as Viewport from './viewport';
import * as VoxelNet from './voxel-net';

export type InitOptions = {
    mode: 'edit' | 'play';
    /**
     * Transport for actions a script triggers on the client that need to
     * exit the engine, currently just `client.matchmake` (re-enter matchmaking
     * with new options/joinData). bongle dev wraps a `play` message send;
     * deployed (game-client/poki) wraps the iframe-parent bridge so the
     * parent disposes + re-enqueues. Always
     * supplied: assemblers construct one at boot.
     */
    driver: ClientDriver;
    /**
     * The environment's resource-loading bag, byte loading (model bins, atlas
     * PNGs, ...) plus the optional image decoder. Browser boot templates pass
     * `browserResourceLoader`; the asset pipeline passes a disk + sharp loader.
     * Required so engine-client owns no environment-specific I/O.
     */
    resourceLoader: ResourceLoader;
    /**
     * The element the engine mounts its UI root into. Full-page boot templates
     * pass `document.body`; a library consumer embedding the engine into a page
     * it doesn't own passes its own container so nothing lands on the page body.
     */
    domElement: HTMLElement;
};

// Re-export the registry-dispatch entry so the client boot template can call
// `EngineClient.applyRegistryChanges(state)` from its flush handler.
export { applyRegistryChanges, refreshAudioResources, refreshBlockResources, refreshSpriteResources } from './registry-dispatch';

// Re-export the play-mode UI mount so the play-mode boot template can mount
// the play shell directly, keeps `engine-client` free of `env.editor` UI
// branches; the editor counterpart lives at `bongle/engine-client-editor`.
export { mountPlayUI } from './ui/play-ui';

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
    const metrics = Debug.createMetrics(useClient.getState().debugOpen);

    // resolved during load(): the GPU renderer, the decoded audio atlas, the
    // server's inbound decode table, and the performance tier + budgets.
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
        metrics,
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
    Input.installCanvasTouchListeners(canvas, state.inputManager);
}

export async function load(state: EngineClient) {
    // Kick the atlas downloads off before the backend import + device handshake,
    // which they'd otherwise queue behind: nothing below needs them until
    // `loadResources`, and `loadBytes` picks up whatever is already in flight.
    state.resources.loader.prefetch?.('voxels-atlas.json');
    state.resources.loader.prefetch?.('voxels-atlas.png');

    // load-split the backend + run the device handshake (falls back WebGPU->WebGL2)
    // before anything touches the renderer.
    const { renderer, caps } = await loadRenderBackend();
    state.renderer = renderer;

    // a lost GPU device invalidates every resource; recreation isn't wired, so
    // halt the frame loop and tell the user to reload.
    renderer.onDeviceLost = (info) => {
        state.deviceLost = true;
        console.error(
            `[engine] render device lost (${info.api})${info.reason ? `: ${info.reason}` : ''}. ` +
                `The GPU context was invalidated; reload to restore rendering.`,
        );
    };

    // user modules registered before this; build the derived index fields once.
    reindexRegistry(registry);

    // safe default until the server's first wire_table lands (which arrives before
    // any packed payload, so this is overwritten before join_room decodes).
    state.inbound = localInbound(registry);

    seedModels(state);

    // populate any scene handle whose authored payload was stamped at module-eval.
    for (const [sceneId, handle] of registry.scenes.byId) {
        if (handle._payload) applyScenePayload(state, sceneId, handle._payload);
    }

    // device is live; resolve the tier + budgets that every subsystem below derives
    // from. everything past here may call into gpucat.
    state.perf = Performance.resolve(caps);
    Performance.log(state.perf);

    state.renderer.initResources({ blockRegistry: registry.blockRegistry, voxelBudget: state.perf.voxelBudget });

    // sprite atlas metadata must be resident before the backend's atlas load reads it.
    state.resources.spriteAtlas = await loadAtlasMetadata(state.resources.loader);

    // async pass: backend pre-warms pipelines + fetches atlases; audio races alongside.
    const [audioResources] = await Promise.all([
        Audio.loadResources(state.resources.loader),
        state.renderer.loadResources({
            blockRegistry: registry.blockRegistry,
            settings: state.perf.settings,
            resources: state.resources,
        }),
    ]);
    state.audioResources = audioResources!;
    // the AudioContext boots suspended; wake it on the first user gesture.
    Audio.installGestureUnlock(state.audioResources);

    mountDisplayCanvas(state);
    Viewport.bindToStore(state.viewport, state.renderer, state.perf.profile);
    Telemetry.bindToStore(state);

    useClient.getState().setClientGlobalMetrics(state.metrics);
    useClient.getState().setInputManager(state.inputManager);

    // drop the `added` events from initial declarations so the first HMR flush
    // logs only real deltas. (UI mounting is the boot template's job.)
    Registry.clearPendingChanges([
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
        registry.sprites,
    ]);
}

function processInbox(state: EngineClient): void {
    for (const frame of state.net.inbox) {
        // decode the frame back into a message batch; fragments of a big batch
        // may span ticks, so the reassembler persists in net state.
        let messages: Uint8Array[] | null;
        try {
            messages = acceptFrame(state.net.reassembler, frame);
        } catch (err) {
            console.error('[bongle] inbound framing error:', err);
            state.net.reassembler = createReassembler();
            continue;
        }
        if (!messages) continue;

        for (const messageBytes of messages) {
            const message = Protocol.unpackServerMessage(messageBytes);

            if (!message) {
                // TODO: warn
                continue;
            }

            state.net.bytesInByType.set(message.type, (state.net.bytesInByType.get(message.type) ?? 0) + messageBytes.byteLength);

            // one malformed/unexpected message must never take down the whole
            // tick loop (mirrors the framing-layer guard above). log it, skip
            // that message, keep draining — rendering/input/net stay alive.
            try {
                dispatchInboundMessage(state, message);
            } catch (err) {
                console.error(`[bongle] error handling '${message.type}' message, skipping:`, err);
            }
        }
    }

    state.net.inbox.length = 0;

    VoxelNet.flushAcks(state.voxelNet, state.net);
}

function dispatchInboundMessage(state: EngineClient, message: Protocol.ServerMessage): void {
    switch (message.type) {
        case 'join_room':
            // (re)joined: force a manifest resend + re-subscribe (server dropped
            // both on disconnect) now that our ClientState exists again over there.
            Manifest.reset(state.manifest);
            Telemetry.resetSubscriptions(state.telemetry);
            Rooms.applyJoinRoom(state, message);
            break;

        case 'server_clock':
            // fold the push into each room's clock against `wall` (the same
            // render-behind base syncServer reads, advanced up front this frame).
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
            // PROMOTION channel: an already-known chunk re-sent in full. fixed-rate,
            // not adaptive (see discovery.ts), so unlike voxel_region_full below this
            // isn't timed for pacing.
            const room = state.rooms.rooms.get(message.playerId);
            if (room) VoxelNet.applyChunkFull(state.voxelNet, room.voxels, message);
            break;
        }

        case 'voxel_region_full': {
            const room = state.rooms.rooms.get(message.playerId);
            if (room) {
                // timed for adaptive pacing: this player's ack (flushed at the end of
                // processInbox) reports the resulting smoothed decode rate so the
                // server can size dispatchRegionFull's per-tick budget accordingly.
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

        case 'room_metrics':
            Telemetry.applyRoomMetrics(state.rooms, message);
            break;

        case 'debug_logs':
            Telemetry.applyDebugLogs(state.rooms, message);
            break;

        case 'wire_table':
            state.inbound = buildInboundProtocol(message, registry);
            break;

        case 'register_model':
            // server-authoritative runtime model; serverUrl is unused on the client
            // but required by the shape, so mirror clientUrl into it.
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

/**
 * apply an authored scene payload to its handle and re-populate scene state.
 * called from `load()` (cold-load drain of `module.scenes`) and from the dev
 * boot template's `bongle:scene-update` HMR listener. mirror of the server
 * function in `server/engine-server.ts`, the client variant has no
 * ContentManager / disk seed (server-only concern).
 */
export function applyScenePayload(state: EngineClient, id: string, payload: Content.ScenePayload): void {
    const handle = registry.scenes.byId.get(id);
    if (!handle) return;
    handle._payload = payload;
    Content.populateScene(state.content, registry.blockRegistry, id, payload, 'client');
    Registry.touch(registry.scenes, id);
}

/**
 * clear an authored scene from its handle. called from the dev boot
 * template's `bongle:scene-clear` HMR listener.
 */
export function clearScene(state: EngineClient, id: string): void {
    const handle = registry.scenes.byId.get(id);
    if (handle) handle._payload = null;
    Content.clearScene(state.content, id, 'client');
    Registry.touch(registry.scenes, id);
}

/** dt clamp guarding integrators against spikes after tab refocus, GC pauses, or
 *  debugger breaks. 0.2s is a 5fps floor; `wall` keeps the true unclamped elapsed. */
const MAX_DELTA_S = 0.2;

export function update(state: EngineClient, delta: number) {
    // a lost GPU device leaves nothing presentable; freeze on the last frame.
    if (state.deviceLost) return;

    // clamped delta drives integrators; raw wallDelta drives the render/server clock.
    const wallDelta = delta;
    if (delta > MAX_DELTA_S) delta = MAX_DELTA_S;
    Debug.begin(state.metrics, 'tick');

    // advance each render clock up front so inbox receipt + the reads below share one `now`.
    for (const room of state.rooms.rooms.values()) Clock.advanceWall(room.clock, wallDelta);

    processInbox(state);

    Manifest.sync(state.manifest, state.net);

    // silence the game while a platform ad shows; no-ops unless the value changed.
    if (state.audioResources) Audio.setOutputMuted(state.audioResources, state.ads.active);

    const activeRoom = Rooms.getActiveRoom(state.rooms);

    // input pre-processing before onUpdate so controllers see zeroed deltas; only
    // the active room receives input (its canvas is the only one displayed).
    if (activeRoom) {
        Debug.begin(activeRoom.clientMetrics, 'on-input');
        SceneTree.runOnInput(activeRoom.scene, { delta }, activeRoom.clientMetrics);
        Debug.end(activeRoom.clientMetrics, 'on-input');
    }

    // per-frame pass for every room (inactive ones keep advancing scripts/animation).
    for (const room of state.rooms.rooms.values()) {
        Clock.syncServer(room.clock, room.clock.wall, delta);

        Debug.begin(room.clientMetrics, 'on-update');
        SceneTree.runOnUpdate(room.scene, { delta }, room.clientMetrics);
        Debug.end(room.clientMetrics, 'on-update');

        // particles run per-frame (visual fx, framerate-dependent motion is fine).
        Debug.begin(room.clientMetrics, 'particles-tick');
        Particles.update(room.particles, delta, performance.now() / 1000, room.voxels);
        Debug.end(room.clientMetrics, 'particles-tick');
    }

    // fixed update: one global accumulator drives lockstep across rooms.
    state.accumulator += delta;
    const timestep = 1 / 60;

    while (state.accumulator >= timestep) {
        for (const room of state.rooms.rooms.values()) {
            Debug.begin(room.clientMetrics, 'room');

            Clock.tick(room.clock, timestep);
            Interpolation.snapshot(room.scene);
            SceneTree.runOnTick(room.scene, { delta: timestep }, room.clientMetrics);
            Prefab.tick(room.scene, room.context, state.resources, room.voxels, 'client');

            Debug.begin(room.clientMetrics, 'physics');
            Physics.preStep(room.physics, room.scene, state.resources, room.playerId, room.playerMode === 'play');
            Physics.tick(room.physics, room.scene, timestep);
            Physics.postStep(room.physics, room.scene, room.playerId);
            Physics.flush(room.physics);
            Debug.end(room.clientMetrics, 'physics');

            // authoritative (local/standalone) rooms drain relight; no-op on networked
            // rooms, which receive baked light over the wire.
            Debug.begin(room.clientMetrics, 'lighting');
            Light.flushPendingLight(room.voxels);
            Debug.end(room.clientMetrics, 'lighting');

            Replication.sendOwnerSyncUpdates(state.net, room.scene, room.roomId, room.playerId, room.syncSnapshots);

            Debug.end(room.clientMetrics, 'room');
        }

        state.accumulator -= timestep;
    }

    const alpha = state.accumulator / timestep;
    const settings = state.perf.settings;

    // per-room visual pass. every room advances (inactive viewports are display:none
    // but stay live for fast tab swaps); only the active room later meshes voxels.
    for (const room of state.rooms.rooms.values()) {
        // interpolate first so rig roots sit at their visual pose before visibility.
        // remote transforms chase the latest received pose (no render-behind buffer),
        // so a bad link can't freeze a peer on a stale keyframe.
        Debug.begin(room.clientMetrics, 'interpolate');
        Interpolation.interpolate(room.scene, room.playerId, alpha, delta);
        Debug.end(room.clientMetrics, 'interpolate');

        // frame scripts run on settled visual transforms.
        Debug.begin(room.clientMetrics, 'on-frame');
        SceneTree.runOnFrame(room.scene, { delta }, room.clientMetrics);
        Debug.end(room.clientMetrics, 'on-frame');

        Chat.tick(room.chat, state.net, room.roomId);

        // resolve the POV camera AFTER frame scripts write its pose/fov, BEFORE any reader.
        const povCamera = Rooms.resolveRoomCamera(state.renderer.camera, room);
        if (!povCamera) continue;

        // frustum cull writes cull.visible, read by animation, model lighting, and the
        // renderers. same view radius as the chunk mesher so rigs fade with their chunks.
        Debug.begin(room.clientMetrics, 'visibility');
        Visibility.update(room.visibility, povCamera, settings.voxelViewChunkRadius * Voxels.CHUNK_SIZE);
        Debug.end(room.clientMetrics, 'visibility');

        Debug.begin(room.clientMetrics, 'modelLighting');
        ModelLighting.update(room.modelLighting, room.voxels);
        Debug.end(room.clientMetrics, 'modelLighting');

        // sample animations at render rate; gated per-rig on the fresh visibility above.
        Debug.begin(room.clientMetrics, 'animation');
        Animation.tick(room.animations, state.resources, delta);
        Debug.end(room.clientMetrics, 'animation');

        // procedural overrides (head-look, springs) after sampling, before matrix reads.
        Debug.begin(room.clientMetrics, 'on-post-animate');
        SceneTree.runOnPostAnimate(room.scene, { delta }, room.clientMetrics);
        Debug.end(room.clientMetrics, 'on-post-animate');

        Debug.begin(room.clientMetrics, 'audio');
        Audio.updateForFrame(room.audio, room);
        Debug.end(room.clientMetrics, 'audio');
    }

    // the per-room loop left the camera on whichever room it visited last; resolve
    // the active room's POV back for the render tick + draw.
    const activeCamera = activeRoom ? Rooms.resolveRoomCamera(state.renderer.camera, activeRoom) : null;

    // one render tick after the loop, so every room's animation is settled and a
    // backgrounded room can never be meshed. null activeRoom tears the slot down.
    state.renderer.updateFrame(activeRoom, {
        viewport: state.viewport,
        resources: state.resources,
        now: performance.now() / 1000,
        povCamera: activeCamera,
    });

    // only the active room renders to the GPU.
    if (activeRoom) {
        Debug.begin(activeRoom.clientMetrics, 'render');
        state.renderer.render(settings.voxelViewChunkRadius);
        Debug.end(activeRoom.clientMetrics, 'render');

        const { debugOpen, showGpucatInspector } = useClient.getState();
        state.renderer.setInspectorVisible(debugOpen && showGpucatInspector);

        Telemetry.reconcileSubscriptions(state);

        const netStats = Net.drainNetStats(state.net);
        if (delta > 0) Telemetry.recordNetStats(activeRoom.clientMetrics, netStats, delta);
        Debug.record(activeRoom.clientMetrics, 'net/ping', state.net.pingMs, 'ms');
    }

    // reset per-room input (no-op for inactive rooms, which saw no events).
    for (const room of state.rooms.rooms.values()) Input.resetInput(room.input);

    // release pointer-lock here every frame; acquire only fires from user gestures.
    Input.reconcilePointerLock(state.inputManager);

    // one-way mirror of the input modality into the React store (React can't reach
    // the React-free input layer).
    if (useClient.getState().inputMode !== state.inputManager.inputMode) {
        useClient.getState().setInputMode(state.inputManager.inputMode);
    }

    // echo the latest server ping-stamp so the server measures our RTT (Quake-style).
    Net.send(state.net, { type: 'net_ping_ack', serverStampAck: state.net.lastServerStamp });

    Net.flush(state.net);

    Debug.end(state.metrics, 'tick');
}

export function dispose(state: EngineClient): void {
    for (const room of state.rooms.rooms.values()) {
        Rooms.disposeRoom(room);
    }
    state.rooms.rooms.clear();
    state.rooms.activePlayerId = null;
    useClient.setState({ rooms: new Map(), activePlayerId: null, inputManager: null });

    if (state.inputManager) Input.disposeInputManager(state.inputManager);
    // renderer is null until load() runs; guard early dispose (disposeResources
    // self-guards when resources were never built).
    if (state.renderer) {
        state.renderer.canvas.remove();
        state.renderer.disposeResources();
        state.renderer.dispose();
    }
    state.domElement?.remove();
}
