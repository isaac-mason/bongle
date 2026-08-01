import {
    type Camera,
    type ComputeDispatch,
    fxaa,
    Inspector,
    type PerspectiveCamera,
    pass,
    RenderPipeline,
    type RenderTarget,
    renderOutput,
    type Scene,
    WebGPURenderer,
} from 'gpucat';
import { ENVIRONMENT_DEFAULT } from '../../api/environment';
import { CameraTrait } from '../../builtins/camera';
import * as Performance from '../../client/performance';
import type { ClientRoom } from '../../client/rooms';
import type { Resources as EngineResources } from '../../core/resources';
import { getTrait } from '../../core/scene/scene-tree';
import type { Blocks } from '../../core/voxels/block-registry';
import type { Renderer } from '../backend';
import * as RenderCamera from '../common/camera';
import * as Environment from '../common/environment/environment';
import * as ModelResources from '../common/models/model-resources';
import { createRenderPipeline, type EngineRenderPipeline, setActiveScene, updateCameraEnvironment } from '../common/pipeline';
import type { SpriteResources } from '../common/sprites/sprite-resources';
import * as Time from '../common/time';
import * as VoxelArena from '../common/voxels/voxel-arena';
import * as Resources from './resources';
import * as RoomVisuals from './room-visuals';
import * as VoxelResources from './voxels/gpu-frame';

// the backend's resource + per-room-visual surface is part of this module's
// public API (engine-client drives it through the backend handle).
export * from './resources';
export * from './room-visuals';

/** Which graphics backend this module drives. The backend facade
 *  (`render/common/backend`) keys off this; the WebGL twin exports `'webgl'`. */
export const kind = 'webgpu' as const;

/**
 * The WebGPU backend state handle — owns ALL of the backend's GPU state, not just
 * the gpucat renderer: the engine-global env buffers + pipeline + render clock, the
 * client-global resource sets (`resources`), and the per-room visual bundles
 * (`rooms`). `create()` closes over one of these and returns the public `Renderer`
 * handle; the offline icon paths use it directly. (The inner `renderer` field is
 * the gpucat `WebGPURenderer`.)
 */
export type WebGpuState = {
    renderer: WebGPURenderer;
    /** engine-global env GPU buffers, one set across the whole engine,
     *  flushed each frame from the active room's CPU shadow (see
     *  `Environment.updateForCamera`). every env-aware shader (sky, voxel,
     *  model, sprite, cloud) binds these by name through its per-room
     *  geometry. */
    environmentResources: Environment.EnvironmentResources;
    /** engine-global render pipeline, one set across all rooms; the active
     *  room swaps in via `setActiveScene` each frame. */
    pipeline: EngineRenderPipeline;
    /** shared render clock; its `elapsedTime` node is threaded into every
     *  time-driven shader graph, and `render()` advances it each frame. */
    timeResources: Time.TimeResources;
    /** client-global GPU resource sets (atlases, materials, cull computes).
     *  null until `initResources` runs in `engine-client.load()`. */
    resources: Resources.BackendResources;
    /** per-room visual bundles, keyed by the `ClientRoom` object. populated by
     *  `createRoomVisuals`, drained by `disposeRoomVisuals`. */
    rooms: Map<ClientRoom, RoomVisuals.RoomVisuals>;
};

/**
 * sync construction, WebGPURenderer + env GPU buffers + render pipeline.
 * gpucat objects defer their actual GPU work until `renderer.init()` runs,
 * so the pipeline can be wired against the buffers up front; only the
 * device handshake stays async (`load`).
 *
 * No Inspector is constructed at boot, `setInspectorVisible(true)` lazily
 * builds one on first show and disposes it when hidden (full teardown of
 * GPU resources, DOM, and window listeners).
 */
export function init(): WebGpuState {
    // No MSAA: antialiasing is done in-pipeline by FXAA (see createRenderPipeline).
    // MSAA would allocate multisample+resolve targets whose sizes must track the
    // swapchain across pixel-ratio changes — needless cost for a post-process AA path.
    const renderer = new WebGPURenderer({ antialias: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    const environmentResources = Environment.createEnvironmentResources(ENVIRONMENT_DEFAULT);
    const pipeline = createRenderPipeline(renderer);
    return { renderer, environmentResources, pipeline, timeResources: Time.init(), resources: null!, rooms: new Map() };
}

/**
 * headless twin of `init`, for a render context with no canvas or `window`
 * (the pipeline worker's in-worker icon renderer). Takes a pre-created device +
 * adapter — gpucat's headless mode skips the canvas/adapter handshake and every
 * output goes through a `RenderTarget` (see `renderRoomToTarget`). No pixel
 * ratio / size to set (those throw in headless).
 */
export function initHeadless(gpu: { device: GPUDevice; adapter: GPUAdapter }): WebGpuState {
    const renderer = new WebGPURenderer({
        // No MSAA — the offline/icon pipeline antialiases via FXAA (createOfflinePipeline).
        antialias: false,
        headless: true,
        device: gpu.device,
        adapter: gpu.adapter,
        format: 'rgba8unorm',
    });
    const environmentResources = Environment.createEnvironmentResources(ENVIRONMENT_DEFAULT);
    const pipeline = createRenderPipeline(renderer);
    return { renderer, environmentResources, pipeline, timeResources: Time.init(), resources: null!, rooms: new Map() };
}

/** async device handshake. all GPU objects defer their real work until now. */
export async function load(state: WebGpuState): Promise<void> {
    await state.renderer.init();

    // catch the specific buffer that fails: chromebook prints the validation
    // message before APICreateErrorBuffer but doesn't tag the buffer; this
    // surfaces the offender. cheap to leave on; one log per uncaptured error.
    const dev = state.renderer.device as GPUDevice | undefined;
    if (dev) {
        dev.addEventListener('uncapturederror', (e) => {
            console.error('[webgpu] uncaptured error:', (e as GPUUncapturedErrorEvent).error.message);
        });
    }
}

/** detect the GPU performance tier from the resolved adapter (post-`load`). */
export function detectPerformance(state: WebGpuState): Performance.Profile {
    return Performance.detect(state.renderer.adapter);
}

/** per-frame poll of the model-resource pools (uploads newly-ready models). */
export function updateModelResources(state: WebGpuState, resources: EngineResources): void {
    ModelResources.update(state.resources.model, resources);
}

/** drop a chunk's mesh from the voxel arena (edit path). */
export function removeChunkMesh(state: WebGpuState, key: string): void {
    VoxelArena.removeChunkMesh(state.resources.voxel.arenas, key);
}

/** the client-global sprite resources, or null before `initResources` runs. */
export function spriteResources(state: WebGpuState): SpriteResources | null {
    return state.resources?.sprite ?? null;
}

/** force-push a room's env config into the engine-global env UBOs (on activation). */
export function flushRoomEnv(state: WebGpuState, room: ClientRoom): void {
    Environment.flushActive(room.environment, state.environmentResources);
}

/**
 * resolve the room's live render camera: compose the engine-global pipeline camera
 * from the room's active CameraTrait (pose/fov), bind the viewport aspect from its
 * canvas target, and return it. idempotent — a deterministic copy of the camera
 * node's world pose + canvas size into the shared pipeline camera. Null when the
 * room has no active POV camera.
 */
export function getRenderCamera(state: WebGpuState, room: ClientRoom): PerspectiveCamera | null {
    const cameraTrait = getTrait(room.client.camera, CameraTrait) ?? null;
    RenderCamera.syncRenderCamera(state.pipeline, cameraTrait);
    RenderCamera.bindRenderCamera(state.pipeline, room.canvasTarget);
    return state.pipeline.camera;
}

/**
 * Install or remove the gpucat Inspector overlay. Driven each frame by
 * debugOpen + debugTab. Idempotent: only acts on edges, so the per-frame
 * call is a cheap identity check when state hasn't changed.
 *
 * On show: constructs a fresh Inspector, mounts the panel to document.body,
 * attaches it via `setInspector`, then docks/opens it. The body mount happens
 * first on purpose: the renderer's active canvas target belongs to a room
 * `viewport` div (pointer-events:none), and Inspector.setRenderer would
 * self-attach the unparented panel there, making it visible but click-dead.
 *
 * On hide: `setInspector(null)` triggers the Inspector's dispose path which
 * tears down GPU query resources, removes the DOM, drops window listeners,
 * and clears detached tab panels.
 */
export function setInspectorVisible(state: WebGpuState, visible: boolean): void {
    const isOn = state.renderer.inspector instanceof Inspector;
    if (visible === isOn) return;

    if (visible) {
        const inspector = new Inspector();

        // Mount on document.body BEFORE attaching to the renderer. Inspector
        // .setRenderer self-attaches the panel to `renderer.domElement.parentElement`
        // whenever the panel isn't already parented. The engine-global renderer's
        // active canvas target is the current room's `viewport` div, which is
        // `pointer-events: none` — so a self-attach there leaves the whole
        // inspector visible (z-index 1000 still paints on top) but dead to clicks,
        // inheriting pointer-events:none. Pre-parenting on body makes the
        // self-attach a no-op and keeps the panel interactive.
        document.body.appendChild(inspector.domElement);
        state.renderer.setInspector(inspector);

        const profiler = inspector.profiler;
        if (profiler.position !== 'bottom') profiler.setPosition('bottom');
        if (!profiler.panel.classList.contains('visible')) profiler.togglePanel();
    } else {
        state.renderer.setInspector(null);
    }
}

/**
 * transparent-clear pipeline for offline tasks (icon atlases). callers
 * supply a per-pass camera so each subject can be framed independently.
 * skips screen tint, icons composite against a neutral background.
 */
export function createOfflinePipeline(state: WebGpuState, scene: Scene, camera: Camera): RenderPipeline {
    const scenePass = pass(scene, camera, { clearColor: [0, 0, 0, 0] });
    const fxaaPass = fxaa(scenePass.getTextureNode());
    const outputNode = renderOutput(fxaaPass);
    return new RenderPipeline(state.renderer, outputNode);
}

/**
 * Render a scene into an offscreen `RenderTarget`. The reusable core behind every
 * offscreen render — e.g. an icon/thumbnail subject read back to pixels in the
 * headless pipeline. The scene's chunks must already be resident (mounted) in the
 * (single-world) arena. `pipeline` is built once per target via
 * `createOfflinePipeline(state, scene, camera)` and reused; the caller owns its
 * lifetime. The renderer's prior render target is restored on exit, so this
 * composes cleanly before/after the main canvas pass.
 */
export function renderRoomToTarget(
    state: WebGpuState,
    voxelResources: VoxelResources.VoxelResources,
    scene: Scene,
    camera: Camera,
    target: RenderTarget,
    pipeline: RenderPipeline,
    voxelViewChunkRadius: number,
): void {
    const savedTarget = state.renderer.renderTarget;
    state.renderer.renderTarget = target;
    try {
        // cull the arena + run the voxel computes, render.
        VoxelResources.updateCull(voxelResources, camera, voxelViewChunkRadius);
        const dispatches: ComputeDispatch[] = [];
        for (const disp of VoxelResources.cullDispatches(voxelResources)) dispatches.push(disp);
        scene.updateWorldMatrix();
        Time.tick(state.timeResources, performance.now() / 1000);
        if (dispatches.length > 0) state.renderer.compute(dispatches);
        pipeline.render();
    } finally {
        state.renderer.renderTarget = savedTarget;
    }
}

export function resize(state: WebGpuState, width: number, height: number) {
    state.renderer.setPixelRatio(window.devicePixelRatio);
    state.renderer.setSize(width, height);
}

/**
 * render the given room through the engine-global pipeline. encapsulates
 * everything that must happen for the active room: canvas-target swap,
 * per-frame env flush (CPU shadow → engine-global GPU buffers), screen
 * tint, pointing the persistent scene-pass at this room's scene, and the
 * cull computes + pipeline.render.
 *
 * the engine-global render pipeline is built once at boot and reused for
 * every active room, only `passNode.scene` (and the camera + env buffer
 * contents) rotate per frame.
 */
export function render(state: WebGpuState, room: ClientRoom, voxelViewChunkRadius: number): void {
    // resolve + bind this room's render camera here (encapsulated), so the client
    // hands us only the room + view radius, never a camera it extracted itself.
    const camera = getRenderCamera(state, room);
    const voxelResources = state.resources.voxel;

    // canvas target, guard avoids redundant reconfigure on the gpu side.
    if (state.renderer.getCanvasTarget() !== room.canvasTarget) {
        state.renderer.setCanvasTarget(room.canvasTarget);
    }

    // drive the shared render clock first so every time-driven consumer this
    // frame (GPU shaders via elapsedTime, cloud drift via seconds) sees the
    // same value. gpucat no longer ticks time itself.
    Time.tick(state.timeResources, performance.now() / 1000);

    // env flush + screen tint, only the active camera defines what world
    // context the post-chain should see this frame. when camera is null
    // (e.g. boot before a POV camera is bound) we still render whatever the
    // pipeline last saw, the room will compose with stale env, which is
    // fine for the rare null window.
    if (camera) {
        updateCameraEnvironment(state.pipeline, room.voxels, camera);
        // env: the room's config is client data (`room.environment`); its render
        // state (meshes/clouds) is the backend's per-room `rv.env`, flushed into
        // the engine-global env + cloud resources for the active room.
        const rv = state.rooms.get(room);
        if (rv) {
            Environment.updateForCamera(
                rv.env,
                room.environment,
                state.environmentResources,
                state.resources.cloud,
                camera,
                state.timeResources,
            );
        }
        // prepare the GPU cull: pre-shift the frustum planes camera-relative
        // and reset the per-frame cull/emit counters. The cull + per-facing
        // emit computes themselves are queued below via `cullDispatches`.
        VoxelResources.updateCull(voxelResources, camera, voxelViewChunkRadius);
    }

    // point the engine-global pass at this room's scene before render,
    // the pipeline graph is shared, only `passNode.scene` rotates.
    setActiveScene(state.pipeline, room.scene, room.overlayScene);

    const dispatches: ComputeDispatch[] = [];

    // voxel GPU cull + per-facing emit: 1 cull dispatch + 3 indirect emit
    // dispatches (opaque/transparent/translucent) that write the per-quad
    // visibleQuads the VS reads. Empty when no chunks are resident.
    for (const disp of VoxelResources.cullDispatches(voxelResources)) dispatches.push(disp);

    state.renderer.compute(dispatches);
    state.pipeline.pipeline.render();
}

/** tear down the gpucat renderer and release its gpu resources. The client-global
 *  resource sets + per-room visuals are disposed separately (`disposeResources`,
 *  `disposeRoomVisuals`) by the caller. */
export function dispose(state: WebGpuState): void {
    state.renderer.dispose();
}

/**
 * HMR (block registry / atlas change): swap the voxel + voxel-mesh resources and
 * rebuild every room's voxel visuals against them, remounting the active room. The
 * per-room voxel *data* (registry pointer + chunk resolve) is the caller's concern.
 * Returns whether the resources actually swapped.
 */
export async function refreshBlockResources(
    state: WebGpuState,
    opts: {
        blockRegistry: Blocks;
        voxelBudget: VoxelArena.VoxelArenaBudget;
        settings: Performance.Settings;
        resources: EngineResources;
    },
    activeRoom: ClientRoom | null,
): Promise<boolean> {
    const changed = await Resources.swapVoxelResources(state, opts);
    if (changed) {
        for (const room of state.rooms.keys()) RoomVisuals.rebuildVoxelVisuals(state, room);
        // the refresh blew away the previous arena (new packer is empty), so
        // re-mount the active room; its chunks mark dirty and the prioritised
        // remesh path refills the arena over the next few frames.
        if (activeRoom) RoomVisuals.mountRoom(state, activeRoom);
    }
    return changed;
}

/**
 * HMR (sprite atlas change): swap the sprite resources (rebinding the extruded +
 * particle materials, clearing the silhouette pool) and rebuild every room's
 * extruded-sprite visuals. Returns whether the atlas changed.
 */
export async function refreshSpriteResources(state: WebGpuState, opts: { resources: EngineResources }): Promise<boolean> {
    const changed = await Resources.swapSpriteResources(state, opts);
    if (changed) {
        for (const room of state.rooms.keys()) RoomVisuals.rebuildExtrudedSpriteVisuals(state, room);
    }
    return changed;
}

/**
 * Mint the WebGPU backend: construct its internal {@link WebGpuState} and return
 * the public {@link Renderer} handle bound over it. Every method closes over the
 * one `state`, so the client drives rendering through the handle and never touches
 * backend internals. The individual functions stay exported above for the
 * WebGPU-pinned offline paths (icon baking) that call them directly.
 */
export function create(): Renderer {
    const state = init();
    return {
        kind,
        load: () => load(state),
        dispose: () => dispose(state),
        resize: (w, h) => resize(state, w, h),
        setInspectorVisible: (v) => setInspectorVisible(state, v),
        detectPerformance: () => detectPerformance(state),
        renderClock: () => state.timeResources,
        initResources: (o) => Resources.initResources(state, o),
        loadResources: (o) => Resources.loadResources(state, o),
        disposeResources: () => Resources.disposeResources(state),
        updateModelResources: (r) => updateModelResources(state, r),
        removeChunkMesh: (k) => removeChunkMesh(state, k),
        spriteResources: () => spriteResources(state),
        createRoomVisuals: (room) => RoomVisuals.createRoomVisuals(state, room),
        disposeRoomVisuals: (room) => RoomVisuals.disposeRoomVisuals(state, room),
        updateRoom: (room, ctx) => RoomVisuals.updateRoom(state, room, ctx),
        mountRoom: (room) => RoomVisuals.mountRoom(state, room),
        unmountRoom: () => RoomVisuals.unmountRoom(state),
        flushRoomEnv: (room) => flushRoomEnv(state, room),
        getRenderCamera: (room) => getRenderCamera(state, room),
        render: (room, radius) => render(state, room, radius),
        refreshBlockResources: (o, activeRoom) => refreshBlockResources(state, o, activeRoom),
        refreshSpriteResources: (o) => refreshSpriteResources(state, o),
    };
}
