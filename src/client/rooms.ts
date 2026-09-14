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

export type { PlayerId };

export type ClientRoom = {
    playerId: PlayerId;

    roomId: string;

    sceneId: string;

    playerMode: PlayerMode;

    /** immutable; may differ from playerMode, e.g. an edit Player attached to a play room. */
    roomMode: RoomMode;

    namespace: string;

    /** true for a client-only room: synthetic playerId/roomId, no server backing, no `set_active_room` pings. */
    local: boolean;

    scene: SceneTree.SceneTree;

    render: RenderScenes;

    context: SceneTreeContext;

    /** snapshot of the last scene graph state sent to the server, for replication diffing. */
    syncSnapshots: ReturnType<typeof Replication.createSyncSnapshots>;

    /** always present (may be empty). */
    voxels: Voxels.Voxels;

    physics: Physics.Physics;

    /** monotonic seconds; advanced by the fixed-tick loop, read via `ctx.clock.time`. */
    clock: Clock.Clock;

    /** command registry, line buffer, UI subscribers, inbox/outbox queues; drained each frame by Chat.tick. */
    chat: ChatClient;

    /** CPU shadow of the sky/sun/moon/stars/clouds config; flushes into the engine-global env buffers each frame while active. */
    environment: ClientEnv.Environment;

    /** backed by engine-global `AudioResources`; each room owns its own master gain + active-playback set. */
    audio: Audio.Audio;

    playerNode: SceneTree.Node;

    /** default per-room camera, TransformTrait + CameraTrait at the scene root; initial value of `client.camera`. */
    cameraNode: SceneTree.Node;

    /** the single mutable ClientContext every script in the room sees as `ctx.client` (same object as `context.client`). */
    client: ClientContext;

    /** whether the host has been told this room is up; per room since a switched-to host raises its loading screen again. */
    readyReported: boolean;

    /** seconds spent as the rendered room, counted only until it reports ready. */
    renderedTimeS: number;

    /** the server's frame profile, mirrored from `room_frames` packets while subscribed. */
    serverProfiler: Debug.Profiler;

    /** `log(ctx, ...)` calls in client scripts land here. */
    clientLogs: Debug.Logs;

    /** fed by `debug_logs` packets while subscribed. */
    serverLogs: Debug.Logs;

    /** fixed capacity; spawn fills slots, `Particles.update` compacts dead ones. */
    particles: Particles.ParticlePool;

    /** DBVT + frustum cull; mesh-visuals + voxel-visuals register leaves and read the per-frame visible set. */
    visibility: Visibility.Visibility;

    /** caches the [AnimatorTrait] query consumed by `Animation.tick`. */
    animations: Animation.Animations;

    /** DOM events route here only when this room is active, see `setActivePlayer`. */
    input: Input.Input;

    /** holds this room's HTML overlays; only the active room's viewport is `display: block`. */
    viewport: HTMLDivElement;

    touchOverlay: HTMLDivElement;
};

export type Rooms = {
    rooms: Map<PlayerId, ClientRoom>;
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

/** synthetic player id for a headless render room; no node is owned by it, so every node interpolates uniformly. */
export const RENDER_ROOM_PLAYER_ID = -1 as PlayerId;

/** a client-only room with the simulation core plus render visuals but no presentation; rendered offscreen, not in `state.rooms`. */
export type RenderRoom = {
    scene: SceneTree.SceneTree;
    voxels: Voxels.Voxels;
    physics: Physics.Physics;
    clock: Clock.Clock;
    context: SceneTreeContext;
    /** headless, no overlay pass */
    render: { scene: Scene };
    voxelVisuals: VoxelVisuals.VoxelVisuals;
    voxelMeshVisuals: VoxelMeshVisuals.VoxelMeshVisuals;
    modelVisuals: MeshVisuals.MeshVisuals;
    visibility: Visibility.Visibility;
    environment: ClientEnv.Environment;
    /** sky/cloud meshes; this offline room owns them directly (no backend `createRoomVisuals`). */
    envVisuals: Environment.EnvVisuals;
};

/** everything `createRenderRoom` needs, decoupled from `EngineClient` so a headless pipeline-worker engine can use it too. */
export type RenderRoomDeps = {
    resources: Resources;
    rpc: SceneTreeContext['rpc'];
    environmentResources: Environment.EnvironmentResources;
    offline: OfflineRenderer;
    /** gpu (WebGPU compute producer) or cpu (WebGL cullEmit producer); each backend narrows in renderToTarget. */
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
    // the tree keeps no context, so addTrait/registerSubtree never instantiate scripts and no WorldTrait means no systems.
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

/** synthesizes a `RoomInfo` for a local-only ClientRoom, since local rooms never appear in server room_list messages. */
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

/** applies a server-broadcast room list while preserving entries for local rooms (those without server backing). */
export function applyServerRoomList(state: Rooms, serverRooms: RoomInfo[]): void {
    const merged = [...serverRooms];
    for (const room of state.rooms.values()) {
        if (room.local) merged.push(makeLocalRoomInfo(room));
    }
    useClient.getState().setRoomList(merged);
}

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
    /** engine-global audio resources for the per-room Audio coordinator. */
    audioResources: Audio.AudioResources;
    /** inbound trait wire-index for decoding `packedNodes`, mirrors the server's outbound table. */
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

    // voxels arrive separately via voxel chunk messages
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
    /** pre-populated room core plus the owned player node; createRoomCore wires the post-populate state and builds the visuals. */
    nodes: SceneTree.SceneTree;
    voxels: Voxels.Voxels;
    physics: Physics.Physics;
    clock: Clock.Clock;
    chat: ChatClient;
    context: SceneTreeContext;
    playerNode: SceneTree.Node;
};

/** allocates the mutually-dependent core a caller needs before populating a fresh room; `createRoomCore` fills `context.client`. */
function newRoomCore(opts: {
    resources: Resources;
    rpc: SceneTreeContext['rpc'];
    roomId: string;
    playerMode: PlayerMode;
    roomMode: RoomMode;
    /** owns the simulation (local/standalone) vs replicates a remote server (networked); gates server-authority script hooks. */
    authority: boolean;
    /** server clock (seconds) to seed from; the join handshake supplies it on the networked path, omitted for local rooms. */
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
    // client-authoritative rooms own lighting + sim like the server; networked rooms receive baked light and stay authority-less.
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

/** synthesizes a player node, mirroring the server's createPlayerNode; the wire path instead receives a serialised one. */
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

/** finds the wire-unpacked player node the server created for this Player, shared by initial join and resync. */
function findPlayerNode(nodes: SceneTree.SceneTree, playerId: PlayerId, roomId: string): SceneTree.Node {
    for (const [trait] of SceneTree.query(nodes, [PlayerTrait])) {
        if (trait.playerId === playerId) return trait._node!;
    }
    throw new Error(`[bongle] failed to find player node for player ${playerId} in room ${roomId}`);
}

/** sets the owned player node's stream radius from this client's perf tier; play only, edit rooms keep the server's large radius. */
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

    // crisp post-fxaa overlay content (CanvasTrait, world-space HUD); shares this room's main-scene depth read-only for occlusion.
    const overlayScene = new Scene();

    // shared by ClientContext (ctx.client.render) and ClientRoom (room.render)
    const render: RenderScenes = { scene, overlayScene };

    // stacks above the single shared render canvas; pointer-events:none lets empty-area gestures fall through.
    const viewport = document.createElement('div');
    viewport.style.display = 'none';
    viewport.style.position = 'absolute';
    viewport.style.inset = '0';
    viewport.style.pointerEvents = 'none';
    viewport.style.zIndex = '1';

    // sits above the html overlay (UILayer.touch); z-index, not DOM order, decides paint order
    const touchOverlay = document.createElement('div');
    touchOverlay.style.position = 'absolute';
    touchOverlay.style.inset = '0';
    touchOverlay.style.pointerEvents = 'none';
    touchOverlay.style.zIndex = String(UILayer.touch);

    // so createNode/addTrait calls inside createDefaultCameraNode register against the runtime
    nodes.context = context;

    // recreated on resyncRoom because unpackSceneTree wipes root's children
    const cameraNode = createDefaultCameraNode(nodes, playerNode, playerMode);

    // context.client and room.client reference this one object; subject/camera are mutated in place so swaps need no re-seating.
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

    // pure client CPU state; the renderer reads it and owns the env render state when it reconciles this room into its active slot.
    const environment = ClientEnv.createEnvironment(ENVIRONMENT_DEFAULT);

    // master gain + active-playback set are owned by the room; the underlying AudioContext + decoded atlas are engine-global.
    const audio = Audio.init(opts.audioResources);

    // seeded here, swappable via setSubject; initSceneTree fires onInit/onEnter below
    client.subject = playerNode;

    // WorldTrait is attached by callers after wiring `client.room`/`.state`, since its host-script onInit reads them.
    const syncSnapshots = Replication.createSyncSnapshots();

    // seeds from the current debugOpen so rooms created mid-session pick up the right state.
    const serverProfiler = Debug.createProfiler(useClient.getState().debugOpen);
    const clientLogs = Debug.createLogs();
    const serverLogs = Debug.createLogs();

    const particles = Particles.init();
    const visibility = Visibility.init();
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
        readyReported: false,
        renderedTimeS: 0,
        serverProfiler,
        clientLogs,
        serverLogs,
        particles,
        visibility,
        animations,
        input,
        viewport,
        touchOverlay,
    };

    // the room's GPU visuals are backend-owned, built when the renderer reconciles this room into its active slot.
    viewport.appendChild(touchOverlay);

    return room;
}

/** applies a fresh server-sent scene graph into an existing ClientRoom in place, preserving scene/viewport/voxels/physics/context. */
export function resyncRoom(room: ClientRoom, message: CreateRoomOptions['message'], inbound: InboundProtocol): void {
    unpackSceneTree(room.scene, room.context, message.packedNodes, inbound);

    // unpackSceneTree rebuilds root's traits from the wire, which never carries WorldTrait (persist: false); re-attach it.
    attachWorldTrait(room.scene.root);

    const playerNode = findPlayerNode(room.scene, message.playerId, message.roomId);
    room.playerNode = playerNode;
    // unpackSceneTree wiped the default camera node along with root's other children
    room.cameraNode = createDefaultCameraNode(room.scene, playerNode, room.playerMode);
    room.client.subject = playerNode;
    room.client.player = playerNode;
    room.client.camera = room.cameraNode;
    room.client.defaultSubject = playerNode;
    room.client.defaultCamera = room.cameraNode;
}

/** builds the per-room default camera node; used at room creation and again on resync. */
function createDefaultCameraNode(nodes: SceneTree.SceneTree, playerNode: SceneTree.Node, playerMode: PlayerMode): SceneTree.Node {
    const node = SceneTree.createNode({ name: `${playerNode.name}:camera`, persist: false });
    SceneTree.addTrait(node, TransformTrait);
    SceneTree.addTrait(node, CameraTrait);
    SceneTree.addChild(nodes.root, node);
    // edit rooms drive this camera via the fly controller; seed it overlooking the origin. play rooms overwrite the pose every frame.
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

/** mounts a ClientRoom's overlay viewport into the global viewport div; z-index governs stacking, so prepend order is fine. */
export function mountRoomViewport(room: ClientRoom): void {
    const viewport = useClient.getState().viewportElement;
    if (!viewport) return;
    viewport.prepend(room.viewport);
}

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

/** creates a client-only ClientRoom from a declared scene handle, mounts its viewport, inits the scene graph, and registers it. */
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

    // must precede loadSceneTree: seed scripts calling setBlock on onInit would otherwise be wiped.
    if (handle.voxels) {
        Voxels.copyVoxels(voxels, handle.voxels);
    }

    // load from the raw payload (not handle.node.children) so root-level traits land on sceneGraph.root
    const payload = state.content.payloads.get(sceneId);
    if (payload) {
        SceneTree.loadSceneTree(nodes, payload.nodes);
    }

    const playerNode = synthesizePlayerNode(nodes, playerId, clientId, playerMode, state.driver.user);

    // mirrors the server's setClientAvatar + enqueuePlayer; a local room has no server to replicate from.
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

    // host-script onInit reads client.room/.state (wired above); initSceneTree fires it
    attachWorldTrait(room.scene.root);
    console.log(
        `[bongle room] createLocalRoom: room.playerId=${String(room.playerId)} roomId=${room.roomId} playerMode=${room.playerMode}`,
    );
    SceneTree.initSceneTree(room.scene);
    rooms.rooms.set(playerId, room);
    useClient.getState().setRoom(playerId, room);

    // parity with a server room: a local room is client-authoritative, so the game's join logic runs here too.
    const joinData = {};
    fireJoinHooks(context, clientId, state.driver.user, joinData, room.playerMode, playerNode, resolvedAvatar);

    const client = useClient.getState();
    client.setRoomList([...client.roomList, makeLocalRoomInfo(room)]);
    return room;
}

/** disposes a local ClientRoom and removes it from the registry; throws on unknown or server-mirrored rooms. */
export function stopLocalRoom(state: EngineClient, roomId: string): void {
    const room = findRoomByRoomId(state.rooms, roomId);
    if (!room) {
        throw new Error(`[bongle] stopLocalRoom: room '${roomId}' not found`);
    }
    if (!room.local) {
        throw new Error(`[bongle] stopLocalRoom: room '${roomId}' is server-backed; only local rooms can be stopped`);
    }
    // parity with a server room's leave path, so the game's cleanup (save score, despawn) runs on stop
    const playerTrait = SceneTree.getTrait(room.playerNode, PlayerTrait);
    if (playerTrait) fireLeaveHooks(room.context, playerTrait.client, room.playerNode);
    disposeRoom(room);
    state.rooms.rooms.delete(room.playerId);
    useClient.getState().removeRoom(room.playerId);
    // drop the synthetic RoomInfo added in startLocalRoom so this room disappears from roomList too
    const client = useClient.getState();
    client.setRoomList(client.roomList.filter((r) => r.id !== room.roomId));
    if (state.rooms.activePlayerId === room.playerId) {
        state.rooms.activePlayerId = null;
        useClient.getState().setActivePlayerId(null);
    }
}

export function findRoomByRoomId(state: Rooms, roomId: string): ClientRoom | undefined {
    for (const room of state.rooms.values()) {
        if (room.roomId === roomId) return room;
    }
    return undefined;
}

/** tears down a room's non-render resources (physics, audio, DOM); GPU visuals are backend-owned and released elsewhere. */
export function disposeRoom(room: ClientRoom): void {
    Physics.dispose(room.physics);
    if (room.audio) Audio.dispose(room.audio);
    room.viewport.remove();
}

export function getActiveRoom(state: Rooms): ClientRoom | null {
    if (!state.activePlayerId) return null;
    return state.rooms.get(state.activePlayerId) ?? null;
}

/** resolves `camera` into `room`'s live POV (pose + fov from its active CameraTrait); null when the room has no active POV. */
export function resolveRoomCamera(camera: PerspectiveCamera, room: ClientRoom): PerspectiveCamera | null {
    const cameraTrait = SceneTree.getTrait(room.client.camera, CameraTrait) ?? null;
    return RenderCamera.resolvePovCamera(camera, cameraTrait);
}

/** sets the active Player; `useClient` mirrors it for the UI. the renderer reconciles visuals on the next `updateFrame`. */
export function setActivePlayer(state: Rooms, net: Net.ClientNet, playerId: PlayerId): void {
    state.activePlayerId = playerId;
    useClient.getState().setActivePlayerId(playerId);
    const room = state.rooms.get(playerId);
    if (!room) return;

    // only the active room's viewport (and its canvas + script overlays) is shown
    for (const r of state.rooms.values()) {
        r.viewport.style.display = r === room ? 'block' : 'none';
    }

    // inactive rooms see no events, so their scripts read zero input structurally
    const engineState = room.context.client?.state;
    if (engineState) {
        Input.setInputManagerTarget(engineState.inputManager, room.input);
    }

    // local rooms have no server peer, so suppress the presence ping
    if (!room.local) {
        Net.send(net, { type: 'set_active_room', playerId });
    }
}

/** looks up every ClientRoom whose roomId matches, for protocol messages that target a roomId without a Player. */
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

    // resync path: same player + room shell already exists; repopulate in place, keeping activePlayerId etc.
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

    // populate ctx.client.state/.room before onInit hooks (which may read them)
    if (room.context.client) {
        room.context.client.state = state;
        room.context.client.room = room;
    }
    attachWorldTrait(room.scene.root);
    SceneTree.initSceneTree(room.scene);

    if (existing) disposeRoom(existing);

    // additive: does not auto-activate; the server sends a follow-up activate_room
    state.rooms.rooms.set(message.playerId, room);
    useClient.getState().setRoom(message.playerId, room);
}

export function applyRoomLeft(state: EngineClient, message: Protocol.RoomLeft): void {
    const leaving = state.rooms.rooms.get(message.playerId);
    if (leaving) disposeRoom(leaving);

    state.rooms.rooms.delete(message.playerId);
    useClient.getState().removeRoom(message.playerId);

    if (state.rooms.activePlayerId !== message.playerId) return;

    // fall back to any edit-mode view still held
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
