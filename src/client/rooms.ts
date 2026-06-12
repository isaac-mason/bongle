import { CanvasTarget, type PerspectiveCamera, Scene } from 'gpucat';
import { CameraRefTrait, CameraTrait } from '../builtins/camera';
import { PlayerTrait } from '../builtins/player';
import { TransformTrait } from '../builtins/transform';
import { attachWorldTrait } from '../builtins/world';
import { ENVIRONMENT_DEFAULT } from '../api/environment';
import type { PlayerId } from '../core/client';
import * as Debug from '../core/debug';
import * as Clock from '../core/clock';
import * as Physics from '../core/physics/physics';
import { registry, type WireIndex } from '../core/registry';
import type { PlayerMode, RoomInfo, RoomMode } from '../core/protocol';
import type { Resources } from '../core/resources';
import * as Animation from '../core/scene/animation';
import * as Nodes from '../core/scene/nodes';
import { unpackSceneGraph } from '../core/scene/scene-pack';
import type { ControlClientState, EditRoomState, NodesContext } from '../core/scene/scripts';
import * as Voxels from '../core/voxels/voxels';
import type { ClipboardHandlers } from '../editor/clipboard';
import type { EditRoomStoreApi } from '../editor/edit-room-store';
import * as Audio from './audio/audio';
import * as Chat from './chat';
import type { ChatClient } from './chat';
import * as DomUi from './dom-ui';
import type { EngineClient } from './engine-client';
import * as Environment from './environment';
import * as Input from './input';
import * as Interpolation from './interpolation';
import type * as CloudResourcesNs from './cloud-resources';
import type * as ModelResourcesNs from './models/model-resources';
import * as ModelVisuals from './models/model-visuals';
import * as Net from './net';
import type * as ParticleResourcesNs from './particles/particle-resources';
import * as ParticleVisuals from './particles/particle-visuals';
import * as Particles from './particles/particles';
import * as Renderer from './renderer';
import * as Replication from './replication';
import type * as ExtrudedSpriteResourcesNs from './sprites/extruded-sprite-resources';
import * as ExtrudedSpriteVisuals from './sprites/extruded-sprite-visuals';
import type * as SpriteResourcesNs from './sprites/sprite-resources';
import * as SpriteVisuals from './sprites/sprite-visuals';
import type * as ShadowResourcesNs from './shadows/shadow-resources';
import * as ShadowVisuals from './shadows/shadow-visuals';
import { useEditor } from '../editor/editor-store';
import { useClient } from './ui/client-store';
import * as Visibility from './visibility';
import * as ModelLighting from './model-lighting';
import type * as VoxelMeshResources from './voxels/voxel-mesh-resources';
import * as VoxelMeshVisuals from './voxels/voxel-mesh-visuals';
import type * as VoxelResourcesNs from './voxels/voxel-resources';
import * as VoxelVisuals from './voxels/voxel-visuals';

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

    /** true if this ClientRoom is the namespace's root */
    isNamespaceRoot: boolean;

    /**
     * true if this room is a client-only room created via `rooms.create`
     * from a client ScriptContext. local rooms have synthetic playerId/roomId
     * (roomId prefixed with `local:`), no server backing, and never emit
     * `set_active_room` pings on activation.
     */
    local: boolean;

    /** scene graph */
    nodes: Nodes.Nodes;

    /** the gpucat scene for this room. contains all renderable objects */
    scene: Scene;

    /** the scripting runtime for this room */
    scriptRuntime: NodesContext;

    /** snapshot of the last scene graph state we sent to the server, for replication diffing. */
    syncSnapshots: ReturnType<typeof Replication.createSyncSnapshots>;

    /** per-room voxel data. always present (may be empty). */
    voxels: Voxels.Voxels;

    /** per-room physics world. always present. */
    physics: Physics.Physics;

    /** per-room game clock (monotonic seconds). advanced by engine-client's
     *  fixed-tick loop; pauses when no tick fires. read via `getTime(ctx)`. */
    clock: Clock.Clock;

    /** per-room client-side chat: command registry, line buffer, UI
     *  subscribers, inbox/outbox queues. drained each frame by Chat.tick. */
    chat: ChatClient;

    /** per-room voxel renderer. always present. owns the per-room voxel
     *  materials internally — they bind the engine-global env buffers
     *  (`state.renderer.environmentResources`) by name. */
    voxelVisuals: VoxelVisuals.VoxelVisuals;

    /** per-room sky + sun/moon/stars/clouds. holds a CPU shadow of the env
     *  config; `setTime`/`setEnvironment` mutate it without touching GPU.
     *  the active room's shadow flushes into the engine-global env buffers
     *  each frame (see `Environment.updateForCamera`), so background rooms
     *  can keep mutating their state with zero GPU traffic. */
    environment: Environment.Environment;

    /** per-room audio coordinator. backed by engine-global
     *  `AudioResources` (one decoded atlas across rooms), but each room
     *  owns its own master gain + active-playback set so per-room
     *  cleanup on disposeRoom is structural. */
    audio: Audio.Audio;

    /** the owned player node, cached at join time. */
    playerNode: Nodes.Node;

    /**
     * default per-room camera node. created at room init with TransformTrait
     * + CameraTrait, parented at the scene root. controllers (builtin or
     * DIY) write pose to its TransformTrait and projection to its CameraTrait
     * by default; bespoke setups can still override by pointing a
     * CameraRefTrait on the control node at a different camera trait.
     *
     * accessible from scripts as `ctx.client.camera`.
     */
    cameraNode: Nodes.Node;

    /**
     * mutable POV state — same object as `ctx.client.control` for every
     * script in this room. `node` defaults to `playerNode` and is swapped
     * by `setControlNode`. each frame `bindRenderCamera` reassigns the
     * scene pass camera to this node's CameraTrait camera; scripts gate
     * input/camera work via `getControlNode(ctx) === ctx.node`.
     */
    control: ControlClientState;

    /**
     * editor lens state — null when no editor lens is up. when present, it's
     * either a real edit room (editorNode === playerNode) or a local-only
     * peek into a play room (editorNode is a `realm: 'client'` node).
     *
     * the same object is plumbed into `editor: true` scripts as
     * `ctx.client.editor`; non-editor scripts never see it. swapping the
     * pointer (null ↔ object) is exclusively driven by the editor lens
     * lifecycle (enter/exit local editor view).
     */
    editor: EditRoomState | null;

    /** locally measured client-side metrics (tick, mesh, physics, net) */
    clientMetrics: Debug.Metrics;

    /** server-side metrics received via room_metrics messages */
    serverMetrics: Debug.Metrics;

    /** client-side log buffer — `log(ctx, ...)` calls in client scripts land here. */
    clientLogs: Debug.Logs;

    /** server-side log buffer — fed by `debug_logs` packets while subscribed. */
    serverLogs: Debug.Logs;

    /** per-room voxel model visuals */
    voxelMeshVisuals: VoxelMeshVisuals.VoxelMeshVisuals;

    /** per-room model visuals (MeshTrait instances). reads from client-global ModelResources. */
    modelVisuals: ModelVisuals.ModelVisuals;

    /** per-room DOM/canvas UI visuals (HtmlTrait + CanvasTrait). */
    domUi: DomUi.DomUi;

    /** per-room sprite visuals (SpriteTrait instances). reads from
     *  client-global SpriteResources; disposed + re-init'd on atlas swap. */
    spriteVisuals: SpriteVisuals.SpriteVisuals;

    /** per-room extruded-sprite visuals (ExtrudedSpriteTrait instances).
     *  batched DII pipeline with a private geometry pool keyed by
     *  spriteId (baked on first reference, refcounted). disposed +
     *  re-init'd on atlas swap alongside spriteVisuals. */
    extrudedSpriteVisuals: ExtrudedSpriteVisuals.ExtrudedSpriteVisuals;

    /** per-room shadow visuals (ShadowCasterTrait instances). batched
     *  ground-disc renderer with per-frame downward raycast — no
     *  external resources, no atlas dependency. */
    shadowVisuals: ShadowVisuals.ShadowVisuals;

    /** per-room particle pool. fixed capacity; spawn fills slots,
     *  `Particles.update` compacts dead ones. advanced per-frame (variable
     *  `delta`) with the room's `voxels` ref so collision primitives can
     *  query the grid. particles are visual fx — framerate-dependent
     *  motion is acceptable; the fixed-step loop is reserved for
     *  simulation that must stay deterministic. */
    particles: Particles.ParticlePool;

    /** per-room particle billboard renderer. reads `particles` directly
     *  each frame (no scene-graph traits). disposed + re-init'd on atlas
     *  swap alongside spriteVisuals. */
    particleVisuals: ParticleVisuals.ParticleVisuals;

    /** per-room visibility (DBVT + frustum cull). model-visuals + voxel-visuals
     *  register leaves and read the per-frame visible set. */
    visibility: Visibility.Visibility;

    /** per-room model lighting — samples voxel light at each visible model's
     *  world-space AABB centroid and writes it into `ModelTrait.light`. Runs
     *  after `Visibility.update` so off-screen models skip the sample. */
    modelLighting: ModelLighting.ModelLighting;

    /** per-room interpolation state — owns the scratch buffers used by
     *  `Interpolation.snapshot` / `Interpolation.interpolate`. participants
     *  are managed via `setInterpolation(node, on)`. */
    interpolation: Interpolation.Interpolation;

    /** per-room animation state — caches the [AnimatorTrait] query consumed by
     *  `Animation.tick`. */
    animations: Animation.Animations;

    /** per-room input data (keys, mouse, deltas). DOM events are routed
     *  here only when this room is active — see `setActivePlayer`. */
    input: Input.Input;

    /** per-room canvas element — each room has its own for DOM event
     *  isolation. */
    canvas: HTMLCanvasElement;

    /** per-room canvas target — wraps the canvas for gpucat rendering. */
    canvasTarget: CanvasTarget;

    /**
     * per-room viewport div — wraps the canvas and any script-attached HTML
     * overlays. mounted into the global viewport div alongside other rooms;
     * only the active room's viewport is `display: block`. removed wholesale
     * on dispose, so overlays don't outlive their room.
     */
    viewport: HTMLDivElement;

    /**
     * per-room touch overlay div — sibling of canvas under `viewport`, mounted
     * after the html UI overlay so it stacks above by DOM order. mobile-controls
     * helpers append their joystick / button roots here. removed with the
     * viewport on dispose.
     */
    touchOverlay: HTMLDivElement;

    /** disposer for the canvas pointer-events touch listeners. called from
     *  `disposeRoom` to release the listeners before the canvas/viewport go. */
    disposeCanvasTouchListeners: () => void;

    /**
     * per-room editor store. Populated by the editor script on init (only
     * for `roomMode === 'edit'`), cleared on dispose. Non-React script
     * callers (fly controller, tools, ...) read it directly — no useEditor
     * import needed. Null on play-only rooms.
     */
    editorStore: EditRoomStoreApi | null;

    /**
     * clipboard handlers — set when this room's editor is active, cleared on
     * deactivate. Page-level `document` listeners (installed once in
     * registerClient) dispatch copy/cut/paste/keydown to the *active* room
     * (`useEditor.getState().room`); rooms whose editor is enabled but not
     * focused hold their handlers without firing.
     */
    editorClipboard: ClipboardHandlers | null;

    /**
     * the engine-global render pipeline this room renders through. all
     * rooms share the same instance — stored here for callers that need
     * the active render camera (`getControlCamera`, editor tools) without
     * threading the engine state through their api.
     */
    _pipeline: Renderer.EngineRenderPipeline;
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

/** prefix used for synthetic local-room ids — server roomIds never collide with this. */
export const LOCAL_ROOM_PREFIX = 'local:';

/* ── RoomView ───────────────────────────────────────────────────── */

/**
 * Opaque id for a `RoomView`. Two flavours flow through the same channel:
 *  - `String(playerId)` for a ClientRoom's player POV
 *  - `room.editor.id` (uuid) for a play-mode ClientRoom's editor-node POV
 * Both are disjoint by construction; callers treat them as opaque.
 */
export type RoomViewId = string;

/**
 * Addressable presentation of a `ClientRoom`. Every ClientRoom yields one
 * RoomView for its player POV; play-mode ClientRooms with `room.editor`
 * set also yield a second RoomView for the editor POV. `mode` mirrors
 * the existing `setRoomView`/`playerToView` vocabulary so the toolbar
 * can dispatch on it directly.
 */
export type RoomView = {
    id: RoomViewId;
    room: ClientRoom;
    mode: PlayerMode;
};

/**
 * Snapshot every ClientRoom into a `RoomView` map. Computed (not stored)
 * so `Rooms` stays the source of truth for `room.editor` / `playerMode`.
 * `syncJoinedPlayers` calls this on the engine-wide rooms set; editor.ts
 * recomputes from `useEditor.allRooms` after enter/exit lens transitions.
 */
export function buildRoomViews(rooms: Iterable<ClientRoom>): Map<RoomViewId, RoomView> {
    const out = new Map<RoomViewId, RoomView>();
    for (const room of rooms) {
        const playerView: RoomView = { id: String(room.playerId), room, mode: room.playerMode };
        out.set(playerView.id, playerView);
        if (room.editor) {
            const editorView: RoomView = { id: room.editor.id, room, mode: 'edit' };
            out.set(editorView.id, editorView);
        }
    }
    return out;
}

/* ── RoomInfo for local rooms ───────────────────────────────────── */

/**
 * Synthesize a `RoomInfo` for a local-only ClientRoom. Local rooms never
 * appear in server room_list messages, so we manufacture their info from
 * the ClientRoom itself and merge it into `useEditor.roomList` at the
 * startLocalRoom/stopLocalRoom edges — making local + server-driven rooms
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
        isNamespaceRoot: room.isNamespaceRoot,
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
    useEditor.getState().setRoomList(merged);
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
        isNamespaceRoot: boolean;
        packedNodes: Uint8Array;
    };
    net: Net.ClientNet;
    rpc: NodesContext['rpc'];
    resources: Resources;
    renderer: Renderer.Renderer;
    modelResources: ModelResourcesNs.ModelResources;
    voxelResources: VoxelResourcesNs.VoxelResources;
    voxelMeshResources: VoxelMeshResources.VoxelMeshResources;
    spriteResources: SpriteResourcesNs.SpriteResources;
    extrudedSpriteResources: ExtrudedSpriteResourcesNs.ExtrudedSpriteResources;
    particleResources: ParticleResourcesNs.ParticleResources;
    cloudResources: CloudResourcesNs.CloudResources;
    shadowResources: ShadowResourcesNs.ShadowResources;
    /** engine-global audio resources. pass through to createRoomCore so
     *  the per-room Audio coordinator can be set up. */
    audioResources: Audio.AudioResources;
    /** inbound trait wire-index for decoding `packedNodes` — server's
     *  outbound table, mirrored on this client. */
    inboundTraitWireIndex: WireIndex;
};

export function createRoom(opts: CreateRoomOptions): ClientRoom {
    const { message } = opts;
    const { clientId, playerId, sceneId, roomId, playerMode, roomMode, namespace, isNamespaceRoot, packedNodes } =
        message;
    const { inboundTraitWireIndex } = opts;

    const { nodes, voxels, physics, clock, chat, scriptRuntime } = newRoomCore({
        resources: opts.resources,
        rpc: opts.rpc,
        roomId,
        playerMode,
        roomMode,
    });

    // server-driven path: unpack the wire payload into the fresh scene
    // graph. voxels arrive separately via voxel chunk messages.
    unpackSceneGraph(nodes, scriptRuntime, packedNodes, inboundTraitWireIndex);
    const playerNode = findPlayerNode(nodes, playerId, roomId);

    return createRoomCore({
        clientId,
        playerId,
        sceneId,
        roomId,
        playerMode,
        roomMode,
        namespace,
        isNamespaceRoot,
        local: false,
        net: opts.net,
        rpc: opts.rpc,
        renderer: opts.renderer,
        resources: opts.resources,
        modelResources: opts.modelResources,
        voxelResources: opts.voxelResources,
        voxelMeshResources: opts.voxelMeshResources,
        spriteResources: opts.spriteResources,
        extrudedSpriteResources: opts.extrudedSpriteResources,
        particleResources: opts.particleResources,
        cloudResources: opts.cloudResources,
        shadowResources: opts.shadowResources,
        audioResources: opts.audioResources,
        nodes,
        voxels,
        physics,
        clock,
        chat,
        scriptRuntime,
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
    isNamespaceRoot: boolean;
    local: boolean;
    net: Net.ClientNet;
    rpc: NodesContext['rpc'];
    resources: Resources;
    renderer: Renderer.Renderer;
    modelResources: ModelResourcesNs.ModelResources;
    voxelResources: VoxelResourcesNs.VoxelResources;
    voxelMeshResources: VoxelMeshResources.VoxelMeshResources;
    spriteResources: SpriteResourcesNs.SpriteResources;
    extrudedSpriteResources: ExtrudedSpriteResourcesNs.ExtrudedSpriteResources;
    particleResources: ParticleResourcesNs.ParticleResources;
    cloudResources: CloudResourcesNs.CloudResources;
    shadowResources: ShadowResourcesNs.ShadowResources;
    audioResources: Audio.AudioResources;
    /**
     * pre-populated room core — sceneGraph, voxels, physics, scriptRuntime
     * built by `newRoomCore` and populated by the caller (wire-unpack,
     * SceneHandle clone, or synthetic), plus the owned player node.
     * createRoomCore wires the post-populate state (CameraTrait, control,
     * runtime hookup) and builds all the visuals.
     */
    nodes: Nodes.Nodes;
    voxels: Voxels.Voxels;
    physics: Physics.Physics;
    clock: Clock.Clock;
    chat: ChatClient;
    scriptRuntime: NodesContext;
    playerNode: Nodes.Node;
};

/**
 * allocate the mutually-dependent core a caller needs *before* populating
 * a fresh room: scene graph, voxels, physics, script runtime. Callers
 * populate these (wire-unpack, SceneHandle clone, or synthetic player
 * node), then hand the bag — plus the discovered/synthesized playerNode —
 * into `createRoomCore` for final assembly.
 *
 * `scriptRuntime.client` is left undefined here; `createRoomCore` fills it
 * after the canvas + scene + control are constructed. Nothing in the
 * populate step reads `.client`.
 */
function newRoomCore(opts: {
    resources: Resources;
    rpc: NodesContext['rpc'];
    roomId: string;
    playerMode: PlayerMode;
    roomMode: RoomMode;
}): {
    nodes: Nodes.Nodes;
    voxels: Voxels.Voxels;
    physics: Physics.Physics;
    clock: Clock.Clock;
    chat: ChatClient;
    scriptRuntime: NodesContext;
} {
    const blocks = registry.blockRegistry;
    const voxels = Voxels.createVoxels(blocks);
    const nodes = Nodes.createSceneGraph({ mode: opts.playerMode, roomMode: opts.roomMode });
    const physics = Physics.init(nodes, voxels, blocks);
    const clock = Clock.init();
    const chat = Chat.init();
    const scriptRuntime: NodesContext = {
        roomId: opts.roomId,
        resources: opts.resources,
        rpc: opts.rpc,
        client: undefined,
        server: undefined,
        voxels,
        physics,
        clock,
        blocks,
        instances: new Map(),
    };
    return { nodes, voxels, physics, clock, chat, scriptRuntime };
}

/**
 * synthesize a player node — mirrors the server's createPlayerNode. used
 * by the local and offline room paths (the wire path receives a serialised
 * player node from the server and just queries for it).
 */
function synthesizePlayerNode(
    nodes: Nodes.Nodes,
    playerId: PlayerId,
    clientId: number,
    name?: string,
): Nodes.Node {
    const playerNode = Nodes.createNode({ name: name ?? `player:${playerId}`, persist: false });
    Nodes.addChild(nodes.root, playerNode);
    Nodes.setOwner(nodes, playerNode, playerId);
    Nodes.addTrait(playerNode, TransformTrait);
    const trait = Nodes.addTrait(playerNode, PlayerTrait);
    trait.playerId = playerId;
    trait.client = clientId;
    return playerNode;
}

/**
 * find the wire-unpacked player node the server created for this Player.
 * shared by initial join (`createRoom`) and resync (`resyncRoom`).
 */
function findPlayerNode(nodes: Nodes.Nodes, playerId: PlayerId, roomId: string): Nodes.Node {
    for (const [trait] of Nodes.query(nodes, [PlayerTrait])) {
        if (trait.playerId === playerId) return trait._node!;
    }
    throw new Error(
        `[bongle] failed to find player node for player ${playerId} in room ${roomId}`,
    );
}

function createRoomCore(opts: CreateRoomCoreOptions): ClientRoom {
    const { clientId, playerId, sceneId, roomId, playerMode, roomMode, namespace, isNamespaceRoot, local } = opts;
    const { nodes, voxels, physics, clock, chat, scriptRuntime, playerNode } = opts;
    const { renderer } = opts;
    const input: Input.Input = Input.createInput();

    const scene = new Scene();
    // env buffers are engine-global (owned by Renderer); per-room env state
    // lives in its own CPU shadow on `Environment` (below) and only flushes
    // to these buffers when this room is the active one.
    const environmentResources = renderer.environmentResources;

    const viewport = document.createElement('div');
    viewport.style.display = 'none';
    viewport.style.position = 'absolute';
    viewport.style.inset = '0';
    viewport.style.pointerEvents = 'none';

    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'auto';
    viewport.appendChild(canvas);
    const canvasTarget = new CanvasTarget(canvas);

    // shared POV pointer — room.control and ctx.client.control are the
    // same object. setControlNode mutates `node` in place so existing
    // closures and ctx-builds observe the swap without re-seating.
    const control: ControlClientState = { node: null };

    // touch overlay sits ABOVE the html overlay added in DomUi.init below.
    // we create the div here (so we can pass it on the runtime client
    // shape) but only append after DomUi.init runs.
    const touchOverlay = document.createElement('div');
    touchOverlay.style.position = 'absolute';
    touchOverlay.style.inset = '0';
    touchOverlay.style.pointerEvents = 'none';

    const disposeCanvasTouchListeners = Input.installCanvasTouchListeners(canvas, input);

    // wire scriptRuntime so addChild/addTrait calls inside createDefaultCameraNode
    // see the runtime (createNode / addTrait register against it).
    nodes.runtime = scriptRuntime;

    // default camera node — TransformTrait + CameraTrait at the scene root.
    // builtin controllers (orbit / fly / player) write to this each frame
    // instead of creating their own. recreated on resyncRoom because
    // unpackSceneGraph wipes root's children.
    const cameraNode = createDefaultCameraNode(nodes, playerNode);

    // every POV-eligible node ships with a CameraRefTrait pre-installed,
    // pointing at the default camera. that keeps "the active camera is
    // wired through the control node" as the visible mental model (inspector
    // shows the wiring on the player node) without making controllers
    // responsible for the wiring themselves. swap target by writing
    // `getTrait(node, CameraRefTrait).camera = otherCameraTrait`.
    seedCameraRef(playerNode, cameraNode);

    scriptRuntime.client = {
        clientId,
        scene,
        control,
        domElement: canvas,
        viewport,
        touchOverlay,
        input,
        player: playerNode,
        camera: cameraNode,
    };

    // Per-room sky + sun/moon/stars/clouds (mesh + per-room CPU
    // shadow). the env GPU buffers in `environmentResources` are engine-
    // global; this Environment's `applyTime`/`applyConfig` mutate the
    // shadow only and flush to GPU when the room is active.
    const environment: Environment.Environment = Environment.init(scene, environmentResources, ENVIRONMENT_DEFAULT, opts.cloudResources);

    // per-room audio coordinator. master gain + active-playback set are
    // owned by the room (disposeRoom tears them down); the underlying
    // AudioContext + decoded atlas are engine-global and reused.
    const audio = Audio.init(opts.audioResources);

    // post-populate wiring. sceneGraph + voxels came in already populated.
    // seed the control pointer at the player node — swappable via setControlNode.
    // initSceneGraph fires onInit/onEnter for instances registered during populate.
    control.node = playerNode;

    // WorldTrait — scene-scoped script host on root. attach after
    // `scriptRuntime.client` is assigned and `control.node` is seeded so
    // the factory's ctx captures a real client ref (script ctx snapshots
    // `runtime.client` at instantiation; if it were undefined here,
    // getControlNode(ctx) would return null forever and POV-gated work
    // like first-person body hiding wouldn't fire).
    attachWorldTrait(nodes.root);

    const syncSnapshots = Replication.createSyncSnapshots();
    const voxelVisuals = VoxelVisuals.initRoomMeshes(scene, opts.voxelResources);
    // metrics seed from the current debugOpen so rooms created mid-session pick
    // up the right state; engine-client's subscription flips them on later toggles.
    const metricsEnabled = useClient.getState().debugOpen;
    const clientMetrics = Debug.createMetrics(metricsEnabled);
    const serverMetrics = Debug.createMetrics(metricsEnabled);
    const clientLogs = Debug.createLogs();
    const serverLogs = Debug.createLogs();

    const voxelMeshVisuals = VoxelMeshVisuals.init(scene, nodes, opts.voxelMeshResources, environmentResources);

    const modelVisuals = ModelVisuals.init(scene, nodes, opts.modelResources, environmentResources);

    const domUi: DomUi.DomUi = DomUi.init(scene, viewport, nodes);

    // append touchOverlay AFTER DomUi.init so it sits visually above
    // html-trait overlays by DOM order alone.
    viewport.appendChild(touchOverlay);

    const spriteVisuals: SpriteVisuals.SpriteVisuals = SpriteVisuals.init(scene, nodes, opts.spriteResources, environmentResources);
    const extrudedSpriteVisuals: ExtrudedSpriteVisuals.ExtrudedSpriteVisuals = ExtrudedSpriteVisuals.init(scene, nodes, opts.extrudedSpriteResources, environmentResources);
    const shadowVisuals: ShadowVisuals.ShadowVisuals = ShadowVisuals.init(scene, nodes, opts.shadowResources);
    const particles = Particles.init();
    const particleVisuals: ParticleVisuals.ParticleVisuals = ParticleVisuals.init(scene, opts.spriteResources, opts.particleResources, environmentResources);

    const visibility = Visibility.init();
    const modelLighting = ModelLighting.init(nodes);
    const interpolation = Interpolation.init(nodes, playerId);
    const animations = Animation.init(nodes);

    const room: ClientRoom = {
        playerId,
        roomId,
        sceneId,
        playerMode,
        roomMode,
        namespace,
        isNamespaceRoot,
        local,
        nodes,
        scene,
        scriptRuntime,
        syncSnapshots,
        voxels,
        physics,
        clock,
        chat,
        voxelVisuals,
        environment,
        audio,
        playerNode,
        cameraNode,
        control,
        // editor lens is opt-in; populated by enterLocalEditorView (or the
        // edit-room flow). seeding null here keeps fresh rooms inert until
        // the user explicitly enters editor view.
        editor: null,
        clientMetrics,
        serverMetrics,
        clientLogs,
        serverLogs,
        voxelMeshVisuals,
        modelVisuals,
        domUi,
        spriteVisuals,
        extrudedSpriteVisuals,
        shadowVisuals,
        particles,
        particleVisuals,
        visibility,
        modelLighting,
        interpolation,
        animations,
        input,
        canvas,
        canvasTarget,
        viewport,
        touchOverlay,
        disposeCanvasTouchListeners,
        editorStore: null,
        editorClipboard: null,
        _pipeline: renderer.pipeline,
    };

    return room;
}

/**
 * apply a fresh server-sent scene graph into an existing ClientRoom in
 * place. used when a join_room message arrives for a player we already
 * hold (e.g. after an `invalidatePlayer` on the server resyncs the room).
 *
 * preserves: scene, canvas (incl. renderer-bound camera on the engine-global pipeline),
 * viewport, voxels, voxelVisuals, physics, scriptRuntime. replaces: the
 * scene graph contents and the playerNode (CameraTrait is re-attached on
 * the fresh playerNode).
 *
 * relies on `unpackSceneGraph` clearing existing children + script
 * instances before rebuilding.
 */
export function resyncRoom(
    room: ClientRoom,
    message: CreateRoomOptions['message'],
    inboundTraitWireIndex: WireIndex,
): void {
    unpackSceneGraph(room.nodes, room.scriptRuntime, message.packedNodes, inboundTraitWireIndex);

    // unpackSceneGraph clears root._traits and rebuilds from the wire,
    // which never carries WorldTrait (persist: false). re-attach so the
    // host script(WorldTrait, …) instances respawn against the fresh graph.
    attachWorldTrait(room.nodes.root);

    const playerNode = findPlayerNode(room.nodes, message.playerId, message.roomId);
    room.playerNode = playerNode;
    // re-seed control to the fresh playerNode. mutate in place so any
    // ctx.client.control references held by surviving scripts observe the swap.
    room.control.node = playerNode;
    // unpackSceneGraph wiped the default camera node along with the rest of
    // root's children — re-create it, re-seed CameraRefTrait on the fresh
    // playerNode, and re-point ctx.client.player / .camera so existing
    // closures see the new nodes.
    room.cameraNode = createDefaultCameraNode(room.nodes, playerNode);
    seedCameraRef(playerNode, room.cameraNode);
    if (room.scriptRuntime.client) {
        room.scriptRuntime.client.camera = room.cameraNode;
        room.scriptRuntime.client.player = playerNode;
    }
    // any local editor lens is invalidated by the scene graph rebuild —
    // editorNode was a `realm: 'client'` node, gone with the wind. caller
    // re-enters via enterLocalEditorView if they want it back.
    room.editor = null;
}

/**
 * build the per-room default camera node. used at room creation and again
 * on resync (since unpackSceneGraph clears the existing tree).
 */
function createDefaultCameraNode(nodes: Nodes.Nodes, playerNode: Nodes.Node): Nodes.Node {
    const node = Nodes.createNode({ name: `${playerNode.name}:camera`, persist: false });
    Nodes.addTrait(node, TransformTrait);
    Nodes.addTrait(node, CameraTrait);
    Nodes.addChild(nodes.root, node);
    return node;
}

/**
 * install a CameraRefTrait on `povNode` pointing at the default camera.
 * call once per POV-eligible node (player node at room init, editor node
 * when an editor lens spins up).
 */
export function seedCameraRef(povNode: Nodes.Node, cameraNode: Nodes.Node): void {
    const cameraTrait = Nodes.getTrait(cameraNode, CameraTrait);
    const ref = Nodes.addTrait(povNode, CameraRefTrait);
    ref.camera = cameraTrait;
}

/**
 * swap the room's POV pointer. mutates `room.control.node` in place so all
 * existing `ctx.client.control` references see the change without re-seating.
 * pass `null` to clear (no control node — input still routes via room.input,
 * but `getControlNode(ctx)` returns null everywhere and rendering bails for
 * this room until a control node is set again).
 *
 * the renderer reads `passNode.camera` each frame; `bindRenderCamera`
 * reassigns it to the active control camera before render — POV swaps need
 * no pipeline rebuild.
 */
export function setControlNode(room: ClientRoom, node: Nodes.Node | null): void {
    room.control.node = node;
}

/**
 * resolve the room's active render camera. reads `CameraRefTrait.camera`
 * on the control node (set by whichever controller — builtin or DIY — is
 * driving the view) and composes the engine-global renderer-owned
 * PerspectiveCamera from (camera node Transform + CameraTrait). returns
 * null when no control node is set, the node has no CameraRefTrait, or
 * the ref has not been pointed at a camera yet.
 *
 * scripts and editor tools call this for pose, fov, and projection
 * (post-`bindRenderCamera` it has the viewport's aspect). the renderer reads
 * the same camera via `passNode.camera` — no separate mirror; what scripts
 * read is what the pass renders. the engine-global pipeline (one shared
 * camera across rooms; pose is rewritten each frame from the active POV)
 * is reached via `room._pipeline`.
 */
export function getControlCamera(room: ClientRoom): PerspectiveCamera | null {
    // controllers may override the active camera by adding a CameraRefTrait
    // on the control node; the default (and most common) path uses the
    // room's default camera node. fall back to it whenever no override is
    // in play so the renderer always has a camera to compose.
    let cameraTrait: CameraTrait | null = null;
    const controlNode = room.control.node;
    if (controlNode) {
        const ref = Nodes.getTrait(controlNode, CameraRefTrait);
        cameraTrait = ref?.camera ?? null;
    }
    if (!cameraTrait) cameraTrait = Nodes.getTrait(room.cameraNode, CameraTrait) ?? null;
    Renderer.syncRenderCamera(room._pipeline, cameraTrait);
    return room._pipeline.camera;
}

/**
 * mount a ClientRoom's viewport into the global canvas div and size its
 * canvas target. camera projection is *not* updated here — the renderer
 * pulls viewport size from canvasTarget each frame in `bindRenderCamera`
 * and writes aspect into the active control camera. caller is responsible
 * for wiring `room.scriptRuntime.client.state`/`.room` and calling
 * `Nodes.initSceneGraph(room.nodes)` after mount.
 */
export function mountRoomViewport(room: ClientRoom): void {
    const viewport = useClient.getState().viewportElement;
    if (!viewport) return;
    viewport.prepend(room.viewport);
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    if (w > 0 && h > 0) {
        room.canvasTarget.setPixelRatio(window.devicePixelRatio);
        room.canvasTarget.setSize(w, h);
    }
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
 * server — no join_room / set_active_room / net_message traffic flows
 * out of them.
 */
export function startLocalRoom(opts: StartLocalRoomOptions): ClientRoom {
    const { state, sceneId, playerMode, roomMode, clientId } = opts;
    const handle = registry.scenes.byId.get(sceneId)?.payload;
    if (!handle) {
        throw new Error(`[bongle] startLocalRoom: scene '${sceneId}' is not declared`);
    }
    if (!handle.client) {
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

    const { nodes, voxels, physics, clock, scriptRuntime, chat } = newRoomCore({
        resources: state.resources,
        rpc: state.rpc,
        roomId,
        playerMode,
        roomMode,
    });

    // copy declared voxels first (may be null if scene has none). must
    // precede loadSceneGraph: any seed scripts that call setBlock on
    // onInit would otherwise be wiped — though runtime isn't wired
    // until after populate, so onInit defers to initSceneGraph anyway.
    if (handle.voxels) {
        Voxels.copyVoxels(voxels, handle.voxels);
    }

    // load the scene from the raw payload so root-level traits land
    // on sceneGraph.root. iterating handle.node.children drops them —
    // server-mirrored rooms bypass this path via loadSceneGraph on
    // disk data; local rooms need the same treatment.
    const payload = state.content.payloads.get(sceneId);
    if (payload) {
        Nodes.loadSceneGraph(nodes, payload.nodes);
    }

    const playerNode = synthesizePlayerNode(nodes, playerId, clientId);

    const room = createRoomCore({
        clientId,
        playerId,
        sceneId,
        roomId,
        playerMode,
        roomMode,
        namespace,
        isNamespaceRoot: false,
        local: true,
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
        nodes: nodes,
        voxels,
        physics,
        clock,
        scriptRuntime,
        chat,
        playerNode,
    });

    mountRoomViewport(room);
    if (room.scriptRuntime.client) {
        room.scriptRuntime.client.state = state;
        room.scriptRuntime.client.room = room;
    }
    Nodes.initSceneGraph(room.nodes);
    rooms.rooms.set(playerId, room);
    useClient.getState().setRoom(playerId, room);
    // append a synthetic RoomInfo so this local room participates in
    // roomList alongside server-driven rooms (tabs, debug, etc.).
    const store = useEditor.getState();
    store.setRoomList([...store.roomList, makeLocalRoomInfo(room)]);
    syncJoinedPlayers(rooms);
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
    disposeRoom(state, room);
    state.rooms.rooms.delete(room.playerId);
    useClient.getState().removeRoom(room.playerId);
    // mirror the registry: drop the synthetic RoomInfo we added in
    // startLocalRoom so this room disappears from roomList too.
    const store = useEditor.getState();
    store.setRoomList(store.roomList.filter((r) => r.id !== room.roomId));
    syncJoinedPlayers(state);
    if (state.activePlayerId === room.playerId) {
        state.activePlayerId = null;
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
 * dispose gpu resources for a room. `state` supplies the engine-global
 * resources a few teardowns need (e.g. the extruded-sprite geometry pool
 * to release this room's refcounts back into).
 */
export function disposeRoom(state: EngineClient, room: ClientRoom): void {
    Physics.dispose(room.physics);
    VoxelVisuals.dispose(room.voxelVisuals, room.scene);
    VoxelMeshVisuals.dispose(room.voxelMeshVisuals, room.scene, room.visibility);
    ModelVisuals.dispose(room.modelVisuals, room.visibility);
    DomUi.dispose(room.domUi);
    SpriteVisuals.dispose(room.spriteVisuals, room.visibility);
    ExtrudedSpriteVisuals.dispose(room.extrudedSpriteVisuals, state.extrudedSpriteResources, room.visibility);
    ShadowVisuals.dispose(room.shadowVisuals);
    ParticleVisuals.dispose(room.particleVisuals);
    Environment.dispose(room.environment);
    // env GPU buffers are engine-global (state.renderer.environmentResources)
    // — not disposed here; they live for the lifetime of the engine.
    Audio.dispose(room.audio);
    room.disposeCanvasTouchListeners();
    room.viewport.remove();
    room.canvasTarget.dispose();
}

/* ── Active player ──────────────────────────────────────────────── */

/** get the active room, or null if none. */
export function getActiveRoom(state: Rooms): ClientRoom | null {
    if (!state.activePlayerId) return null;
    return state.rooms.get(state.activePlayerId) ?? null;
}

/** set the active Player and update the editor store. */
export function setActivePlayer(
    state: Rooms,
    net: Net.ClientNet,
    voxelResources: VoxelResourcesNs.VoxelResources,
    playerId: PlayerId,
): void {
    state.activePlayerId = playerId;
    useClient.getState().setActivePlayerId(playerId);
    const room = state.rooms.get(playerId);
    if (!room) return;

    // engine-global env buffers hold one room's state at a time. on
    // activation, force-push this room's CPU shadow so any rebind
    // matches what its scripts have set (otherwise the previously
    // active room's sky/config would still be on the GPU until the
    // first frame finishes ticking).
    Environment.flushActive(room.environment);

    // engine-global voxel arenas hold one room's chunks at a time. drop
    // the previous occupant and mark every chunk in this room dirty so
    // the prioritised remesh path cycles them back in over the next few
    // frames (sync portion capped by `voxelMainThreadRemeshBudget`,
    // overflow absorbed by the worker pool).
    VoxelVisuals.activateRoom(voxelResources, room.voxelVisuals, room.voxels);

    // toggle viewport visibility — only the active room's viewport (and
    // therefore its canvas + script overlays) is shown.
    for (const r of state.rooms.values()) {
        r.viewport.style.display = r === room ? 'block' : 'none';
    }

    // route DOM input events into the new active room's Input. Inactive
    // rooms see no events — this is what makes inactive scripts read zero
    // input structurally rather than relying on opt-in gates.
    const engineState = room.scriptRuntime.client?.state;
    if (engineState) {
        Input.setInputManagerTarget(engineState.inputManager, room.input);
    }

    // useEditor.room.playerId keys the active per-player store for useEditRoom
    // (which derives from useEditor.playerEditStores[room.playerId]).
    const store = useEditor.getState();
    store.setMode(room.playerMode);
    store.setRoomMode(room.roomMode);
    store.setRoomId(room.roomId);
    store.setSceneId(room.sceneId);
    store.setRoom(room);

    // notify server about active player (presence) — local rooms have no
    // server peer, so suppress the ping.
    if (!room.local) {
        Net.send(net, { type: 'set_active_room', playerId });
    }
}

/* ── Offline rooms ──────────────────────────────────────────────── */

/**
 * create a fully-formed ClientRoom for offline rendering (icon atlas tasks).
 * mirrors `startLocalRoom` (synthetic ids, synthesized player node) but
 * skips viewport mount + scene-graph init — the offline-renderer drives
 * the room directly and never registers it in the rooms map. mode is hardcoded to
 * play so prefab.tick stamps voxels into the world.
 *
 * the room's default render pipeline is unused — offline tasks build
 * their own RenderPipeline per pass via `Renderer.createOfflinePipeline`
 * with a transparent clear so atlas tiles composite cleanly. the env is
 * disabled up-front (sky mesh hidden, voxel skyBrightness pinned) so it
 * doesn't bleed into icon renders.
 */
export function createOfflineRoom(state: EngineClient): ClientRoom {
    const localId = state.rooms.nextLocalId++;
    const playerId: PlayerId = -(localId + 1);
    const roomId = `${LOCAL_ROOM_PREFIX}offline-${localId}`;

    const { nodes, voxels, physics, clock, scriptRuntime, chat } = newRoomCore({
        resources: state.resources,
        rpc: state.rpc,
        roomId,
        playerMode: 'play',
        roomMode: 'play',
    });

    // synthetic player node — required by ClientRoom contract but unused
    // by the offline renderer (no input or movement runs).
    const playerNode = synthesizePlayerNode(nodes, playerId, 0, 'offline-player');

    const room = createRoomCore({
        clientId: 0,
        playerId,
        sceneId: '__offline__',
        roomId,
        playerMode: 'play',
        roomMode: 'play',
        namespace: 'offline',
        isNamespaceRoot: false,
        local: true,
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
        nodes: nodes,
        voxels,
        physics,
        clock,
        scriptRuntime,
        chat,
        playerNode,
    });

    return room;
}

/**
 * destroy all chunks in a room and their gpu meshes. used between
 * offline iterations so each subject starts on an empty world without
 * having to re-init the (expensive) voxel resources.
 */
export function clearRoomVoxels(room: ClientRoom, voxelResources: VoxelResourcesNs.VoxelResources): void {
    for (const [key, chunk] of room.voxels.chunks) {
        Voxels.unlinkChunkNeighbors(chunk);
        VoxelVisuals.removeChunkMesh(voxelResources, key);
    }
    room.voxels.chunks.clear();
}

/**
 * Look up every ClientRoom whose roomId matches (across all Players /
 * modes the client holds in that room). Used by message routing for
 * protocol messages that target a (roomId) without a Player — every
 * matching ClientRoom receives the update.
 */
export function* getRoomsByRoomId(state: Rooms, roomId: string): Generator<ClientRoom> {
    for (const room of state.rooms.values()) {
        if (room.roomId === roomId) yield room;
    }
}

/**
 * Push the list of joined Players into the editor store. The UI tests
 * joined-ness per Player; parallel ClientRooms may share a roomId but
 * differ in mode, each represented by a distinct PlayerId.
 */
export function syncJoinedPlayers(state: Rooms): void {
    const players = [];
    const rooms: ClientRoom[] = [];
    for (const room of state.rooms.values()) {
        players.push({ playerId: room.playerId, roomId: room.roomId, mode: room.playerMode });
        rooms.push(room);
    }
    const store = useEditor.getState();
    store.setJoinedPlayers(players);
    store.setAllRooms(rooms);
    store.setRoomViews(buildRoomViews(state.rooms.values()));
}
