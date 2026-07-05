import { env } from 'bongle';
import type { ClientDriver, JsonValue } from 'bongle/interface';
import { attachWorldTrait } from '../builtins/world';
import * as Clock from '../core/clock';
import * as Content from '../core/content';
import * as Debug from '../core/debug';
import * as Physics from '../core/physics/physics';
import type { RoomInfo } from '../core/protocol';
import * as Protocol from '../core/protocol';
import * as Registry from '../core/registry';
import { buildWireIndex, registry, type WireIndex } from '../core/registry';
import type { ResourceLoader } from '../core/resource-loader';
import * as Resources from '../core/resources';
import * as Rpc from '../core/rpc';
import * as Animation from '../core/scene/animation';
import * as Nodes from '../core/scene/nodes';
import * as Prefab from '../core/scene/prefab';
import { applySceneSyncUpdate } from '../core/scene/scene-pack';
import { AIR, MISSING, resolveKey } from '../core/voxels/block-registry';
import { decodeChunk, decodeLight } from '../core/voxels/chunk-codec';
import * as Voxels from '../core/voxels/voxels';
import * as CloudResources from '../render/cloud-resources';
import * as Device from '../render/device';
import * as Interpolation from '../render/interpolation';
import * as ModelLighting from '../render/model-lighting';
import * as ModelResources from '../render/models/model-resources';
import * as ModelVisuals from '../render/models/model-visuals';
import * as ParticleResources from '../render/particles/particle-resources';
import * as ParticleVisuals from '../render/particles/particle-visuals';
import * as Particles from '../render/particles/particles';
import * as Performance from '../render/performance';
import * as Renderer from '../render/renderer';
import * as ShadowResources from '../render/shadows/shadow-resources';
import * as ShadowVisuals from '../render/shadows/shadow-visuals';
import * as ExtrudedSpriteResources from '../render/sprites/extruded-sprite-resources';
import * as ExtrudedSpriteVisuals from '../render/sprites/extruded-sprite-visuals';
import * as SpriteResources from '../render/sprites/sprite-resources';
import * as SpriteVisuals from '../render/sprites/sprite-visuals';
import * as Visibility from '../render/visibility';
import * as VoxelMeshResources from '../render/voxels/voxel-mesh-resources';
import * as VoxelMeshVisuals from '../render/voxels/voxel-mesh-visuals';
import * as VoxelResources from '../render/voxels/voxel-resources';
import { type VoxelArenaBudget, voxelArenaBudgetForTier } from '../render/voxels/voxel-resources';
import * as VoxelVisuals from '../render/voxels/voxel-visuals';
import * as Audio from './audio/audio';
import * as Chat from './chat';
import * as DomUi from './dom-ui';
import * as Input from './input';
import * as Net from './net';
import * as Replication from './replication';
import * as Rooms from './rooms';
import * as ClientRpc from './rpc';
import { useClient } from './ui/client-store';
import * as Viewport from './viewport';

export type InitOptions = {
    mode: 'edit' | 'play';
    /**
     * Transport for actions a script triggers on the client that need to
     * exit the engine, currently just `client.matchmake` (re-enter matchmaking
     * with new gameOptions/joinData). Kit dev wraps a `play` message send;
     * deployed (game-client/poki) wraps the iframe-parent bridge so the
     * parent disposes + re-enqueues. Always
     * supplied: assemblers construct one at boot.
     */
    driver: ClientDriver;
    /**
     * The environment's resource-loading bag, byte loading (model bins, atlas
     * PNGs, …) plus the optional image decoder. Browser boot templates pass
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
// branches; the editor counterpart lives at `bongle/engine-editor`.
export { mountPlayUI } from './ui/play-ui';

export function init(opts: InitOptions) {
    const mode = opts.mode;

    // The engine's React UI root, mounted in `load()`. Appended into the caller's
    // `domElement` (`document.body` for full-page hosts; a library consumer passes
    // its own container so nothing lands on the page body). dispose() detaches it.
    const uiRoot = document.createElement('div');
    opts.domElement.appendChild(uiRoot);

    const renderer = Renderer.init();
    const net = Net.init();

    // hardware capability probe, resolved once at boot (touch never pointer-locks).
    const device = Device.init();

    // client-level DOM listener layer; routes events into whichever room's
    // Input is the active target (set by setActivePlayer).
    const inputManager = Input.createInputManager(device.touch);

    const content = Content.init();

    // The caller supplies the asset loader for its environment, browser boot
    // templates pass `fetchResourceLoader`, the Node pipeline worker reads off
    // disk. engine-client stays agnostic about where the bytes come from.
    const resources = Resources.init(opts.resourceLoader, 'client');

    // client-side rpc. driver constructed by ./rpc; listener registry +
    // dispatch live in core/rpc. one shared instance across all rooms;
    // listen() scopes per-room via runtime.roomId.
    const rpc = Rpc.init(ClientRpc.createDriver(net));

    return {
        mode,
        renderer,
        net,
        rpc,
        driver: opts.driver,
        domElement: uiRoot,
        inputManager,
        rooms: Rooms.init(),
        /** per-player buffer of chunk coords decoded + applied since the last
         *  flush, drained into one voxel_ack per player at the end of
         *  processInbox. frees the server's in-flight slots (voxel
         *  backpressure). keyed by playerId, one client may hold several. */
        voxelAckBuffer: new Map<number, Array<{ cx: number; cy: number; cz: number }>>(),
        content,
        resources,
        /** hardware capability probe, resolved once at boot. touch capability
         *  doesn't change for the session, so per-frame predicates
         *  (`isTouchDevice`) read this instead of recomputing. */
        device,
        /** engine-global viewport dimensions. populated by the resize hook
         *  registered in `load()`; per-frame consumers read width/height
         *  here instead of calling `clientWidth`/`clientHeight` (which
         *  trigger layout). */
        viewport: Viewport.init(),
        /** engine-global model atlas + cull compute. populated in `load()`
         *  alongside the other compute pre-warms. */
        modelResources: null! as ModelResources.ModelResources,
        /** engine-global voxel atlas + texAnim buffer. built in `load()`
         *  after the project module is captured; rebuilt on script reload
         *  because block defs and textures may have changed. per-room
         *  voxel materials reference these and rebind on atlas swap. */
        voxelResources: null! as VoxelResources.VoxelResources,
        /** engine-global voxel-mesh material + cull compute. depends on
         *  voxelResources (atlas + texAnim); rebuilt alongside it. */
        voxelMeshResources: null! as VoxelMeshResources.VoxelMeshResources,
        /** engine-global sprite atlas + frame UV LUT. sync-created at
         *  `load()` time with a magenta placeholder; the trailing async
         *  `SpriteResources.load()` fetches the real atlas if the kit
         *  pipeline has produced one. refreshed by the spritesRegistry
         *  dispatch branch + the `bongle:sprite-atlas-updated` HMR event. */
        spriteResources: null! as SpriteResources.SpriteResources,
        /** engine-global extruded-sprite material + cull compute. binds the
         *  sprite atlas Texture via a TextureNode; atlas swaps rebind it
         *  in place without rebuilding the compiled pipeline. */
        extrudedSpriteResources: null! as ExtrudedSpriteResources.ExtrudedSpriteResources,
        /** engine-global particle material + cull compute. binds the sprite
         *  atlas Texture via a TextureNode; atlas swaps rebind it in place. */
        particleResources: null! as ParticleResources.ParticleResources,
        /** engine-global cloud system, material, geometry, static
         *  storage buffers, and the shared compacted+indirect buffers the
         *  active room's CloudVisuals.update writes to each frame. */
        cloudResources: null! as CloudResources.CloudResources,
        /** engine-global shadow material. per-room ShadowVisuals routes
         *  its `instance` buffer by name. */
        shadowResources: null! as ShadowResources.ShadowResources,
        /** engine-global audio resources, manifest + decoded atlas +
         *  AudioContext. populated in `load()` (async fetch + decode).
         *  the clips map is empty when no manifest was emitted, but the
         *  AudioContext is always live. */
        audioResources: null! as Audio.AudioResources,
        /**
         * INBOUND wire-index tables for messages received from the server,
         * the server's outbound tables, mirrored on this side. seeded from
         * the client's local module at `load()` time (both peers built from
         * the same source, so they agree at connect) and refreshed by
         * inbound `wire_table` messages after the server HMRs.
         */
        inboundTraitWireIndex: null! as WireIndex,
        inboundCommandWireIndex: null! as WireIndex,
        accumulator: 0,
        /** global metrics (tick timing). starts disabled, flipped on by the
         *  debugOpen subscription in `load()` so per-frame begin/end work is
         *  skipped while the debug panel is closed. */
        metrics: Debug.createMetrics(useClient.getState().debugOpen),
        /** engine-wide quality tier + GPU limits + adapter info. populated in
         *  `load()` after the renderer's device handshake, subsystems derive
         *  their own budgets from `profile.active` (see `voxelArenaBudgetForTier`
         *  in voxel-visuals.ts). */
        performance: null! as Performance.Profile,
        /** per-room voxel arena/section sizing, derived from `performance`
         *  once at boot. threaded into every `VoxelVisuals.init` call so
         *  rooms allocate identical-sized arenas regardless of who creates
         *  them (server-joined, local, asset-pipeline). */
        voxelBudget: null! as VoxelArenaBudget,
        /** last value sent in `debug_subscribe`, re-sent only on edge
         *  transitions, not every frame. */
        debugLogsSubscribed: false,
        /** true while a portal ad (commercial/rewarded break) is showing. Set
         *  by `api/platform`; the update loop reconciles audio output mute
         *  against it each frame, so the game is silenced during ads with no
         *  game code involved. */
        adActive: false,
    };
}

export type EngineClient = ReturnType<typeof init>;

/**
 * Boot a self-contained room, no server, no matchmaking, one local player.
 * Used by the kit `standalone` build (and the asset pipeline worker conceptually):
 * `init()` → `load()` → `startStandaloneRoom()` → frame loop. The returned
 * room is already the active player; the caller just has to drive `update()`.
 */
export function startStandaloneRoom(state: EngineClient, sceneId: string): Rooms.ClientRoom {
    const room = Rooms.startLocalRoom({
        state,
        sceneId,
        clientId: 0,
        playerMode: 'play',
        roomMode: 'play',
    });
    Rooms.setActivePlayer(state.rooms, state.net, state.voxelResources, room.playerId);
    return room;
}

/**
 * Send a `play` message to the server. Kit-dev wraps this in its
 * ClientDriver.matchmake impl, the local game server then find-or-creates a
 * namespaced room and re-joins this client. Deployed shells (game-client/poki)
 * bypass the engine entirely and signal the parent host instead.
 */
export function play(
    state: EngineClient,
    opts: { gameOptions: Record<string, string | number | boolean>; joinData?: Record<string, JsonValue> },
): void {
    Net.send(state.net, {
        type: 'play',
        sceneId: undefined,
        sourceRoomId: undefined,
        gameOptions: JSON.stringify(opts.gameOptions),
        joinData: opts.joinData ? JSON.stringify(opts.joinData) : undefined,
    });
}

/**
 * (re)seed `state.resources.models` + `state.resources.modelPayloads` from
 * the unified registry's `models` store. drops any old entries first
 * so vanished payloads release atlas/geometry pool slots on the next
 * `ModelResources.update` tick.
 */
function seedModels(state: EngineClient): void {
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

export async function load(state: EngineClient) {
    // seed with our local registry so any sync field decode that fires
    // before the server's first `wire_table` lands has a table to use.
    // server emits `wire_table` immediately on connect (before any
    // packed payload), and again on HMR drift, so this seed is just a
    // safe default, it's overwritten before `join_room` decodes.
    state.inboundTraitWireIndex = registry.traitWireIndex;
    state.inboundCommandWireIndex = registry.commandWireIndex;

    // seed Resources.models from the unified registry. lazy systems
    // (renderer, animator) trigger ensureModel on first reference.
    seedModels(state);

    // scene handles live on `registry.scenes` (declared via `scene()`). their
    // authored `_payload` was stamped at module-eval by the codegen barrel's
    // `_registerScenePayload` calls, walk the store and populate any handle
    // whose payload is set. live updates (dev) flow through
    // `applyScenePayload`/`clearScene` from the boot template's HMR listeners.
    for (const [sceneId, h] of registry.scenes.byId) {
        if (!h.payload._payload) continue;
        applyScenePayload(state, sceneId, h.payload._payload);
    }

    // renderer init gates everything that calls into gpucat (material
    // builds, compileCompute pre-warms). do it once, up front; everything
    // below runs concurrently afterwards. env GPU buffers + the engine-
    // global post-chain pipeline are wired up in `Renderer.init()` (sync,
    // pre-load); this just runs the device handshake.
    await Renderer.load(state.renderer);

    // adapter is now resolved on the gpucat renderer. detect tier + GPU
    // limits up front so every subsystem below can derive its budget
    // from `state.performance.active`.
    state.performance = Performance.detect(state.renderer.renderer._adapter);
    state.voxelBudget = voxelArenaBudgetForTier(state.performance);
    const voxelBudget = state.voxelBudget;
    const settings = Performance.settingsForTier(state.performance);
    console.log(
        `[performance] tier=${state.performance.active} (auto=${state.performance.autoDetected}, source=${state.performance.source}) ` +
            `platform=${state.performance.platform} ` +
            `arch="${state.performance.adapterInfo.architecture}" ` +
            `voxelArena=${(voxelBudget.quadArenaBytes / 1024 / 1024).toFixed(0)}MB+${(voxelBudget.quadOrderBytes / 1024 / 1024).toFixed(0)}MB sections=${voxelBudget.maxSections} ` +
            `viewRadius=${settings.voxelViewChunkRadius}ch`,
    );
    {
        const L = state.performance.limits;
        const MB = (n: number) => `${(n / 1024 / 1024).toFixed(0)}MB`;
        console.log(
            `[performance] adapter limits: maxBufferSize=${MB(L.maxBufferSize)} ` +
                `maxStorageBufferBindingSize=${MB(L.maxStorageBufferBindingSize)} ` +
                `maxComputeWorkgroupsPerDimension=${L.maxComputeWorkgroupsPerDimension}`,
        );
    }

    // catch the specific buffer that fails, chromebook prints the
    // validation message before APICreateErrorBuffer but doesn't tag the
    // buffer; this scope-pushes around every WebGPU command and surfaces
    // the offender. cheap to leave on; one log per uncaptured error.
    const gpuDevice = state.renderer.renderer._device as GPUDevice | undefined;
    if (gpuDevice) {
        gpuDevice.addEventListener('uncapturederror', (e) => {
            console.error('[webgpu] uncaptured error:', (e as GPUUncapturedErrorEvent).error.message);
        });
    }

    // sync init pass, every *Resources.init() is pure construction (no
    // side effects, no awaits). Builds materials + cull computes against
    // the magenta placeholder atlas so the downstream extruded/particle
    // inits can name-bind it immediately.
    state.spriteResources = SpriteResources.init();
    state.extrudedSpriteResources = ExtrudedSpriteResources.init(state.spriteResources);
    state.particleResources = ParticleResources.init(state.spriteResources.atlas);
    state.cloudResources = CloudResources.init(state.renderer.environmentResources);
    state.modelResources = ModelResources.init();
    state.shadowResources = ShadowResources.init();

    state.voxelResources = VoxelResources.init(registry.blockRegistry, state.renderer.environmentResources, voxelBudget);
    state.voxelMeshResources = VoxelMeshResources.init(state.voxelResources.atlas, state.voxelResources.texAnimBuffer);

    // async load pass, pre-warms compile pipelines, fetches atlases. All
    // resources race in parallel; the placeholder atlas keeps materials
    // valid until SpriteResources.load() swaps the real atlas in.
    const audioPromise = Audio.loadResources();
    const spriteLoadPromise = SpriteResources.load(state.spriteResources);
    const voxelLoadPromise = VoxelResources.load(
        state.voxelResources,
        registry.blockRegistry,
        settings.voxelWorkerCount,
        settings.voxelWorkerQueueDepth,
        state.resources,
        state.renderer.renderer,
    );

    const [audioResources] = await Promise.all([audioPromise, spriteLoadPromise, voxelLoadPromise]);

    state.audioResources = audioResources!;

    // Both extruded-sprite and particle materials captured a TextureNode
    // against `state.spriteResources.atlas` *as it was during init()*,
    // i.e. the magenta placeholder. `SpriteResources.load()` then ran
    // concurrently and swapAtlas'd the placeholder out (disposing it), but
    // `rebindAtlas` only fires from `refreshSpriteResources` on registry
    // change, not the initial load. Without this re-bind the particle
    // material samples a disposed texture (renders white on most GPUs).
    ExtrudedSpriteResources.rebindAtlas(state.extrudedSpriteResources, state.spriteResources.atlas);
    ParticleResources.rebindAtlas(state.particleResources, state.spriteResources.atlas);

    // resize the renderer + cameras when the viewport div changes size.
    // useClient is the source of truth, Viewport writes dims into the store
    // on mount + ResizeObserver, the engine reads current values here and
    // subscribes for future changes. No callback-registration race: if the
    // Viewport mounted before this point (mountPlayUI runs before load), the
    // store already holds the right dims.
    const applyViewportSize = (w: number, h: number): void => {
        if (w === 0 || h === 0) return;
        state.viewport.domElement = useClient.getState().viewportElement;
        state.viewport.width = w;
        state.viewport.height = h;

        // resize all room canvas targets so they're ready when switched to.
        // camera aspect/projection is no longer event-driven, the renderer
        // pulls viewport size from canvasTarget each frame in `bindRenderCamera`
        // and writes aspect into the active POV camera.
        for (const room of state.rooms.rooms.values()) {
            room.canvasTarget.setPixelRatio(window.devicePixelRatio);
            room.canvasTarget.setSize(w, h);
        }

        Renderer.resize(state.renderer, w, h);
    };
    const initial = useClient.getState();
    applyViewportSize(initial.viewportWidth, initial.viewportHeight);
    let prevW = initial.viewportWidth;
    let prevH = initial.viewportHeight;
    useClient.subscribe((s) => {
        if (s.viewportWidth === prevW && s.viewportHeight === prevH) return;
        prevW = s.viewportWidth;
        prevH = s.viewportHeight;
        applyViewportSize(s.viewportWidth, s.viewportHeight);
    });

    // expose global client metrics to the debug panel.
    useClient.getState().setClientGlobalMetrics(state.metrics);

    // expose the InputManager so React overlays can free the cursor while open.
    useClient.getState().setInputManager(state.inputManager);

    // gate per-frame Debug.begin/end work on `debugOpen`, those samples are
    // only consumed by the panel, and the timer calls add up on profile traces.
    // server metrics stay always-on (they ship to clients regardless).
    let prevDebugOpen = useClient.getState().debugOpen;
    useClient.subscribe((s) => {
        if (s.debugOpen === prevDebugOpen) return;
        prevDebugOpen = s.debugOpen;
        Debug.setEnabled(state.metrics, s.debugOpen);
        for (const room of state.rooms.rooms.values()) {
            Debug.setEnabled(room.clientMetrics, s.debugOpen);
            Debug.setEnabled(room.serverMetrics, s.debugOpen);
        }
    });

    // UI mounting is the boot template's job: edit mode calls
    // `EngineEditor.setup` (bongle/engine-editor) between init and load;
    // play mode calls `EngineClient.mountPlayUI(state.domElement)`. Keeping
    // it out here means `engine-client` has zero `env.editor` UI branches.

    // initial registry population is consumed via the singleton above,
    // drop the `added` events accumulated on each store's `pendingChanges`
    // so the first HMR-driven flush only logs real deltas instead of
    // replaying every declaration as freshly added.
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
        registry.matchmaking,
        registry.sounds,
        registry.sprites,
    ]);
}

function processInbox(state: EngineClient): void {
    for (const packet of state.net.inbox) {
        const unpacked = Protocol.unpackServerPacket(packet);

        for (const messageBytes of unpacked.messages) {
            const message = Protocol.unpackServerMessage(messageBytes);

            if (!message) {
                // TODO: warn
                continue;
            }

            state.net.bytesInByType.set(message.type, (state.net.bytesInByType.get(message.type) ?? 0) + messageBytes.byteLength);

            switch (message.type) {
                case 'join_room':
                    processJoinRoom(state, message);
                    break;

                case 'server_clock': {
                    // a server-clock push, fold it into the room's estimate. recvTime is
                    // the room's render clock (`wall`, advanced up front this frame): the
                    // same base syncServer reads, so the offset is coherent and render-behind.
                    for (const room of Rooms.getRoomsByRoomId(state.rooms, message.roomId)) {
                        Clock.observeSample(room.clock, message.serverClock, room.clock.wall);
                    }
                    break;
                }

                case 'activate_room':
                    processActivateRoom(state, message);
                    break;

                case 'room_left':
                    processRoomLeft(state, message);
                    break;

                case 'net_message':
                    processNetMessage(state, message);
                    break;

                case 'scene_sync':
                    processSceneSync(state, message);
                    break;

                case 'room_list':
                    processRoomList(state, message);
                    break;

                case 'voxel_chunk_full':
                    processVoxelChunkFull(state, message);
                    break;

                case 'voxel_chunk_ops':
                    processVoxelChunkOps(state, message);
                    break;

                case 'voxel_chunk_light':
                    processVoxelChunkLight(state, message);
                    break;

                case 'voxel_chunk_light_delta':
                    processVoxelChunkLightDelta(state, message);
                    break;

                case 'voxel_chunk_del':
                    processVoxelChunkDel(state, message);
                    break;

                case 'voxel_chunk_empty':
                    processVoxelChunkEmpty(state, message);
                    break;

                case 'room_metrics':
                    processRoomMetrics(state, message);
                    break;

                case 'debug_logs':
                    processDebugLogs(state, message);
                    break;

                case 'wire_table':
                    state.inboundTraitWireIndex = buildWireIndex(message.traits);
                    state.inboundCommandWireIndex = buildWireIndex(message.commands);
                    break;

                case 'register_model':
                    // Server-authoritative runtime model registration. The
                    // server is the canonical source of truth for which
                    // runtime models the client should know, refcount
                    // lives over there. Client gets exactly one register
                    // per id, paired with one unregister on release.
                    //
                    // serverUrl is required by the local `ResourceModel`
                    // shape but never read on the client (`side` is
                    // 'client'); stuff in clientUrl so the field exists.
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
                    if (!room) break;
                    Chat.enqueueBroadcast(room.chat, {
                        from: message.from,
                        text: message.text,
                        kind: message.kind,
                    });
                    break;
                }
            }
        }
    }

    state.net.inbox.length = 0;

    // flush voxel acks, one message per player that applied chunks this drain.
    for (const [playerId, full] of state.voxelAckBuffer) {
        if (full.length === 0) continue;
        Net.send(state.net, { type: 'voxel_ack', playerId, full });
    }
    state.voxelAckBuffer.clear();
}

function processJoinRoom(state: EngineClient, message: Protocol.JoinRoom): void {
    if (message.roomId.startsWith(Rooms.LOCAL_ROOM_PREFIX)) {
        console.error(
            `[bongle] processJoinRoom: rejecting server room id '${message.roomId}' — '${Rooms.LOCAL_ROOM_PREFIX}' prefix is reserved for client-only rooms`,
        );
        return;
    }

    // resync path: same player + room shell already exists (e.g. when the
    // server re-sends join_room for an already-joined player). repopulate
    // scene graph in place and re-fire onInit, keeps activePlayerId,
    // viewport mount, camera state, and voxel chunk meshes intact.
    const existing = state.rooms.rooms.get(message.playerId);
    if (existing && existing.roomId === message.roomId) {
        Rooms.resyncRoom(existing, message, state.inboundTraitWireIndex);
        Nodes.initSceneGraph(existing.nodes);
        Rooms.syncJoinedPlayers(state.rooms);
        return;
    }

    const room = Rooms.createRoom({
        message,
        net: state.net,
        rpc: state.rpc,
        renderer: state.renderer,
        resources: state.resources,
        modelResources: state.modelResources,
        voxelResources: state.voxelResources,
        voxelMeshResources: state.voxelMeshResources,
        spriteResources: state.spriteResources,
        extrudedSpriteResources: state.extrudedSpriteResources,
        particleResources: state.particleResources,
        cloudResources: state.cloudResources,
        shadowResources: state.shadowResources,
        audioResources: state.audioResources,
        inboundTraitWireIndex: state.inboundTraitWireIndex,
    });

    Rooms.mountRoomViewport(room);

    // populate ctx.client.state and ctx.client.room now that both exist,
    // then fire onInit hooks, order matters: hooks may access client.room
    if (room.scriptRuntime.client) {
        room.scriptRuntime.client.state = state;
        room.scriptRuntime.client.room = room;
    }
    // host-script onInit reads client.room/.state (wired above); initSceneGraph fires it.
    attachWorldTrait(room.nodes.root);
    console.log(
        `[bongle room] processJoinRoom: message.playerId=${String(message.playerId)} -> room.playerId=${String(room.playerId)} roomId=${room.roomId} playerMode=${room.playerMode}`,
    );
    Nodes.initSceneGraph(room.nodes);

    if (existing) {
        Rooms.disposeRoom(state, existing);
    }

    // add to rooms map (additive, replaces if already present). does NOT
    // auto-activate; the server emits a follow-up activate_room message
    // when this view should become the focused tab.
    state.rooms.rooms.set(message.playerId, room);
    useClient.getState().setRoom(message.playerId, room);
    Rooms.syncJoinedPlayers(state.rooms);
}

function processActivateRoom(state: EngineClient, message: Protocol.ActivateRoom): void {
    Rooms.setActivePlayer(state.rooms, state.net, state.voxelResources, message.playerId);
}

function processRoomLeft(state: EngineClient, message: Protocol.RoomLeft): void {
    // dispose room
    const leavingRoom = state.rooms.rooms.get(message.playerId);

    if (leavingRoom) {
        Rooms.disposeRoom(state, leavingRoom);
    }

    // remove the room from our state
    state.rooms.rooms.delete(message.playerId);
    useClient.getState().removeRoom(message.playerId);
    Rooms.syncJoinedPlayers(state.rooms);

    // if this was the active view, fall back to any edit-mode view we still hold
    if (state.rooms.activePlayerId === message.playerId) {
        let fallback: Rooms.ClientRoom | null = null;
        for (const room of state.rooms.rooms.values()) {
            if (room.playerMode === 'edit') {
                fallback = room;
                break;
            }
        }

        if (fallback) {
            Rooms.setActivePlayer(state.rooms, state.net, state.voxelResources, fallback.playerId);
        } else {
            state.rooms.activePlayerId = null;
            useClient.getState().setActivePlayerId(null);
        }
    }
}

function processNetMessage(state: EngineClient, message: Protocol.NetMessage): void {
    Rpc.dispatchNetMessage(state.rpc, state.inboundCommandWireIndex, message, undefined);
}

function processSceneSync(state: EngineClient, message: Protocol.SceneSync): void {
    const room = state.rooms.rooms.get(message.playerId);
    if (!room) return;
    for (const update of message.updates) {
        applySceneSyncUpdate(room.nodes, room.scriptRuntime, update, state.inboundTraitWireIndex);
    }
    if (room.playerId === state.rooms.activePlayerId) {
        room.editorStore?.getState().markDirty();
    }
}

function processRoomList(state: EngineClient, message: Protocol.RoomList): void {
    const rooms: RoomInfo[] = JSON.parse(message.rooms);
    // merge in synthetic RoomInfo entries for local rooms so they aren't
    // wiped by a server broadcast.
    Rooms.applyServerRoomList(state.rooms, rooms);
}

// the mesher reads 1-voxel borders from neighbor chunks, so when data or
// light changes at a chunk boundary, the neighbor must remesh too.

// all 26 neighbours (6 faces + 12 edges + 8 corners). the mesher's slab
// reads a 1-voxel apron from every diagonal neighbour for AO + smooth
// light, so a whole-chunk data/light replacement must remesh all 26, not
// just the 6 faces, or stale light lingers at chunk edges and corners
// until a full /relight. (the per-cell light_delta path already dirties the
// correct 3×3×3 subset; this is the full-chunk analog.)
const NEIGHBOR_OFFSETS: readonly (readonly [number, number, number])[] = /* @__PURE__ */ (() => {
    const offsets: [number, number, number][] = [];
    for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) if (dx !== 0 || dy !== 0 || dz !== 0) offsets.push([dx, dy, dz]);
    return offsets;
})();

function dirtyAllNeighborChunks(voxels: Voxels.Voxels, cx: number, cy: number, cz: number): void {
    for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
        const c = voxels.chunks.get(Voxels.chunkKey(cx + dx, cy + dy, cz + dz));
        if (c) Voxels.markChunkDirty(voxels, c);
    }
}

function processVoxelChunkFull(state: EngineClient, message: Protocol.VoxelChunkFull): void {
    const room = state.rooms.rooms.get(message.playerId);
    // no room for this player (desync), drop without acking. the server's
    // in-flight slot stays held until eviction/disconnect (or a future backstop
    // sweep); acking a chunk we didn't apply would be wrong.
    if (!room) return;
    const { data, light } = decodeChunk(message.compressed);
    const key = Voxels.chunkKey(message.cx, message.cy, message.cz);

    let chunk = room.voxels.chunks.get(key);
    if (!chunk) {
        chunk = Voxels.createChunk(message.cx, message.cy, message.cz);
        room.voxels.chunks.set(key, chunk);
        Voxels.linkChunkNeighbors(room.voxels, chunk);
    }

    chunk.data = data;
    chunk.light = light;
    chunk.paletteKeys = message.paletteKeys;
    chunk.paletteMap = new Map();
    for (let i = 0; i < message.paletteKeys.length; i++) {
        chunk.paletteMap.set(message.paletteKeys[i]!, i);
    }

    Voxels.resolveChunk(chunk, room.voxels.registry);
    // createChunk + resolveChunk both seed dirty=true; mirror into the index.
    Voxels.markChunkDirty(room.voxels, chunk);
    dirtyAllNeighborChunks(room.voxels, message.cx, message.cy, message.cz);

    // ack: we paid the decode cost, free the server's in-flight slot. batched
    // into one voxel_ack per player at the end of processInbox.
    let buf = state.voxelAckBuffer.get(message.playerId);
    if (!buf) {
        buf = [];
        state.voxelAckBuffer.set(message.playerId, buf);
    }
    buf.push({ cx: message.cx, cy: message.cy, cz: message.cz });
}

function processVoxelChunkOps(state: EngineClient, message: Protocol.VoxelChunkOps): void {
    const room = state.rooms.rooms.get(message.playerId);
    if (!room) return;
    applyVoxelChunkOps(room, message);
}

function applyVoxelChunkOps(room: Rooms.ClientRoom, message: Protocol.VoxelChunkOps): void {
    for (const entry of message.chunks) {
        const key = Voxels.chunkKey(entry.cx, entry.cy, entry.cz);
        const chunk = room.voxels.chunks.get(key);
        if (!chunk) continue;

        // protocol invariant: chunk_ops palette must be pure-append. shrink
        // or reorder silently re-aliases every already-set voxel's identity
        // → wrong-block-type drift on next remesh. server's saveVoxels uses
        // repackChunkSnapshot to compact the on-disk bytes only; live
        // chunk.paletteKeys is append-only. throw loud if that ever breaks.
        {
            const prevKeys = chunk.paletteKeys;
            const nextKeys = entry.paletteKeys;
            let kind: string | null = null;
            if (nextKeys.length < prevKeys.length) kind = 'shrunk';
            else {
                for (let i = 0; i < prevKeys.length; i++) {
                    if (prevKeys[i] !== nextKeys[i]) {
                        kind = 'reordered-or-replaced';
                        break;
                    }
                }
            }
            if (kind) {
                throw new Error(
                    `[voxel-drift][ops-palette] chunk=(${entry.cx},${entry.cy},${entry.cz}) kind=${kind}` +
                        ` prev=[${prevKeys.join('|')}] next=[${nextKeys.join('|')}]`,
                );
            }
        }

        // update palette (may have grown). resolve only newly-appended
        // runtime ids, existing entries stay valid by the append-only
        // invariant asserted above.
        const oldPaletteLen = chunk.paletteKeys.length;
        chunk.paletteKeys = entry.paletteKeys;
        chunk.paletteMap = new Map();
        for (let i = 0; i < entry.paletteKeys.length; i++) {
            chunk.paletteMap.set(entry.paletteKeys[i]!, i);
        }
        for (let i = oldPaletteLen; i < entry.paletteKeys.length; i++) {
            chunk.palette[i] = resolveKey(room.voxels.registry, entry.paletteKeys[i]!);
        }

        // COW out of the shared empty-stub data array before mutating,
        // chunks promoted from voxel_chunk_empty alias Voxels.EMPTY_DATA.
        if (chunk.data === Voxels.EMPTY_DATA) chunk.data = new Uint16Array(Voxels.EMPTY_DATA);

        // apply block data changes, track which boundary faces are touched,
        // and adjust aggregate incrementally per change (mirrors setChunkBlock).
        let faces = 0;
        for (const change of entry.changes) {
            const oldPaletteIdx = chunk.data[change.index]!;
            const newPaletteIdx = change.data;
            chunk.data[change.index] = newPaletteIdx;

            const oldId = chunk.palette[oldPaletteIdx]!;
            const newId = chunk.palette[newPaletteIdx]!;
            const wasAir = oldId === AIR || oldId === MISSING;
            const isAir = newId === AIR || newId === MISSING;
            if (wasAir && !isAir) chunk.aggregate++;
            else if (!wasAir && isAir) chunk.aggregate--;

            const x = change.index & 0xf;
            const y = change.index >> 8;
            const z = (change.index >> 4) & 0xf;
            if (x === 0) faces |= 1;
            if (x === 15) faces |= 2;
            if (y === 0) faces |= 4;
            if (y === 15) faces |= 8;
            if (z === 0) faces |= 16;
            if (z === 15) faces |= 32;
        }

        // dirty neighbor chunks whose boundary face was touched
        if (faces & 1) {
            const c = room.voxels.chunks.get(Voxels.chunkKey(entry.cx - 1, entry.cy, entry.cz));
            if (c) Voxels.markChunkDirty(room.voxels, c);
        }
        if (faces & 2) {
            const c = room.voxels.chunks.get(Voxels.chunkKey(entry.cx + 1, entry.cy, entry.cz));
            if (c) Voxels.markChunkDirty(room.voxels, c);
        }
        if (faces & 4) {
            const c = room.voxels.chunks.get(Voxels.chunkKey(entry.cx, entry.cy - 1, entry.cz));
            if (c) Voxels.markChunkDirty(room.voxels, c);
        }
        if (faces & 8) {
            const c = room.voxels.chunks.get(Voxels.chunkKey(entry.cx, entry.cy + 1, entry.cz));
            if (c) Voxels.markChunkDirty(room.voxels, c);
        }
        if (faces & 16) {
            const c = room.voxels.chunks.get(Voxels.chunkKey(entry.cx, entry.cy, entry.cz - 1));
            if (c) Voxels.markChunkDirty(room.voxels, c);
        }
        if (faces & 32) {
            const c = room.voxels.chunks.get(Voxels.chunkKey(entry.cx, entry.cy, entry.cz + 1));
            if (c) Voxels.markChunkDirty(room.voxels, c);
        }

        Voxels.markChunkDirty(room.voxels, chunk);
    }
}

function processVoxelChunkLight(state: EngineClient, message: Protocol.VoxelChunkLight): void {
    const room = state.rooms.rooms.get(message.playerId);
    if (!room) return;
    const key = Voxels.chunkKey(message.cx, message.cy, message.cz);
    const chunk = room.voxels.chunks.get(key);
    if (!chunk) return;

    chunk.light = decodeLight(message.sky, message.rgb);

    Voxels.markChunkDirty(room.voxels, chunk);
    dirtyAllNeighborChunks(room.voxels, message.cx, message.cy, message.cz);
}

// scratch mask for the 3×3×3 neighbour cells around a chunk.
// indexed as (dz+1)*9 + (dy+1)*3 + (dx+1). reused across chunks in
// the delta loop to avoid per-chunk allocation.
const _neighbourCellMask = new Uint8Array(27);

function processVoxelChunkLightDelta(state: EngineClient, message: Protocol.VoxelChunkLightDelta): void {
    const room = state.rooms.rooms.get(message.playerId);
    if (!room) return;
    const key = Voxels.chunkKey(message.cx, message.cy, message.cz);
    const chunk = room.voxels.chunks.get(key);
    if (!chunk) return;

    _neighbourCellMask.fill(0);

    for (const change of message.changes) {
        chunk.light[change.index] = change.light;

        // decompose index → local (x,y,z), then OR each axis span
        // into the 27-cell mask. boundary voxels contribute 2 cells
        // per boundary axis (their own + the neighbour across).
        const idx = change.index;
        const x = idx & 0xf;
        const z = (idx >> 4) & 0xf;
        const y = idx >> 8;

        const dxLo = x === 0 ? -1 : 0;
        const dxHi = x === 15 ? 1 : 0;
        const dyLo = y === 0 ? -1 : 0;
        const dyHi = y === 15 ? 1 : 0;
        const dzLo = z === 0 ? -1 : 0;
        const dzHi = z === 15 ? 1 : 0;

        for (let dz = dzLo; dz <= dzHi; dz++) {
            for (let dy = dyLo; dy <= dyHi; dy++) {
                for (let dx = dxLo; dx <= dxHi; dx++) {
                    _neighbourCellMask[(dz + 1) * 9 + (dy + 1) * 3 + (dx + 1)] = 1;
                }
            }
        }
    }

    Voxels.markChunkDirty(room.voxels, chunk);

    // dirty all set cells in the 3×3×3 mask, skipping self (1,1,1 → 13).
    for (let i = 0; i < 27; i++) {
        if (i === 13) continue;
        if (_neighbourCellMask[i] === 0) continue;
        const dx = (i % 3) - 1;
        const dy = (((i / 3) | 0) % 3) - 1;
        const dz = ((i / 9) | 0) - 1;
        const nc = room.voxels.chunks.get(Voxels.chunkKey(message.cx + dx, message.cy + dy, message.cz + dz));
        if (nc) Voxels.markChunkDirty(room.voxels, nc);
    }
}

function processVoxelChunkDel(state: EngineClient, message: Protocol.VoxelChunkDel): void {
    const room = state.rooms.rooms.get(message.playerId);
    if (!room) return;
    const key = Voxels.chunkKey(message.cx, message.cy, message.cz);
    const chunk = room.voxels.chunks.get(key);
    if (chunk) {
        Voxels.unlinkChunkNeighbors(chunk);
        room.voxels.dirty.blocks.delete(chunk);
    }
    room.voxels.chunks.delete(key);
    if (room === Rooms.getActiveRoom(state.rooms)) {
        VoxelVisuals.removeChunkMesh(state.voxelResources, key);
    }
}

function processVoxelChunkEmpty(state: EngineClient, message: Protocol.VoxelChunkEmpty): void {
    const room = state.rooms.rooms.get(message.playerId);
    if (!room) return;
    for (const c of message.chunks) {
        const key = Voxels.chunkKey(c.cx, c.cy, c.cz);
        // a real chunk already present (full upgrade arrived first), leave it.
        if (room.voxels.chunks.has(key)) continue;
        const chunk = Voxels.createEmptyChunk(c.cx, c.cy, c.cz);
        room.voxels.chunks.set(key, chunk);
        Voxels.linkChunkNeighbors(room.voxels, chunk);
    }
}

function processRoomMetrics(state: EngineClient, message: Protocol.RoomMetrics): void {
    // protocol ships value-only; infer the unit from the id so the panel
    // labels server-pushed kb/s metrics correctly. extend the prefix table
    // if the server starts emitting non-ms / non-net metrics.
    for (const room of Rooms.getRoomsByRoomId(state.rooms, message.roomId)) {
        for (const [id, value] of Object.entries(message.values)) {
            const unit = id.startsWith('net/') ? 'kb/s' : 'ms';
            Debug.record(room.serverMetrics, id, value as number, unit);
        }
    }
}

/**
 * record per-message-type net metrics + aggregate game/total rates.
 *
 * `net/in/<type>` / `net/out/<type>`, per-type kb/s (lets the breakdown
 *      widget enumerate by id prefix).
 * `net/ingress` / `net/egress`, "game" headline (every type EXCEPT those
 *      in DEBUG_MESSAGE_TYPES). this is what the summary widget reads, so
 *      opening the debug panel doesn't pollute its own metric.
 * `net/in/total` / `net/out/total`, true totals (includes debug bytes).
 */
function recordNetStats(metrics: Debug.Metrics, stats: Net.NetStats, delta: number): void {
    let inGame = 0;
    let outGame = 0;
    for (const [type, bytes] of stats.bytesInByType) {
        const kbps = bytes / 1024 / delta;
        Debug.record(metrics, `net/in/${type}`, kbps, 'kb/s');
        if (!Protocol.DEBUG_MESSAGE_TYPES.has(type)) inGame += bytes;
    }
    for (const [type, bytes] of stats.bytesOutByType) {
        const kbps = bytes / 1024 / delta;
        Debug.record(metrics, `net/out/${type}`, kbps, 'kb/s');
        if (!Protocol.DEBUG_MESSAGE_TYPES.has(type)) outGame += bytes;
    }
    Debug.record(metrics, 'net/ingress', inGame / 1024 / delta, 'kb/s');
    Debug.record(metrics, 'net/egress', outGame / 1024 / delta, 'kb/s');
    Debug.record(metrics, 'net/in/total', stats.bytesIn / 1024 / delta, 'kb/s');
    Debug.record(metrics, 'net/out/total', stats.bytesOut / 1024 / delta, 'kb/s');
}

function processDebugLogs(state: EngineClient, message: Protocol.DebugLogs): void {
    for (const room of Rooms.getRoomsByRoomId(state.rooms, message.roomId)) {
        if (message.dropped > 0) {
            Debug.pushLog(room.serverLogs, {
                ts: Date.now(),
                level: 'warn',
                msg: `… ${message.dropped} server log entries dropped (buffer overflow)`,
                source: undefined,
            });
        }
        for (const entry of message.entries) {
            Debug.pushLog(room.serverLogs, entry);
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
    const handle = registry.scenes.byId.get(id)?.payload;
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
    const handle = registry.scenes.byId.get(id)?.payload;
    if (handle) handle._payload = null;
    Content.clearScene(state.content, id, 'client');
    Registry.touch(registry.scenes, id);
}

/** clamp on inbound dt, guards against huge spikes after tab refocus,
 *  long GC pauses, or debugger breaks. 0.2s ≈ 5fps floor: anything slower
 *  ticks as if the simulation ran at 5fps for that frame, instead of
 *  letting physics/animation integrators see a runaway delta. */
const MAX_DELTA_S = 0.2;

export function update(state: EngineClient, delta: number) {
    // one inbound dt, used two ways: clamped for integrators (physics/animation) so a
    // stall can't produce a runaway step; raw for `wall` (the smooth render clock +
    // server-clock sync), which must keep TRUE elapsed time and not lose it to the clamp.
    const wallDelta = delta;
    if (delta > MAX_DELTA_S) delta = MAX_DELTA_S;
    Debug.begin(state.metrics, 'tick');

    // advance each room's render clock up front (raw delta) so message receipt
    // (processInbox) and the per-frame reads below share one coherent `now`.
    for (const room of state.rooms.rooms.values()) Clock.advanceWall(room.clock, wallDelta);

    /* process inbox */
    processInbox(state);

    // reconcile audio output mute with ad state, the game is silenced while a
    // portal ad shows (flag set by api/platform). cheap: setOutputMuted no-ops
    // unless the value changed.
    if (state.audioResources) Audio.setOutputMuted(state.audioResources, state.adActive);

    const activeRoom = Rooms.getActiveRoom(state.rooms);

    // per-frame input pre-processing, runs before runOnUpdate so consumers
    // (e.g. editor grab-rotate) can zero mk._dx/_dy before player
    // controllers read input for camera/look. only the active room receives
    // input, its canvas is the only one mounted as `display: block`.
    if (activeRoom) {
        Debug.begin(activeRoom.clientMetrics, 'on-input');
        Nodes.runOnInput(activeRoom.nodes, { delta }, activeRoom.clientMetrics);
        Debug.end(activeRoom.clientMetrics, 'on-input');
    }

    // per-frame update, input polling, camera binding, etc. every room gets
    // a per-frame pass; inactive rooms continue advancing scripts/animations.
    for (const room of state.rooms.rooms.values()) {
        // slew `server` toward the latest server-clock push, before onFrame reads
        // it. no-op until the first push lands (and on local rooms, which get none),
        // where `server` rides the join seed via the fixed tick (see core/clock).
        // `wall` (advanced up front this frame) is the local base: real elapsed,
        // clamp-immune, and the same base processInbox stamped arrivals with.
        Clock.syncServer(room.clock, room.clock.wall, delta);

        Debug.begin(room.clientMetrics, 'on-update');
        Nodes.runOnUpdate(room.nodes, { delta }, room.clientMetrics);
        Debug.end(room.clientMetrics, 'on-update');
        // particles are visual fx, framerate-dependent motion is fine, and
        // running per-frame (not per fixed-step) avoids the spawn→render
        // delay you'd get from waiting for the next tick before integrating.
        Debug.begin(room.clientMetrics, 'particles-tick');
        Particles.update(room.particles, delta, performance.now() / 1000, room.voxels);
        Debug.end(room.clientMetrics, 'particles-tick');
    }

    // fixed update, single global accumulator drives lockstep across rooms
    state.accumulator += delta;
    const timestep = 1 / 60;

    while (state.accumulator >= timestep) {
        for (const room of state.rooms.rooms.values()) {
            Debug.begin(room.clientMetrics, 'room');

            Clock.tick(room.clock, timestep);

            Interpolation.snapshot(room.interpolation);

            Nodes.runOnTick(room.nodes, { delta: timestep }, room.clientMetrics);

            // tick prefab system, discovers and re-instantiates stale prefab nodes
            Prefab.tick(room.nodes, room.scriptRuntime, state.resources, room.voxels, 'client');

            Debug.begin(room.clientMetrics, 'physics');
            Physics.preStep(room.physics, room.nodes, state.resources, room.playerId, room.playerMode === 'play');
            Physics.tick(room.physics, room.nodes, timestep);
            Physics.postStep(room.physics, room.nodes, room.playerId);
            // release per-tick physics scratch (voxel hit pool). contact
            // listeners + getSurfaceNormal / getSupportingFace consumers all
            // resolve their subShapeIds within tick/postStep.
            Physics.flush(room.physics);
            Debug.end(room.clientMetrics, 'physics');

            Replication.sendOwnerSyncUpdates(state.net, room.nodes, room.roomId, room.playerId, room.syncSnapshots);

            Debug.end(room.clientMetrics, 'room');
        }

        state.accumulator -= timestep;
    }

    const alpha = state.accumulator / timestep;

    // sync client-global model GPU pools with newly-ready / vanished payloads
    ModelResources.update(state.modelResources, state.resources);

    // tier settings, fetch once per tick, threaded to every subsystem
    // that takes a tier-driven cap (cull radius, mesher caps, ...). reads
    // through profile.active so a runtime tier flip applies next tick.
    const perfSettings = Performance.settingsForTier(state.performance);

    // per-room interpolate, frame hooks, visual update, every room
    // advances even when not active; inactive viewports are display:none
    // but their scenes stay live for fast tab swaps. only the active
    // room runs the voxel mesher (engine-global arenas hold one room's
    // chunks at a time); on swap, the new active room's chunks cycle
    // back in via the prioritised remesh path over the next few frames.
    for (const room of state.rooms.rooms.values()) {
        // interpolate replicated transforms first so rig roots are at their
        // visual position for the frame (animator writes to child bones, not
        // rig roots, so visibility only needs roots, not bones, settled).
        Debug.begin(room.clientMetrics, 'interpolate');
        Interpolation.interpolate(room.interpolation, alpha, delta);
        Debug.end(room.clientMetrics, 'interpolate');

        // user frame scripts (camera follow, local player motion, etc.) run
        // on settled visual transforms.
        Debug.begin(room.clientMetrics, 'on-frame');
        Nodes.runOnFrame(room.nodes, { delta }, room.clientMetrics);
        Debug.end(room.clientMetrics, 'on-frame');

        // drain chat inbox/outbox: inbox payloads append to room.chat.lines +
        // fan out to messageListeners; outbox lines flush as `chat_input`
        // protocol messages.
        Chat.tick(room.chat, state.net, room.roomId);

        // resolve the active POV camera (POV node's CameraTrait) and
        // bind it to the renderer. pulls viewport aspect from canvasTarget,
        // writes it back into the POV camera (gated on aspect change),
        // then reassigns the scene pass camera so the next render reads it
        // directly. must run AFTER user frame scripts (they write pose/fov
        // on the POV camera) and BEFORE any consumer that reads it.
        const povCamera = Rooms.getRenderCamera(room);
        Renderer.bindRenderCamera(state.renderer.pipeline, room.canvasTarget);
        if (!povCamera) continue;

        // per-mesh frustum cull with the fresh camera. Refits each renderable
        // cull entry from this frame's transforms and writes `cull.visible`,
        // read downstream by Animation.tick (per-rig gate, folding its
        // meshes), ModelLighting.update (per-model light-sample gate), and the
        // mesh/sprite/voxel renderers (per-instance upload gate). Runs before
        // Animation.tick: the meshes' transforms reflect last frame's pose,
        // which the fat-AABB margin absorbs.
        // shared view radius across the chunk mesher (cullCPU) and frustum
        // cull, same Euclidean sphere so a sprite/rig fades at the same
        // boundary the chunks it sits on do.
        Debug.begin(room.clientMetrics, 'visibility');
        Visibility.update(room.visibility, povCamera, perfSettings.voxelViewChunkRadius * Voxels.CHUNK_SIZE);
        Debug.end(room.clientMetrics, 'visibility');

        // sample voxel light at each visible model's world-space AABB
        // centroid into `ModelTrait.light`. one sample per rig (not per
        // mesh) so limbs that clip into solid voxels mid-animation don't
        // pop dark, the centroid is inside the model's body by
        // construction.
        Debug.begin(room.clientMetrics, 'modelLighting');
        ModelLighting.update(room.modelLighting, room.voxels);
        Debug.end(room.clientMetrics, 'modelLighting');

        // sample animations at render rate with the real frame delta, bones
        // step smoothly at any fps. animation writes to bone locals via
        // setPosition/setQuaternion, marking them dirty. gated per-rig on
        // the fresh `aabb.visible` from Visibility above.
        Debug.begin(room.clientMetrics, 'animation');
        Animation.tick(room.animations, state.resources, delta);
        Debug.end(room.clientMetrics, 'animation');

        // post-animation hooks: procedural overrides (head-look, springs, etc.)
        // run after animator sampling, before downstream consumers read world matrices.
        Debug.begin(room.clientMetrics, 'on-post-animate');
        Nodes.runOnPostAnimate(room.nodes, { delta }, room.clientMetrics);
        Debug.end(room.clientMetrics, 'on-post-animate');

        // engine-global voxel arenas hold only the active room's chunks
        // at any one time. inactive rooms skip the mesher/relight pass +
        // arena-occupancy metrics here; their chunks cycle back in via
        // the prioritised remesh path on the next activation.
        if (room === activeRoom) {
            Debug.begin(room.clientMetrics, 'mesh');
            VoxelVisuals.update(
                room.voxelVisuals,
                state.voxelResources,
                room.voxels,
                room.voxels.registry,
                povCamera.position,
                perfSettings.voxelMainThreadRemeshBudget,
            );
            Debug.end(room.clientMetrics, 'mesh');

            // arena occupancy + fragmentation, recorded post-update so the
            // sample reflects this frame's allocs. usedPct is overall pressure;
            // largestFreePct surfaces fragmentation (low while usedPct is moderate
            // = TLSF carving up the heap); allocs vs the tier's maxAllocs cap
            // tracks node-pool headroom.
            if (room.clientMetrics.enabled) {
                const quadR = VoxelResources.arenaReport(state.voxelResources.arenas.quadArena);
                const orderR = VoxelResources.arenaReport(state.voxelResources.arenas.quadOrderArena);
                Debug.record(room.clientMetrics, 'voxels/arena/quad/usedPct', (100 * quadR.used) / quadR.slotCount, '%');
                Debug.record(
                    room.clientMetrics,
                    'voxels/arena/quad/largestFreePct',
                    (100 * quadR.largestFree) / quadR.slotCount,
                    '%',
                );
                Debug.record(room.clientMetrics, 'voxels/arena/quad/allocs', quadR.allocs, 'count');
                Debug.record(room.clientMetrics, 'voxels/arena/order/usedPct', (100 * orderR.used) / orderR.slotCount, '%');
                Debug.record(
                    room.clientMetrics,
                    'voxels/arena/order/largestFreePct',
                    (100 * orderR.largestFree) / orderR.slotCount,
                    '%',
                );
                Debug.record(room.clientMetrics, 'voxels/arena/order/allocs', orderR.allocs, 'count');
            }
        }

        Debug.begin(room.clientMetrics, 'voxel-mesh');
        VoxelMeshVisuals.update(room.voxelMeshVisuals, room.voxels, room.visibility);
        Debug.end(room.clientMetrics, 'voxel-mesh');

        Debug.begin(room.clientMetrics, 'model');
        ModelVisuals.update(room.modelVisuals, state.modelResources, state.resources, room.visibility);
        Debug.end(room.clientMetrics, 'model');

        Debug.begin(room.clientMetrics, 'dom-ui');
        DomUi.update(room.domUi, povCamera, state.viewport);
        Debug.end(room.clientMetrics, 'dom-ui');

        Debug.begin(room.clientMetrics, 'sprite');
        SpriteVisuals.update(room.spriteVisuals, state.spriteResources, room.voxels, povCamera, room.visibility);
        Debug.end(room.clientMetrics, 'sprite');

        Debug.begin(room.clientMetrics, 'extruded-sprite');
        ExtrudedSpriteVisuals.update(room.extrudedSpriteVisuals, state.extrudedSpriteResources, room.voxels, room.visibility);
        Debug.end(room.clientMetrics, 'extruded-sprite');

        Debug.begin(room.clientMetrics, 'shadow');
        ShadowVisuals.update(room.shadowVisuals, room.voxels, povCamera);
        Debug.end(room.clientMetrics, 'shadow');

        // particle visuals reads pool[0..count) directly, no scene-graph
        // traits. runs after `Particles.update` (per-frame loop above) so
        // freshly-stepped positions feed this frame's pose buffer.
        Debug.begin(room.clientMetrics, 'particle');
        ParticleVisuals.update(room.particleVisuals, room.particles, room.voxels, performance.now() / 1000);
        Debug.end(room.clientMetrics, 'particle');

        // refresh listener pose + node-bound panners, reap finished
        // one-shots.
        Debug.begin(room.clientMetrics, 'audio');
        Audio.updateForFrame(room.audio, room);
        Debug.end(room.clientMetrics, 'audio');
    }

    /* render, only the active room renders to the GPU each frame */
    if (activeRoom) {
        // TODO: be smarter :)
        activeRoom.scene.updateWorldMatrix();

        const activeCamera = Rooms.getRenderCamera(activeRoom);

        Debug.begin(activeRoom.clientMetrics, 'render');
        Renderer.render(state.renderer, activeRoom, activeCamera, state.voxelResources, perfSettings.voxelViewChunkRadius);
        Debug.end(activeRoom.clientMetrics, 'render');

        /* metrics, request server-side stats for every room the client
         * holds, not just the active one. each room maintains its own
         * server-side metrics history; the response is dispatched into
         * each ClientRoom.serverMetrics by roomId. de-dup roomIds since
         * a single client may hold multiple Players in the same room. */
        // debug network traffic is editor-only, player builds never request
        // server metrics or subscribe to server logs.
        const { debugOpen, debugTab } = useClient.getState();

        // gpucat Inspector overlay, visible only on the 'renderer' tab while
        // the panel is open. available in non-editor builds too (debug perf
        // for shipped games).
        Renderer.setInspectorVisible(state.renderer, debugOpen && debugTab === 'renderer');

        if (env.editor) {
            if (debugOpen && (debugTab === 'summary' || debugTab === 'perf' || debugTab === 'net' || debugTab === 'logs')) {
                const seen = new Set<string>();
                for (const room of state.rooms.rooms.values()) {
                    if (seen.has(room.roomId)) continue;
                    if (room.local) continue; // local rooms have no server peer
                    seen.add(room.roomId);
                    Net.send(state.net, { type: 'request_metrics', roomId: room.roomId });
                }
            }

            /* log subscription: flat per-client bit. server pushes
             * `debug_logs` for every room we hold a Player in while enabled.
             * only active in the logs view, perf view doesn't render logs. */
            const subscribeLogs = debugOpen && debugTab === 'logs';
            if (subscribeLogs !== state.debugLogsSubscribed) {
                Net.send(state.net, { type: 'debug_subscribe', enabled: subscribeLogs });
                state.debugLogsSubscribed = subscribeLogs;
            }
        }

        const netStats = Net.drainNetStats(state.net);

        if (delta > 0) {
            recordNetStats(activeRoom.clientMetrics, netStats, delta);
        }
    }

    /* reset per-room input, snapshots prev and clears per-frame deltas.
       inactive rooms received no events, so their reset is a no-op (zero
       state stays zero). */
    for (const room of state.rooms.rooms.values()) {
        Input.resetInput(room.input);
    }

    /* derive pointer-lock from the active room's intent + UI/touch/focus. release
       runs here every frame; acquire only fires from user-gesture handlers. */
    Input.reconcilePointerLock(state.inputManager);

    /* flush outbox */
    Net.flush(state.net);

    Debug.end(state.metrics, 'tick');
}

/* ── dispose ── */

export function dispose(state: EngineClient): void {
    for (const room of state.rooms.rooms.values()) {
        Rooms.disposeRoom(state, room);
    }
    state.rooms.rooms.clear();
    state.rooms.activePlayerId = null;
    useClient.setState({ rooms: new Map(), activePlayerId: null, inputManager: null });

    if (state.inputManager) Input.disposeInputManager(state.inputManager);
    if (state.shadowResources) ShadowResources.dispose(state.shadowResources);
    if (state.cloudResources) CloudResources.dispose(state.cloudResources);
    if (state.voxelMeshResources) VoxelMeshResources.dispose(state.voxelMeshResources);
    if (state.voxelResources) VoxelResources.dispose(state.voxelResources);
    if (state.particleResources) ParticleResources.dispose(state.particleResources);
    if (state.extrudedSpriteResources) ExtrudedSpriteResources.dispose(state.extrudedSpriteResources);
    if (state.spriteResources) SpriteResources.dispose(state.spriteResources);
    Renderer.dispose(state.renderer);
    state.domElement?.remove();
}
