import { type PerspectiveCamera, Scene } from 'gpucat';
import { mat4, quat } from 'math';
import { ENVIRONMENT_DEFAULT } from '../api/environment';
import { CameraTrait } from '../builtins/camera';
import { PlayerTrait } from '../builtins/player';
import { addPlayerTraits } from '../builtins/player-node';
import { setWorldPosition, setWorldQuaternion, TransformTrait } from '../builtins/transform';
import { attachWorldTrait } from '../builtins/world';
import { acquireAvatarModel, assignAvatar } from '../core/avatar/model';
import type { PlayerId } from '../core/client';
import * as Clock from '../core/clock';
import * as Debug from '../core/debug';
import * as Physics from '../core/physics/physics';
import type * as Protocol from '../core/protocol';
import type { PlayerMode, RoomInfo, RoomMode } from '../core/protocol';
import { type InboundProtocol, registry } from '../core/registry';
import type { Resources } from '../core/resources';
import * as Animation from '../core/scene/animation';
import { applySceneSyncUpdate, unpackSceneTree } from '../core/scene/scene-pack';
import * as SceneTree from '../core/scene/scene-tree';
import type { ClientContext, RenderScenes, SceneTreeContext } from '../core/scene/scripts';
import { fireJoinHooks, fireLeaveHooks } from '../core/scene/scripts';
import * as Voxels from '../core/voxels/voxels';
import * as RenderCamera from '../render/camera';
import type * as CloudResourcesNs from '../render/environment/clouds/cloud-resources';
import * as Environment from '../render/environment/environment';
import type * as MeshResourcesNs from '../render/mesh/mesh-resources';
import * as MeshVisuals from '../render/mesh/mesh-visuals';
import * as ModelLighting from '../render/model-lighting';
import type { OfflineRenderer } from '../render/offline';
import * as Particles from '../render/particles/particles';
import * as Visibility from '../render/visibility/visibility';
import type * as VoxelMeshResources from '../render/voxels/voxel-mesh-resources';
import * as VoxelMeshVisuals from '../render/voxels/voxel-mesh-visuals';
import type * as VoxelResourcesCpuNs from '../render/voxels/voxel-resources-cpu';
import type * as VoxelResourcesNs from '../render/voxels/voxel-resources-gpu';
import * as VoxelVisuals from '../render/voxels/voxel-visuals';
import * as Audio from './audio/audio';
import type { ChatClient } from './chat';
import * as Chat from './chat';
import type { EngineClient } from './client';
import * as ClientEnv from './environment';
import * as Input from './input';
import * as Net from './net';
import * as Performance from './performance';
import * as Replication from './replication';
import { clientDebug } from './ui/dashboard';
import { useClient } from './ui/stores/client-store';
import { UILayer } from './ui/util/ui-layers';

/* ── ClientRoom ─────────────────────────────────────────────────── */

export type { PlayerId };

export type ClientRoom = {
    /** server-allocated Player id this ClientRoom represents */
    playerId: PlayerId;

    /** the room id */
    roomId: string;

    /** the scene id */
    sceneId: string;

    /** the Player's mode in the room (immutable). */
    playerMode: PlayerMode;

    /** the room's native mode (immutable). may differ from playerMode (e.g.
     *  an edit Player attached to a play room). */
    roomMode: RoomMode;

    /** namespace this room belongs to (mirrors server-side) */
    namespace: string;

    /**
     * true if this room is a client-only room created via `rooms.create`
     * from a client ScriptContext. local rooms have synthetic playerId/roomId
     * (roomId prefixed with `local:`), no server backing, and never emit
     * `set_active_room` pings on activation.
     */
    local: boolean;

    /** scene graph */
    scene: SceneTree.SceneTree;

    /** the gpucat render scenes (main + overlay) for this room */
    render: RenderScenes;

    /** the scripting runtime for this room */
    context: SceneTreeContext;

    /** snapshot of the last scene graph state we sent to the server, for replication diffing. */
    syncSnapshots: ReturnType<typeof Replication.createSyncSnapshots>;

    /** per-room voxel data. always present (may be empty). */
    voxels: Voxels.Voxels;

    /** per-room physics world. always present. */
    physics: Physics.Physics;

    /** per-room game clock (monotonic seconds). advanced by engine-client's
     *  fixed-tick loop; pauses when no tick fires. read via `ctx.clock.time`. */
    clock: Clock.Clock;

    /** per-room client-side chat: command registry, line buffer, UI
     *  subscribers, inbox/outbox queues. drained each frame by Chat.tick. */
    chat: ChatClient;

    /** per-room sky + sun/moon/stars/clouds. holds a CPU shadow of the env
     *  config; `setTime`/`setEnvironment` mutate it without touching GPU.
     *  the active room's shadow flushes into the engine-global env buffers
     *  each frame (see `Environment.updateForCamera`), so background rooms
     *  can keep mutating their state with zero GPU traffic. */
    environment: ClientEnv.Environment;

    /** per-room audio coordinator. backed by engine-global
     *  `AudioResources` (one decoded atlas across rooms), but each room
     *  owns its own master gain + active-playback set so per-room
     *  cleanup on disposeRoom is structural. */
    audio: Audio.Audio;

    /** the owned player node, cached at join time. */
    playerNode: SceneTree.Node;

    /**
     * default per-room camera node. created at room init with TransformTrait
     * + CameraTrait, parented at the scene root. the initial value of the
     * active camera pointer (`client.camera`) and the no-controller baseline;
     * controllers write pose to whichever node `client.camera` points at, and
     * bespoke setups repoint it via `setCamera(ctx, node)`.
     */
    cameraNode: SceneTree.Node;

    /**
     * this room's client state, the single mutable ClientContext every script
     * in the room sees as `ctx.client` (same object as `context.client`).
     * room-layer code reads the live POV / active camera / defaults off it
     * (`room.client.subject`, `room.client.camera`); scripts swap them via
     * `setSubject` / `setCamera`. no boxing, no duplicated pointers, one object.
     */
    client: ClientContext;

    /** locally measured client-side metrics (tick, mesh, physics, net) */
    clientMetrics: Debug.Metrics;

    /** server-side metrics received via room_metrics messages */
    serverMetrics: Debug.Metrics;

    /** client-side log buffer, `log(ctx, ...)` calls in client scripts land here. */
    clientLogs: Debug.Logs;

    /** server-side log buffer, fed by `debug_logs` packets while subscribed. */
    serverLogs: Debug.Logs;

    // GPU visuals (voxel / voxel-mesh / model / sprite / extruded-sprite / shadow
    // / particle / domUi) are owned by the render backend and exist only for the
    // ACTIVE room, in `state.active` (see render/webgpu/room-visuals). Non-active
    // rooms still simulate; they just hold no visual bundle.

    /** per-room particle pool. fixed capacity; spawn fills slots,
     *  `Particles.update` compacts dead ones. advanced per-frame (variable
     *  `delta`) with the room's `voxels` ref so collision primitives can
     *  query the grid. particles are visual fx, framerate-dependent
     *  motion is acceptable; the fixed-step loop is reserved for
     *  simulation that must stay deterministic. */
    particles: Particles.ParticlePool;

    /** per-room visibility (DBVT + frustum cull). mesh-visuals + voxel-visuals
     *  register leaves and read the per-frame visible set. */
    visibility: Visibility.Visibility;

    /** per-room model lighting, samples voxel light at each visible model's
     *  world-space AABB centroid and writes it into `ModelTrait.light`. Runs
     *  after `Visibility.update` so off-screen models skip the sample. */
    modelLighting: ModelLighting.ModelLighting;

    /** per-room animation state, caches the [AnimatorTrait] query consumed by
     *  `Animation.tick`. */
    animations: Animation.Animations;

    /** per-room input data (keys, mouse, deltas). DOM events are routed
     *  here only when this room is active, see `setActivePlayer`. */
    input: Input.Input;

    /**
     * per-room viewport div, holding this room's HTML overlays. mounted
     * into the global viewport div alongside other rooms, above the single shared
     * render canvas (a backdrop sibling); only the active room's viewport is
     * `display: block`. removed wholesale on dispose, so overlays don't outlive
     * their room. The 3D render surface is NOT here — it's the one shared canvas.
     */
    viewport: HTMLDivElement;

    /**
     * per-room touch overlay div under `viewport`, mounted after the html UI
     * overlay so it stacks above by DOM order. touch controls helpers append their
     * joystick / button roots here. removed with the viewport on dispose.
     */
    touchOverlay: HTMLDivElement;
};

/* ── Rooms registry ─────────────────────────────────────────────── */

export type Rooms = {
    /** all Players the client holds, keyed by PlayerId. */
    rooms: Map<PlayerId, ClientRoom>;
    /** which Player is currently rendered/interacted with */
    activePlayerId: PlayerId | null;
    /** monotonic counter for synthesizing local-room ids and player ids */
    nextLocalId: number;
};

export function init(): Rooms {
    return {
        rooms: new Map(),
        activePlayerId: null,
        nextLocalId: 0,
    };
}

/* ── headless render room ───────────────────────────────────────── */

/** synthetic player id for a headless render room. interpolation needs one, but
 *  no node is owned by it, so every node interpolates uniformly — fine for a
 *  static offscreen frame. */
export const RENDER_ROOM_PLAYER_ID = -1 as PlayerId;

/**
 * A client-only room with the simulation core (`newRoomCore`) + render visuals
 * but NO presentation — no canvas, viewport, input, dom-ui, audio, or camera
 * node. It exists only to be rendered offscreen into a `RenderTarget` at its own
 * arena index (its chunks coexist with the world's). Both block and prefab icon
 * renders build one, populate it, `WebGpu.renderRoomToTarget`, then
 * `disposeRenderRoom`. Not registered in `state.rooms` — it never ticks with the
 * live rooms.
 */
export type RenderRoom = {
    scene: SceneTree.SceneTree;
    voxels: Voxels.Voxels;
    physics: Physics.Physics;
    clock: Clock.Clock;
    context: SceneTreeContext;
    /** the gpucat render scene (headless — no overlay pass) */
    render: { scene: Scene };
    voxelVisuals: VoxelVisuals.VoxelVisuals;
    voxelMeshVisuals: VoxelMeshVisuals.VoxelMeshVisuals;
    modelVisuals: MeshVisuals.MeshVisuals;
    visibility: Visibility.Visibility;
    /** client-side env config (CPU). */
    environment: ClientEnv.Environment;
    /** env render state (sky/cloud meshes) — this offline room owns it directly
     *  (no backend `createRoomVisuals` in the icon path). */
    envVisuals: Environment.EnvVisuals;
};

/** Everything `createRenderRoom` needs, decoupled from `EngineClient` so a
 *  headless pipeline-worker engine can build render rooms for offscreen icon
 *  renders. The arena is single-world, so a render room owns it for its lifetime. */
export type RenderRoomDeps = {
    resources: Resources;
    rpc: SceneTreeContext['rpc'];
    /** engine-global env GPU buffers the offline renderer flushes into (neutral
     *  render type, was reached via the backend state). */
    environmentResources: Environment.EnvironmentResources;
    /** the headless render backend handle — pipeline/render/readback ops. */
    offline: OfflineRenderer;
    /** gpu (WebGPU compute producer) or cpu (WebGL cullEmit producer); the offline
     *  backend that built these deps knows which. Bakers touch only the shared
     *  surface (textures / arenas); each backend narrows in renderToTarget. */
    voxelResources: VoxelResourcesNs.VoxelResources | VoxelResourcesCpuNs.VoxelResources;
    voxelMeshResources: VoxelMeshResources.VoxelMeshResources;
    modelResources: MeshResourcesNs.MeshResources;
    cloudResources: CloudResourcesNs.CloudResources;
};

export function createRenderRoom(deps: RenderRoomDeps): RenderRoom {
    const { nodes, voxels, physics, clock, context } = newRoomCore({
        resources: deps.resources,
        rpc: deps.rpc,
        roomId: `${LOCAL_ROOM_PREFIX}render`,
        playerMode: 'play',
        roomMode: 'play',
        authority: false,
    });
    // no behaviour: the tree keeps no context, so addTrait / registerSubtree never
    // instantiate scripts, and no WorldTrait means no systems. An icon shows only
    // what a prefab's apply places up front (MeshTrait, voxels); anything a script
    // or system assembles later is not rendered. `context` still reaches Prefab.tick
    // by argument for its roomMode read.

    const scene = new Scene();
    const envResources = deps.environmentResources;
    const voxelVisuals = VoxelVisuals.initRoomMeshes(scene, deps.voxelResources.geometries, deps.voxelResources.quadMaterials);
    const voxelMeshVisuals = VoxelMeshVisuals.init(deps.voxelMeshResources.batch, scene, nodes);
    const modelVisuals = MeshVisuals.init(deps.modelResources.batch, scene, nodes);
    const visibility = Visibility.init();
    const environment = ClientEnv.createEnvironment(ENVIRONMENT_DEFAULT);
    const envVisuals = Environment.initEnvVisuals(scene, envResources, deps.cloudResources);

    return {
        scene: nodes,
        voxels,
        physics,
        clock,
        context: context,
        render: { scene },
        voxelVisuals,
        voxelMeshVisuals,
        modelVisuals,
        visibility,
        environment,
        envVisuals,
    };
}

export function disposeRenderRoom(deps: RenderRoomDeps, room: RenderRoom): void {
    deps.offline.unmountRoom(deps);
    Physics.dispose(room.physics);
    VoxelVisuals.dispose(room.voxelVisuals, room.render.scene);
    VoxelMeshVisuals.dispose(room.voxelMeshVisuals, deps.voxelMeshResources.batch, room.visibility);
    MeshVisuals.dispose(room.modelVisuals, deps.modelResources.batch, room.visibility);
    Environment.disposeEnvVisuals(room.envVisuals);
}

/** prefix used for synthetic local-room ids, server roomIds never collide with this. */
export const LOCAL_ROOM_PREFIX = 'local:';

/* ── RoomInfo for local rooms ───────────────────────────────────── */

/**
 * Synthesize a `RoomInfo` for a local-only ClientRoom. Local rooms never
 * appear in server room_list messages, so we manufacture their info from
 * the ClientRoom itself and merge it into `useClient.roomList` at the
 * startLocalRoom/stopLocalRoom edges, making local + server-driven rooms
 * indistinguishable to downstream consumers (tabs, debug, etc.).
 */
function makeLocalRoomInfo(room: ClientRoom): RoomInfo {
    return {
        id: room.roomId,
        sceneId: room.sceneId,
        roomMode: room.roomMode,
        clientCount: 1,
        sourceRoomId: null,
        namespace: room.namespace,
    };
}

/**
 * Apply a server-broadcast room list while preserving entries for local
 * rooms (those without server backing). Called by engine-client when a
 * `room_list` message arrives.
 */
export function applyServerRoomList(state: Rooms, serverRooms: RoomInfo[]): void {
    const merged = [...serverRooms];
    for (const room of state.rooms.values()) {
        if (room.local) merged.push(makeLocalRoomInfo(room));
    }
    useClient.getState().setRoomList(merged);
}

/* ── Room lifecycle ─────────────────────────────────────────────── */

export type CreateRoomOptions = {
    message: {
        clientId: number;
        playerId: PlayerId;
        sceneId: string;
        roomId: string;
        playerMode: PlayerMode;
        roomMode: RoomMode;
        namespace: string;
        packedNodes: Uint8Array;
        serverClockTime: number;
    };
    net: Net.ClientNet;
    rpc: SceneTreeContext['rpc'];
    resources: Resources;
    /** engine-global audio resources. pass through to createRoomCore so
     *  the per-room Audio coordinator can be set up. */
    audioResources: Audio.AudioResources;
    /** inbound trait wire-index for decoding `packedNodes`, server's
     *  outbound table, mirrored on this client. */
    inbound: InboundProtocol;
};

export function createRoom(opts: CreateRoomOptions): ClientRoom {
    const { message } = opts;
    const { clientId, playerId, sceneId, roomId, playerMode, roomMode, namespace, packedNodes } = message;
    const { inbound } = opts;

    const { nodes, voxels, physics, clock, chat, context } = newRoomCore({
        resources: opts.resources,
        rpc: opts.rpc,
        roomId,
        playerMode,
        roomMode,
        authority: false, // networked: the remote server owns the simulation
        clockSeed: message.serverClockTime, // seed our clock from the server's (shared time base)
    });

    // server-driven path: unpack the wire payload into the fresh scene
    // graph. voxels arrive separately via voxel chunk messages.
    unpackSceneTree(nodes, context, packedNodes, inbound);
    const playerNode = findPlayerNode(nodes, playerId, roomId);

    return createRoomCore({
        clientId,
        playerId,
        sceneId,
        roomId,
        playerMode,
        roomMode,
        namespace,
        local: false,
        net: opts.net,
        rpc: opts.rpc,
        resources: opts.resources,
        audioResources: opts.audioResources,
        nodes,
        voxels,
        physics,
        clock,
        chat,
        context,
        playerNode,
    });
}

type CreateRoomCoreOptions = {
    clientId: number;
    playerId: PlayerId;
    sceneId: string;
    roomId: string;
    playerMode: PlayerMode;
    roomMode: RoomMode;
    namespace: string;
    local: boolean;
    net: Net.ClientNet;
    rpc: SceneTreeContext['rpc'];
    resources: Resources;
    audioResources: Audio.AudioResources;
    /**
     * pre-populated room core, sceneGraph, voxels, physics, context
     * built by `newRoomCore` and populated by the caller (wire-unpack,
     * SceneHandle clone, or synthetic), plus the owned player node.
     * createRoomCore wires the post-populate state (CameraTrait, pov,
     * runtime hookup) and builds all the visuals.
     */
    nodes: SceneTree.SceneTree;
    voxels: Voxels.Voxels;
    physics: Physics.Physics;
    clock: Clock.Clock;
    chat: ChatClient;
    context: SceneTreeContext;
    playerNode: SceneTree.Node;
};

/**
 * allocate the mutually-dependent core a caller needs *before* populating
 * a fresh room: scene graph, voxels, physics, script runtime. Callers
 * populate these (wire-unpack, SceneHandle clone, or synthetic player
 * node), then hand the bag, plus the discovered/synthesized playerNode,
 * into `createRoomCore` for final assembly.
 *
 * `context.client` is left undefined here; `createRoomCore` fills it
 * after the canvas + scene + pov are constructed. Nothing in the
 * populate step reads `.client`.
 */
function newRoomCore(opts: {
    resources: Resources;
    rpc: SceneTreeContext['rpc'];
    roomId: string;
    playerMode: PlayerMode;
    roomMode: RoomMode;
    /** whether this client runtime owns the simulation (local/standalone room)
     *  vs replicates a remote server (networked room). gates server-authority
     *  script hooks (onJoin/onLeave/onBlock*). */
    authority: boolean;
    /** server clock (seconds) to seed this room's clock from, the join handshake
     *  supplies it on the networked path; omitted for local rooms (starts at 0). */
    clockSeed?: number;
}): {
    nodes: SceneTree.SceneTree;
    voxels: Voxels.Voxels;
    physics: Physics.Physics;
    clock: Clock.Clock;
    chat: ChatClient;
    context: SceneTreeContext;
} {
    const blocks = registry.blockRegistry;
    const voxels = Voxels.createVoxels(blocks);
    // a client-authoritative room (local/standalone) owns lighting + sim like the
    // server, so it gets the voxel authority that flushPendingLight relights against.
    // networked rooms receive baked light from the server, so they stay authority-less.
    if (opts.authority) voxels.authority = Voxels.createVoxelsAuthority();
    const nodes = SceneTree.createSceneTree();
    const physics = Physics.init(nodes, voxels);
    const clock = Clock.init(opts.clockSeed);
    const chat = Chat.init();
    const context: SceneTreeContext = {
        roomId: opts.roomId,
        playerMode: opts.playerMode,
        roomMode: opts.roomMode,
        resources: opts.resources,
        rpc: opts.rpc,
        client: undefined,
        server: undefined,
        authority: opts.authority,
        voxels,
        physics,
        clock,
        get blocks() {
            return voxels.registry;
        },
        instances: new Map(),
    };
    return { nodes, voxels, physics, clock, chat, context };
}

/**
 * synthesize a player node, mirrors the server's createPlayerNode. used
 * by the local and offline room paths (the wire path receives a serialised
 * player node from the server and just queries for it).
 */
function synthesizePlayerNode(
    nodes: SceneTree.SceneTree,
    playerId: PlayerId,
    clientId: number,
    playerMode: PlayerMode,
    user?: { id: string; username: string },
): SceneTree.Node {
    const playerNode = SceneTree.createNode({ name: `player:${playerId}`, persist: false });
    SceneTree.addChild(nodes.root, playerNode);
    SceneTree.setOwner(nodes, playerNode, playerId);
    // mirror the server's createPlayerNode: character rig + default controls so the
    // camera follows and the avatar renders in a client-authoritative local room.
    addPlayerTraits(playerNode, {
        playerId,
        clientId,
        mode: playerMode,
        viewRadius: playerMode === 'edit' ? 24 : 8,
        userId: user?.id,
        username: user?.username,
    });
    return playerNode;
}

/**
 * find the wire-unpacked player node the server created for this Player.
 * shared by initial join (`createRoom`) and resync (`resyncRoom`).
 */
function findPlayerNode(nodes: SceneTree.SceneTree, playerId: PlayerId, roomId: string): SceneTree.Node {
    for (const [trait] of SceneTree.query(nodes, [PlayerTrait])) {
        if (trait.playerId === playerId) return trait._node!;
    }
    throw new Error(`[bongle] failed to find player node for player ${playerId} in room ${roomId}`);
}

/**
 * set the owned player node's stream radius (PlayerTrait.viewRadius) from this
 * client's perf tier, so the server streams a `visual radius + apron` sphere
 * sized to the device. owner authority replicates the value up; the server
 * clamps it (discovery.ts).
 *
 * play only: edit rooms keep the server's large edit radius, an editor wants
 * far more of the world loaded than its draw radius, so the client must not
 * shrink it. leaving the trait untouched lets the server's value stand.
 */
export function applyClientStreamRadius(room: ClientRoom, profile: Performance.Profile): void {
    if (room.playerMode === 'edit') return;
    const trait = SceneTree.getTrait(room.playerNode, PlayerTrait);
    if (trait) trait.viewRadius = Performance.streamChunkRadius(profile);
}

function createRoomCore(opts: CreateRoomCoreOptions): ClientRoom {
    const { clientId, playerId, sceneId, roomId, playerMode, roomMode, namespace, local } = opts;
    const { nodes, voxels, physics, clock, chat, context, playerNode } = opts;

    const input = Input.createInput();

    const scene = new Scene();

    // crisp post-fxaa overlay content (CanvasTrait, world-space HUD). rendered
    // by the engine overlay pass, which shares this room's main-scene depth
    // read-only for occlusion. see WebGpu.EngineRenderPipeline.overlayPassNode.
    const overlayScene = new Scene();

    // one shared render-scenes object; both the ClientContext (ctx.client.render)
    // and the ClientRoom (room.render) reference it, so scripts and room-layer
    // code observe the same scenes.
    const render: RenderScenes = { scene, overlayScene };

    // per-room overlay viewport. it stacks ABOVE the single shared render canvas
    // (a backdrop sibling in the global viewport), so z-index 1 keeps its overlays
    // over the canvas; pointer-events:none lets empty-area gestures fall through to
    // the canvas while interactive overlay children re-enable events themselves.
    const viewport = document.createElement('div');
    viewport.style.display = 'none';
    viewport.style.position = 'absolute';
    viewport.style.inset = '0';
    viewport.style.pointerEvents = 'none';
    viewport.style.zIndex = '1';

    // the render surface is the one shared canvas owned by the renderer; rooms don't
    // own a canvas. Scripts reach it via `client.state.renderer.canvas` if needed, but
    // custom UI goes on `client.viewport` (per-room overlay container).

    // touch overlay sits ABOVE the html overlay (UILayer.touch). we create
    // the div here (so we can pass it on the runtime client shape) and
    // append it after DomUi.init; z-index, not DOM order, decides paint order.
    const touchOverlay = document.createElement('div');
    touchOverlay.style.position = 'absolute';
    touchOverlay.style.inset = '0';
    touchOverlay.style.pointerEvents = 'none';
    touchOverlay.style.zIndex = String(UILayer.touch);

    // wire context so addChild/addTrait calls inside createDefaultCameraNode
    // see the runtime (createNode / addTrait register against it).
    nodes.context = context;

    // default camera node, TransformTrait + CameraTrait at the scene root.
    // builtin controllers (orbit / fly / player) write to this each frame
    // instead of creating their own. recreated on resyncRoom because
    // unpackSceneTree wipes root's children.
    const cameraNode = createDefaultCameraNode(nodes, playerNode, playerMode);

    // the single client state. context.client and room.client both
    // reference this one object; subject / camera are plain fields mutated in
    // place, so scripts (ctx.client) and room-layer code (room.client) observe
    // swaps without re-seating. subject is seeded to the player node post-populate.
    const client: ClientContext = {
        clientId,
        render,
        subject: null,
        viewport,
        touchOverlay,
        debug: clientDebug,
        input,
        player: playerNode,
        camera: cameraNode,
        defaultSubject: playerNode,
        defaultCamera: cameraNode,
    };
    context.client = client;

    // per-room env CONFIG — pure client CPU state (time / sky / cloud settings).
    // `applyTime`/`applyConfig` mutate this shadow; the renderer reads it and owns
    // all the env RENDER state (sky/cloud meshes, GPU flush), built when it
    // reconciles this room into its active slot. No backend resources touched here.
    const environment = ClientEnv.createEnvironment(ENVIRONMENT_DEFAULT);

    // per-room audio coordinator. master gain + active-playback set are
    // owned by the room (disposeRoom tears them down); the underlying
    // AudioContext + decoded atlas are engine-global and reused.
    const audio = Audio.init(opts.audioResources);

    // post-populate wiring. sceneGraph + voxels came in already populated.
    // seed the subject at the player node, swappable via setSubject.
    // initSceneTree fires onInit/onEnter for instances registered during populate.
    client.subject = playerNode;

    // WorldTrait is attached by callers after they wire `client.room`/`.state`,
    // since its host-script onInit reads them (e.g. setEnvironment).

    const syncSnapshots = Replication.createSyncSnapshots();

    // metrics seed from the current debugOpen so rooms created mid-session pick
    // up the right state; engine-client's subscription flips them on later toggles.
    const metricsEnabled = useClient.getState().debugOpen;

    const clientMetrics = Debug.createMetrics(metricsEnabled);
    const serverMetrics = Debug.createMetrics(metricsEnabled);
    const clientLogs = Debug.createLogs();
    const serverLogs = Debug.createLogs();

    const particles = Particles.init();
    const visibility = Visibility.init();
    const modelLighting = ModelLighting.init(nodes);
    const animations = Animation.init(nodes);

    const room: ClientRoom = {
        playerId,
        roomId,
        sceneId,
        playerMode,
        roomMode,
        namespace,
        local,
        scene: nodes,
        render,
        context: context,
        syncSnapshots,
        voxels,
        physics,
        clock,
        chat,
        environment,
        audio,
        playerNode,
        cameraNode,
        client,
        // editor lens is opt-in; populated by enterLocalEditorView (or the
        // edit-room flow). seeding null here keeps fresh rooms inert until
        // the user explicitly enters editor view.
        editor: null,
        clientMetrics,
        serverMetrics,
        clientLogs,
        serverLogs,
        particles,
        visibility,
        modelLighting,
        animations,
        input,
        viewport,
        touchOverlay,
    };

    // the room's GPU visuals (voxel/model/sprite/.../domUi) are backend-owned and
    // built when the renderer reconciles this room into its active slot (driven by
    // `state.activePlayerId`), so only the active room holds a visual bundle.
    // Nothing to build here.

    // append touchOverlay into the room viewport; paint order is set by UILayer
    // z-index, not DOM order, so it composes correctly once the active room's DOM
    // overlay is built on activation.
    viewport.appendChild(touchOverlay);

    return room;
}

/**
 * apply a fresh server-sent scene graph into an existing ClientRoom in
 * place. used when a join_room message arrives for a player we already
 * hold (e.g. after an `invalidatePlayer` on the server resyncs the room).
 *
 * preserves: scene, canvas (incl. renderer-bound camera on the engine-global pipeline),
 * viewport, voxels, voxelVisuals, physics, context. replaces: the
 * scene graph contents and the playerNode (CameraTrait is re-attached on
 * the fresh playerNode).
 *
 * relies on `unpackSceneTree` clearing existing children + script
 * instances before rebuilding.
 */
export function resyncRoom(room: ClientRoom, message: CreateRoomOptions['message'], inbound: InboundProtocol): void {
    unpackSceneTree(room.scene, room.context, message.packedNodes, inbound);

    // unpackSceneTree clears root._traits and rebuilds from the wire,
    // which never carries WorldTrait (persist: false). re-attach so the
    // host script(WorldTrait, …) instances respawn against the fresh graph.
    attachWorldTrait(room.scene.root);

    const playerNode = findPlayerNode(room.scene, message.playerId, message.roomId);
    room.playerNode = playerNode;
    // unpackSceneTree wiped the default camera node along with the rest of
    // root's children, re-create it.
    room.cameraNode = createDefaultCameraNode(room.scene, playerNode, room.playerMode);
    // re-seat the client state to the fresh nodes. plain writes to the one
    // client object, observed everywhere.
    room.client.subject = playerNode;
    room.client.player = playerNode;
    room.client.camera = room.cameraNode;
    room.client.defaultSubject = playerNode;
    room.client.defaultCamera = room.cameraNode;
}

/**
 * build the per-room default camera node. used at room creation and again
 * on resync (since unpackSceneTree clears the existing tree).
 */
function createDefaultCameraNode(nodes: SceneTree.SceneTree, playerNode: SceneTree.Node, playerMode: PlayerMode): SceneTree.Node {
    const node = SceneTree.createNode({ name: `${playerNode.name}:camera`, persist: false });
    SceneTree.addTrait(node, TransformTrait);
    SceneTree.addTrait(node, CameraTrait);
    SceneTree.addChild(nodes.root, node);
    // Edit rooms drive this camera via the fly controller, which starts from
    // whatever pose the node holds. Seed it above the origin looking down at
    // (0,0,0) so a fresh edit session opens overlooking the scene rather than
    // sitting inside it. Play rooms overwrite this each frame from the player
    // controller, so their camera pose here doesn't matter.
    if (playerMode === 'edit') {
        const transform = SceneTree.getTrait(node, TransformTrait)!;
        const eye: [number, number, number] = [5, 5, 5];
        const target: [number, number, number] = [0, 0, 0];
        const up: [number, number, number] = [0, 1, 0];
        const m = mat4.create();
        mat4.targetTo(m, eye, target, up);
        const q = quat.create();
        quat.fromMat4(q, m);
        setWorldPosition(transform, eye);
        setWorldQuaternion(transform, q);
    }
    return node;
}

/**
 * mount a ClientRoom's overlay viewport into the global viewport div (above the
 * shared render canvas; z-index governs stacking, so prepend order is fine). The
 * render surface is the one shared canvas, sized globally by the client — not here.
 * camera aspect is bound globally each frame from the shared canvas size. caller is
 * responsible for wiring `room.context.client.state`/`.room` and calling
 * `SceneTree.initSceneTree(room.scene)` after mount.
 */
export function mountRoomViewport(room: ClientRoom): void {
    const viewport = useClient.getState().viewportElement;
    if (!viewport) return;
    viewport.prepend(room.viewport);
}

/* ── Local rooms ────────────────────────────────────────────────── */

export type StartLocalRoomOptions = {
    state: EngineClient;
    clientId: number;
    sceneId: string;
    playerMode: PlayerMode;
    roomMode: RoomMode;
    /** optional explicit roomId (must start with `LOCAL_ROOM_PREFIX`). default: synthesized. */
    roomId?: string;
    /** optional namespace; defaults to 'main'. */
    namespace?: string;
};

/**
 * create a client-only ClientRoom from a declared scene handle, mount
 * its viewport, init the scene graph, and register it in the rooms map.
 * Returns the fully wired ClientRoom. Local rooms never talk to the
 * server, no join_room / set_active_room / net_message traffic flows
 * out of them.
 */
export function startLocalRoom(opts: StartLocalRoomOptions): ClientRoom {
    const { state, sceneId, playerMode, roomMode, clientId } = opts;
    const handle = registry.scenes.handles.get(sceneId);
    if (!handle) {
        throw new Error(`[bongle] startLocalRoom: scene '${sceneId}' is not declared`);
    }
    if (!handle.def.client) {
        throw new Error(`[bongle] startLocalRoom: scene '${sceneId}' is server-only (client: false)`);
    }

    const rooms = state.rooms;
    const localId = rooms.nextLocalId++;
    const roomId = opts.roomId ?? `${LOCAL_ROOM_PREFIX}${localId}`;
    if (!roomId.startsWith(LOCAL_ROOM_PREFIX)) {
        throw new Error(`[bongle] startLocalRoom: explicit roomId '${roomId}' must start with '${LOCAL_ROOM_PREFIX}'`);
    }
    // local PlayerIds are negative so they never collide with server-allocated positive ids
    const playerId: PlayerId = -(localId + 1);
    const namespace = opts.namespace ?? 'main';

    const { nodes, voxels, physics, clock, context, chat } = newRoomCore({
        resources: state.resources,
        rpc: state.rpc,
        roomId,
        playerMode,
        roomMode,
        authority: true, // local/standalone: this client owns the simulation
    });

    // copy declared voxels first (may be null if scene has none). must
    // precede loadSceneTree: any seed scripts that call setBlock on
    // onInit would otherwise be wiped, though runtime isn't wired
    // until after populate, so onInit defers to initSceneTree anyway.
    if (handle.voxels) {
        Voxels.copyVoxels(voxels, handle.voxels);
    }

    // load the scene from the raw payload so root-level traits land
    // on sceneGraph.root. iterating handle.node.children drops them,
    // server-mirrored rooms bypass this path via loadSceneTree on
    // disk data; local rooms need the same treatment.
    const payload = state.content.payloads.get(sceneId);
    if (payload) {
        SceneTree.loadSceneTree(nodes, payload.nodes);
    }

    const playerNode = synthesizePlayerNode(nodes, playerId, clientId, playerMode, state.driver.user);

    // apply the local player's platform avatar (identity from driver.user), mirroring the
    // server's setClientAvatar + enqueuePlayer: register + load the model into client
    // Resources and stamp the CharacterTrait so the rig reconciler mounts the right avatar.
    // networked clients get this via replication; a local room has no server to replicate
    // from, so it resolves + assigns here.
    const resolvedAvatar = acquireAvatarModel(state.resources, state.driver.user.avatar);
    assignAvatar(playerNode, resolvedAvatar.modelId, resolvedAvatar.rigType);

    const room = createRoomCore({
        clientId,
        playerId,
        sceneId,
        roomId,
        playerMode,
        roomMode,
        namespace,
        local: true,
        net: state.net,
        rpc: state.rpc,
        resources: state.resources,
        audioResources: state.audioResources,
        nodes: nodes,
        voxels,
        physics,
        clock,
        context: context,
        chat,
        playerNode,
    });

    mountRoomViewport(room);
    if (room.context.client) {
        room.context.client.state = state;
        room.context.client.room = room;
    }

    // host-script onInit reads client.room/.state (wired above); initSceneTree fires it.
    attachWorldTrait(room.scene.root);
    console.log(
        `[bongle room] createLocalRoom: room.playerId=${String(room.playerId)} roomId=${room.roomId} playerMode=${room.playerMode}`,
    );
    SceneTree.initSceneTree(room.scene);
    rooms.rooms.set(playerId, room);
    useClient.getState().setRoom(playerId, room);

    // fire onJoin for the local player — parity with a server room. A local room is
    // client-authoritative, so the game's join logic (spawn/setup) runs here too.
    // initSceneTree above already fired onInit (registering onJoin listeners). The
    // resolved avatar (already stamped onto the CharacterTrait above) carries the
    // modelId/rigType into JoinArgs, like the server's clientAvatarIdentity.
    const joinData = {};
    fireJoinHooks(context, clientId, state.driver.user, joinData, room.playerMode, playerNode, resolvedAvatar);

    // append a synthetic RoomInfo so this local room participates in
    // roomList alongside server-driven rooms (tabs, debug, etc.).
    const client = useClient.getState();
    client.setRoomList([...client.roomList, makeLocalRoomInfo(room)]);
    return room;
}

/**
 * dispose a local ClientRoom and remove it from the registry. throws
 * on unknown rooms or server-mirrored rooms (those are membership-driven
 * and disposed via `room_left`).
 */
export function stopLocalRoom(state: EngineClient, roomId: string): void {
    const room = findRoomByRoomId(state.rooms, roomId);
    if (!room) {
        throw new Error(`[bongle] stopLocalRoom: room '${roomId}' not found`);
    }
    if (!room.local) {
        throw new Error(`[bongle] stopLocalRoom: room '${roomId}' is server-backed; only local rooms can be stopped`);
    }
    // fire onLeave for the local player before teardown — parity with a server room's
    // leave path, so the game's cleanup (save score, despawn) runs on stop. A local room
    // is authoritative, so onLeave registered there and this fires it.
    const playerTrait = SceneTree.getTrait(room.playerNode, PlayerTrait);
    if (playerTrait) fireLeaveHooks(room.context, playerTrait.client, room.playerNode);
    disposeRoom(room);
    state.rooms.rooms.delete(room.playerId);
    useClient.getState().removeRoom(room.playerId);
    // mirror the registry: drop the synthetic RoomInfo we added in
    // startLocalRoom so this room disappears from roomList too.
    const client = useClient.getState();
    client.setRoomList(client.roomList.filter((r) => r.id !== room.roomId));
    if (state.rooms.activePlayerId === room.playerId) {
        state.rooms.activePlayerId = null;
        useClient.getState().setActivePlayerId(null);
    }
}

/** Find a ClientRoom by roomId, or undefined if no Player observes it. */
export function findRoomByRoomId(state: Rooms, roomId: string): ClientRoom | undefined {
    for (const room of state.rooms.values()) {
        if (room.roomId === roomId) return room;
    }
    return undefined;
}

/**
 * Tear down a room's non-render resources (physics, audio, DOM). The room's GPU
 * visuals are backend-owned and released by the renderer's reconcile/`dispose`, not
 * here — a non-active room has none, and the active room's are torn down when the
 * renderer next reconciles away from it.
 */
export function disposeRoom(room: ClientRoom): void {
    Physics.dispose(room.physics);
    // if this was the active room, its GPU visuals (incl. domUi + arena chunks) are
    // backend-owned; the renderer tears them down when it reconciles to the next
    // active room (or null) on the following `updateFrame`, or at `dispose()`. A
    // non-active room has no visuals, so there's nothing to release here.
    // room.environment is pure client CPU config — nothing to dispose. The
    // engine-global env GPU buffers live for the engine's lifetime.
    if (room.audio) Audio.dispose(room.audio);
    room.viewport.remove();
}

/* ── Active player ──────────────────────────────────────────────── */

/** get the active room, or null if none. */
export function getActiveRoom(state: Rooms): ClientRoom | null {
    if (!state.activePlayerId) return null;
    return state.rooms.get(state.activePlayerId) ?? null;
}

/**
 * Resolve `camera` (the backend's `Renderer.camera`) into `room`'s live POV: pose +
 * fov from its active CameraTrait. Returns the camera, or null when the room has no
 * active POV. Aspect is a global property of the shared display surface, bound once
 * per frame by the client (`bindAspect`), not here. Resolution is backend-neutral math
 * (`render/common/camera`); the client just hands the backend's stable camera object
 * to it — the cull, the editor tools, and the draw all share the one camera.
 */
export function resolveRoomCamera(camera: PerspectiveCamera, room: ClientRoom): PerspectiveCamera | null {
    const cameraTrait = SceneTree.getTrait(room.client.camera, CameraTrait) ?? null;
    return RenderCamera.resolvePovCamera(camera, cameraTrait);
}

/** set the active Player; `useClient` mirrors it for the UI. The renderer isn't touched
 *  here — it reconciles its visuals to `state.activePlayerId` on the next
 *  `updateFrame` (build/mount/flush on entry, teardown on exit). */
export function setActivePlayer(state: Rooms, net: Net.ClientNet, playerId: PlayerId): void {
    state.activePlayerId = playerId;
    useClient.getState().setActivePlayerId(playerId);
    const room = state.rooms.get(playerId);
    if (!room) return;

    // toggle viewport visibility, only the active room's viewport (and
    // therefore its canvas + script overlays) is shown.
    for (const r of state.rooms.values()) {
        r.viewport.style.display = r === room ? 'block' : 'none';
    }

    // route DOM input events into the new active room's Input. Inactive
    // rooms see no events, this is what makes inactive scripts read zero
    // input structurally rather than relying on opt-in gates.
    const engineState = room.context.client?.state;
    if (engineState) {
        Input.setInputManagerTarget(engineState.inputManager, room.input);
    }

    // notify server about active player (presence), local rooms have no
    // server peer, so suppress the ping.
    if (!room.local) {
        Net.send(net, { type: 'set_active_room', playerId });
    }
}

/**
 * Look up every ClientRoom whose roomId matches (across all Players /
 * modes the client holds in that room). Used by message routing for
 * protocol messages that target a (roomId) without a Player, every
 * matching ClientRoom receives the update.
 */
export function* getRoomsByRoomId(state: Rooms, roomId: string): Generator<ClientRoom> {
    for (const room of state.rooms.values()) {
        if (room.roomId === roomId) yield room;
    }
}

export function applyJoinRoom(state: EngineClient, message: Protocol.JoinRoom): void {
    if (message.roomId.startsWith(LOCAL_ROOM_PREFIX)) {
        console.error(
            `[bongle] applyJoinRoom: rejecting server room id '${message.roomId}': '${LOCAL_ROOM_PREFIX}' prefix is reserved for client-only rooms`,
        );
        return;
    }

    // resync path: same player + room shell already exists (server re-sent
    // join_room for an already-joined player). repopulate the scene graph in
    // place and re-fire onInit, keeping activePlayerId, viewport, and meshes.
    const existing = state.rooms.rooms.get(message.playerId);
    if (existing && existing.roomId === message.roomId) {
        resyncRoom(existing, message, state.inbound);
        applyClientStreamRadius(existing, state.perf.profile);
        SceneTree.initSceneTree(existing.scene);
        return;
    }

    const room = createRoom({
        message,
        net: state.net,
        rpc: state.rpc,
        resources: state.resources,
        audioResources: state.audioResources,
        inbound: state.inbound,
    });
    applyClientStreamRadius(room, state.perf.profile);
    mountRoomViewport(room);

    // populate ctx.client.state/.room before onInit hooks (which may read them),
    // then attach the world trait and fire onInit via initSceneTree.
    if (room.context.client) {
        room.context.client.state = state;
        room.context.client.room = room;
    }
    attachWorldTrait(room.scene.root);
    SceneTree.initSceneTree(room.scene);

    if (existing) disposeRoom(existing);

    // additive: does NOT auto-activate. the server sends a follow-up
    // activate_room when this view should become the focused tab.
    state.rooms.rooms.set(message.playerId, room);
    useClient.getState().setRoom(message.playerId, room);
}

export function applyRoomLeft(state: EngineClient, message: Protocol.RoomLeft): void {
    const leaving = state.rooms.rooms.get(message.playerId);
    if (leaving) disposeRoom(leaving);

    state.rooms.rooms.delete(message.playerId);
    useClient.getState().removeRoom(message.playerId);

    if (state.rooms.activePlayerId !== message.playerId) return;

    // the active view left: fall back to any edit-mode view we still hold.
    let fallback: ClientRoom | null = null;
    for (const room of state.rooms.rooms.values()) {
        if (room.playerMode === 'edit') {
            fallback = room;
            break;
        }
    }
    if (fallback) {
        setActivePlayer(state.rooms, state.net, fallback.playerId);
    } else {
        state.rooms.activePlayerId = null;
        useClient.getState().setActivePlayerId(null);
    }
}

export function applySceneSync(state: EngineClient, message: Protocol.SceneSync): void {
    const room = state.rooms.rooms.get(message.playerId);
    if (!room) return;
    for (const update of message.updates) {
        applySceneSyncUpdate(room.scene, room.context, update, state.inbound);
    }
}
