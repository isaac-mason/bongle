// The entire WebGL2 render backend, one file: state + lifecycle, client-global
// resources, active-room visuals, the per-frame render tick, the `create()` handle,
// and the offline icon-baking path (`createOffline`). Composition glue over the
// shared render modules + the CPU voxel producer (`cullEmit`); the `webgpu.ts` twin
// mirrors this with a WebGPURenderer, adapter caps, and a compute `render()`/offline.

import {
    type Camera,
    fxaa,
    type PerspectiveCamera,
    pass,
    RenderPipeline,
    type RenderTarget,
    renderOutput,
    type Scene,
    WebGLRenderer,
} from 'gpucat';
import { ENVIRONMENT_DEFAULT } from '../api/environment';
import * as DomUi from '../client/dom-ui';
import * as Performance from '../client/performance';
import type { ClientRoom, RenderRoomDeps } from '../client/rooms';
import * as Debug from '../core/debug';
import { registry, reindexRegistry } from '../core/registry';
import type { ResourceLoader } from '../core/resource-loader';
import { type Resources as EngineResources, init as initEngineResources } from '../core/resources';
import * as Rpc from '../core/rpc';
import type { Blocks } from '../core/voxels/block-registry';
import type { FrameContext, RenderDeviceCaps, Renderer } from './backend';
import * as RenderCamera from './camera';
import * as CloudResources from './environment/clouds/cloud-resources';
import * as Environment from './environment/environment';
import * as ModelResources from './models/model-resources';
import * as ModelVisuals from './models/model-visuals';
import type { OfflineRenderer } from './offline';
import * as ParticleResources from './particles/particle-resources';
import * as ParticleVisuals from './particles/particle-visuals';
import { createRenderPipeline, type EngineRenderPipeline, setActiveScene, updateCameraEnvironment } from './pipeline';
import * as ShadowResources from './shadows/shadow-resources';
import * as ShadowVisuals from './shadows/shadow-visuals';
import * as ExtrudedSpriteResources from './sprites/extruded-sprite-resources';
import * as ExtrudedSpriteVisuals from './sprites/extruded-sprite-visuals';
import * as SpriteResources from './sprites/sprite-resources';
import * as SpriteVisuals from './sprites/sprite-visuals';
import * as Time from './time';
import * as VoxelArena from './voxels/voxel-arena';
import * as VoxelMeshResources from './voxels/voxel-mesh-resources';
import * as VoxelMeshVisuals from './voxels/voxel-mesh-visuals';
import * as VoxelResources from './voxels/voxel-resources-cpu';
import * as VoxelVisuals from './voxels/voxel-visuals';

/** Which graphics backend this module drives. The backend facade
 *  (`render/backend`) keys off this; the WebGPU twin exports `'webgpu'`. */
export const kind = 'webgl' as const;

/**
 * The WebGL backend state handle — owns ALL of the backend's GPU state, not just
 * the gpucat renderer: the engine-global env buffers + pipeline + render clock, the
 * client-global resource sets (`resources`), and the active room's visual bundle
 * (`active`). `create()` closes over one of these and returns the public `Renderer`
 * handle. (The inner `renderer` field is the gpucat `WebGLRenderer`.)
 *
 * Structurally identical to `WebGpuState`; the only field-level difference is
 * `renderer: WebGLRenderer` and `resources.voxel` being a `VoxelResources`.
 */
export type WebGlState = {
    renderer: WebGLRenderer;
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
    /** client-global GPU resource sets (atlases, materials, CPU voxel frame).
     *  null until `initResources` runs in `engine-client.load()`. */
    resources: BackendResources;
    /** the currently-active room + its GPU visual bundle, or null when no room is
     *  active. Only the active room has visuals and renders (simulation runs for
     *  all rooms). Reconciled to the client's active room at the top of each
     *  `updateFrame`. */
    active: RoomActive | null;
};

/**
 * sync construction: WebGLRenderer + env GPU buffers + render pipeline. gpucat
 * objects defer their actual GL work until `renderer.init()` runs (the WebGL2
 * context is acquired there), so the pipeline can be wired against the buffers up
 * front; only the context handshake stays async (`load`).
 *
 * The renderer creates its own canvas (`opts.canvas` omitted); the active room's
 * canvas target is swapped in each frame via `setCanvasTarget` in `render()`,
 * mirroring the WebGPU backend.
 */
export function init(camera: PerspectiveCamera): WebGlState {
    // No MSAA: antialiasing is done in-pipeline by FXAA (see createRenderPipeline),
    // matching the WebGPU backend.
    const renderer = new WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    const environmentResources = Environment.createEnvironmentResources(ENVIRONMENT_DEFAULT);
    const pipeline = createRenderPipeline(renderer, camera);
    return { renderer, environmentResources, pipeline, timeResources: Time.init(), resources: null!, active: null };
}

/** async context handshake. all GL objects defer their real work until now.
 *  Returns the WebGL2 device's capabilities for the client's perf-tier detect.
 *
 *  WebGL2 has no adapter/storage/compute limits to read, so the caps are derived
 *  from the GL2 context. FLAGGED v1 PLACEHOLDER — tune once measured on real
 *  hardware:
 *   - storage/buffer sizes: the read-only-storage lowering backs each arena with an
 *     `rgba32uint` texture, so the practical storage ceiling ≈ maxTextureSize² × 16
 *     bytes (16 B/texel). Used for both storage-binding and buffer size caps.
 *   - `maxComputeWorkgroupsPerDimension: 0` — WebGL2 has no compute.
 *   - adapterInfo from `WEBGL_debug_renderer_info` (UNMASKED_*), falling back to the
 *     plain `VENDOR`/`RENDERER` strings. */
export async function load(state: WebGlState): Promise<RenderDeviceCaps> {
    await state.renderer.init();

    // WebGL has no `uncapturederror` event (that's a WebGPU-only device event);
    // context loss is surfaced by the renderer's onDeviceLost path instead.

    const gl = state.renderer.gl;
    // read the storage-lowering texel-grid ceiling from the GL2 context. Guaranteed
    // >= 2048 by the WebGL2 spec; fall back to that if the context is somehow absent.
    const maxTextureSize = (gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 0) || 2048;
    // storage() read-lowering tiles a read-only buffer into an rgba32uint texture
    // (16 bytes/texel), so the largest lowerable buffer ≈ maxTextureSize² × 16 B.
    // v1 placeholder — the real per-arena budget wants measuring on the low-end tier.
    const maxArenaBytes = maxTextureSize * maxTextureSize * 16;

    // adapter vendor/renderer via WEBGL_debug_renderer_info UNMASKED_* when exposed;
    // else the plain (often masked/generic) VENDOR/RENDERER strings.
    let vendor = '';
    let description = '';
    if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        vendor = String((dbg && gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) || gl.getParameter(gl.VENDOR) || '');
        description = String((dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
    }

    return {
        maxStorageBufferBindingSize: maxArenaBytes,
        maxBufferSize: maxArenaBytes,
        maxComputeWorkgroupsPerDimension: 0,
        adapterInfo: { vendor, architecture: '', description },
    };
}

/** the per-frame render tick: reconcile the active slot to `activeRoom`, then (if a
 *  room is active) poll the model-resource pools (uploads newly-ready models) + drive
 *  the active room's visuals. Twin of the WebGPU `updateFrame`. */
export function updateFrame(state: WebGlState, activeRoom: ClientRoom | null, ctx: FrameContext): void {
    // reconcile the active slot FIRST, so the model poll + visual drive below key
    // off the freshly-resolved `state.active` and can never touch a stale room.
    reconcile(state, activeRoom);
    if (!state.active) return;
    ModelResources.update(state.resources.model, ctx.resources);
    updateActiveRoom(state, ctx);
}

/** No-op: gpucat's WebGL renderer has no Inspector (the GPU-timing overlay is a
 *  WebGPU concern). Kept to satisfy the `Renderer` contract. */
export function setInspectorVisible(_state: WebGlState, _visible: boolean): void {
    // intentionally empty — no WebGL Inspector.
}

export function resize(state: WebGlState, width: number, height: number) {
    state.renderer.setPixelRatio(window.devicePixelRatio);
    state.renderer.setSize(width, height);
}

/**
 * render the active room through the engine-global pipeline. Twin of the WebGPU
 * `render()` prologue verbatim (camera resolve, canvas-target swap, per-frame env
 * flush, screen tint, pointing the persistent scene-pass at its scene) — but the
 * WebGPU compute block (`updateCull` + `cullDispatches` + `renderer.compute`) is
 * REPLACED by a single CPU `VoxelResources.cullEmit`, which walks the resident sections
 * and writes `mesh.draws` onto the per-room voxel meshes. No `renderer.compute`.
 * No-op when there is no active room.
 */
export function render(state: WebGlState, voxelViewChunkRadius: number): void {
    if (!state.active) return;
    const { room } = state.active;
    // `state.pipeline.camera` is `Renderer.camera`, already resolved to the active
    // room's POV by the client's frame loop (via render/camera) before render.
    const camera = state.pipeline.camera;

    // canvas target, guard avoids redundant reconfigure on the gl side.
    if (state.renderer.getCanvasTarget() !== room.canvasTarget) {
        state.renderer.setCanvasTarget(room.canvasTarget);
    }

    // drive the shared render clock first so every time-driven consumer this
    // frame sees the same value.
    Time.tick(state.timeResources, performance.now() / 1000);

    // env flush + screen tint: the active camera defines what world context the
    // post-chain sees this frame.
    updateCameraEnvironment(state.pipeline, room.voxels, camera);
    Environment.updateForCamera(
        state.active.visuals.env,
        room.environment,
        state.environmentResources,
        state.resources.cloud,
        camera,
        state.timeResources,
    );

    // point the engine-global pass at this room's scene before render,
    // the pipeline graph is shared, only `passNode.scene` rotates.
    setActiveScene(state.pipeline, room.scene, room.overlayScene);

    // WebGL voxel producer: CPU frustum + per-facing cone-cull → `mesh.draws` on
    // the per-room voxel meshes. Replaces the WebGPU compute cull/emit chain; no
    // GPU dispatch and no per-frame buffer upload.
    VoxelResources.cullEmit(state.resources.voxel, state.active.visuals.voxel, camera, voxelViewChunkRadius);

    state.pipeline.pipeline.render();
}

/** tear down the active room's visuals (reconcile-to-empty), then the gpucat
 *  renderer + its gl resources. The client-global resource sets are disposed
 *  separately (`disposeResources`). */
export function dispose(state: WebGlState): void {
    teardown(state);
    state.renderer.dispose();
}

/**
 * HMR (block registry / atlas change): swap the voxel + voxel-mesh resources and
 * rebuild the active room's voxel visuals against them, remounting its world.
 * Returns whether the resources swapped.
 */
export async function refreshBlockResources(
    state: WebGlState,
    opts: {
        blockRegistry: Blocks;
        voxelBudget: VoxelArena.VoxelArenaBudget;
        settings: Performance.Settings;
        resources: EngineResources;
    },
): Promise<boolean> {
    const changed = await swapVoxelResources(state, opts);
    if (changed && state.active) {
        rebuildVoxelVisuals(state, state.active.room);
    }
    return changed;
}

/**
 * HMR (sprite atlas change): swap the sprite resources and rebuild the active
 * room's extruded-sprite visuals. Returns whether the atlas changed.
 */
export async function refreshSpriteResources(state: WebGlState, opts: { resources: EngineResources }): Promise<boolean> {
    const changed = await swapSpriteResources(state, opts);
    if (changed && state.active) {
        rebuildExtrudedSpriteVisuals(state, state.active.room);
    }
    return changed;
}

/**
 * Mint the WebGL backend: construct its internal {@link WebGlState} and return the
 * public {@link Renderer} handle bound over it. Every method closes over the one
 * `state`, so the client drives rendering through the handle and never touches
 * backend internals. Twin of the WebGPU `create()`.
 */
// ═══════════════ offline (WebGL: browser-worker icon baking) ═══════════════

/** headless twin of `init` for the browser-worker icon renderer. A 1x1
 *  OffscreenCanvas supplies the WebGL2 context; all output goes to a RenderTarget
 *  (gpucat draws targets larger than the canvas), so there is no window/DOM ref. */
function initHeadless(camera: PerspectiveCamera): WebGlState {
    const renderer = new WebGLRenderer({ antialias: false, canvas: new OffscreenCanvas(1, 1) });
    const environmentResources = Environment.createEnvironmentResources(ENVIRONMENT_DEFAULT);
    const pipeline = createRenderPipeline(renderer, camera);
    return { renderer, environmentResources, pipeline, timeResources: Time.init(), resources: null!, active: null };
}

/** offline scene→FXAA→output pipeline for a fixed scene+camera. Twin of the WebGPU
 *  `createOfflinePipeline`; the WebGL renderer honours `renderer.renderTarget`. */
export function createOfflinePipeline(state: WebGlState, scene: Scene, camera: Camera): RenderPipeline {
    const scenePass = pass(scene, camera, { clearColor: [0, 0, 0, 0] });
    const fxaaPass = fxaa(scenePass.getTextureNode());
    const outputNode = renderOutput(fxaaPass);
    return new RenderPipeline(state.renderer, outputNode);
}

/** render `scene` (via a caller-owned offline `pipeline`) into `target`. The WebGL
 *  voxel producer is the CPU `cullEmit`: it walks the resident sections and writes
 *  `mesh.draws` onto `voxelVisuals`' per-pass meshes (no compute dispatch). Restores
 *  the prior render target. Twin of the WebGPU `renderRoomToTarget`, minus compute. */
function renderRoomToTarget(
    state: WebGlState,
    voxelResources: VoxelResources.VoxelResources,
    voxelVisuals: VoxelVisuals.VoxelVisuals,
    scene: Scene,
    camera: Camera,
    target: RenderTarget,
    pipeline: RenderPipeline,
    voxelViewChunkRadius: number,
): void {
    const savedTarget = state.renderer.renderTarget;
    state.renderer.renderTarget = target;
    scene.updateWorldMatrix();
    Time.tick(state.timeResources, performance.now() / 1000);
    VoxelResources.cullEmit(voxelResources, voxelVisuals, camera, voxelViewChunkRadius);
    pipeline.render();
    state.renderer.renderTarget = savedTarget;
}

/**
 * Stand up the WebGL offline backend (the icon-baking `OfflineRenderer`). Always
 * makes its own WebGL2 context — an injected device is WebGPU/Dawn and is routed
 * to the WebGPU backend by `loadOfflineBackend`, so `gpu` is ignored here.
 */
export async function createOffline(_gpu?: { device: GPUDevice; adapter: GPUAdapter }): Promise<OfflineRenderer> {
    const state = initHeadless(RenderCamera.createCamera());
    const caps = await load(state);
    const performance = Performance.detect(caps);
    const budget = VoxelArena.voxelArenaBudgetForTier(performance);
    const offline: OfflineRenderer = {
        kind,
        caps,
        performance,
        budget,
        rebuildDeps: (loader) => buildOfflineDeps(state, offline, budget, loader),
        createPipeline: (scene, camera) => createOfflinePipeline(state, scene, camera),
        renderToTarget: (deps, room, camera, target, pipeline, radius) =>
            // deps built by this backend's buildOfflineDeps → voxelResources is the cpu type.
            renderRoomToTarget(
                state,
                deps.voxelResources as VoxelResources.VoxelResources,
                room.voxelVisuals,
                room.scene,
                camera,
                target,
                pipeline,
                radius,
            ),
        readTarget: (target) => state.renderer.readRenderTargetPixels(target),
        dispose: () => dispose(state),
    };
    return offline;
}

/**
 * Build a `RenderRoomDeps` (+ teardown) for the offline icon room against the live
 * registry + just-baked assets. Twin of the WebGPU `buildOfflineDeps` with the CPU
 * voxel producer (`voxel-resources-cpu`, no compute pipelines). Returns render-ready
 * deps: awaits the atlas upload so the bakers never gate on readiness themselves.
 */
async function buildOfflineDeps(
    state: WebGlState,
    offline: OfflineRenderer,
    budget: VoxelArena.VoxelArenaBudget,
    loader: ResourceLoader,
): Promise<{ deps: RenderRoomDeps; dispose: () => void }> {
    // this path doesn't call engine-client.load(), so rebuild the derived index
    // fields from the (baked) registrations before reading the block registry.
    reindexRegistry(registry);

    const resources = initEngineResources(loader, 'client');
    const rpc = Rpc.init({ send() {}, broadcast() {} });

    const cloudResources = CloudResources.init(state.environmentResources);
    const modelResources = ModelResources.init(state.environmentResources);
    const voxelResources = VoxelResources.init(registry.blockRegistry, state.environmentResources, budget, state.timeResources);
    const voxelMeshResources = VoxelMeshResources.init(
        voxelResources.atlas,
        voxelResources.texAnimBuffer,
        state.timeResources,
        state.environmentResources,
    );

    // workerCount=0 → synchronous remesh (icons mesh inline via meshChunk). The CPU
    // producer has no compute to pre-warm, so atlas readiness is the only gate.
    await VoxelResources.load(voxelResources, registry.blockRegistry, 0, 0, resources);
    await voxelResources.atlasReady;

    const deps: RenderRoomDeps = {
        resources,
        rpc,
        environmentResources: state.environmentResources,
        offline,
        voxelResources,
        voxelMeshResources,
        modelResources,
        cloudResources,
    };
    const disposeDeps = (): void => {
        VoxelResources.dispose(voxelResources);
        VoxelMeshResources.dispose(voxelMeshResources);
        ModelResources.dispose(modelResources);
        CloudResources.dispose(cloudResources);
    };
    return { deps, dispose: disposeDeps };
}

export function create(): Renderer {
    const camera = RenderCamera.createCamera();
    const state = init(camera);
    return {
        kind,
        camera,
        load: () => load(state),
        dispose: () => dispose(state),
        resize: (w, h) => resize(state, w, h),
        setInspectorVisible: (v) => setInspectorVisible(state, v),
        time: state.timeResources,
        initResources: (o) => initResources(state, o),
        loadResources: (o) => loadResources(state, o),
        disposeResources: () => disposeResources(state),
        updateFrame: (activeRoom, ctx) => updateFrame(state, activeRoom, ctx),
        render: (radius) => render(state, radius),
        refreshBlockResources: (o) => refreshBlockResources(state, o),
        refreshSpriteResources: (o) => refreshSpriteResources(state, o),
    };
}

// ═══════════════ client-global resources (was resources.ts) ═══════════════

/** the eight client-global GPU resource sets, owned by the backend. The `voxel`
 *  set is the WebGL CPU frame; every other set is shared with the WebGPU backend. */
export type BackendResources = {
    sprite: SpriteResources.SpriteResources;
    extrudedSprite: ExtrudedSpriteResources.ExtrudedSpriteResources;
    particle: ParticleResources.ParticleResources;
    cloud: CloudResources.CloudResources;
    model: ModelResources.ModelResources;
    shadow: ShadowResources.ShadowResources;
    voxel: VoxelResources.VoxelResources;
    voxelMesh: VoxelMeshResources.VoxelMeshResources;
};

/**
 * sync construction of every resource set. pure (no awaits, no fetches): builds
 * materials against the magenta placeholder atlas so the downstream extruded/
 * particle inits can name-bind it immediately. The async atlas fetches happen in
 * `loadResources`. Sets `renderer.resources`. Only `voxel` differs from WebGPU:
 * it builds a `VoxelResources` (no compute) via `VoxelResources.init`.
 */
export function initResources(
    renderer: WebGlState,
    opts: { blockRegistry: Blocks; voxelBudget: VoxelArena.VoxelArenaBudget },
): void {
    const sprite = SpriteResources.init(renderer.environmentResources);
    const extrudedSprite = ExtrudedSpriteResources.init(sprite, renderer.environmentResources);
    const particle = ParticleResources.init(sprite.atlas, renderer.environmentResources);
    const cloud = CloudResources.init(renderer.environmentResources);
    const model = ModelResources.init(renderer.environmentResources);
    const shadow = ShadowResources.init();
    const voxel = VoxelResources.init(
        opts.blockRegistry,
        renderer.environmentResources,
        opts.voxelBudget,
        renderer.timeResources,
    );
    const voxelMesh = VoxelMeshResources.init(
        voxel.atlas,
        voxel.texAnimBuffer,
        renderer.timeResources,
        renderer.environmentResources,
    );
    renderer.resources = { sprite, extrudedSprite, particle, cloud, model, shadow, voxel, voxelMesh };
}

/**
 * async load pass: fetches the real sprite/voxel atlases (the placeholder keeps
 * materials valid meanwhile) + spawns the voxel mesh worker pool. Both extruded
 * and particle materials captured a TextureNode against the placeholder atlas
 * during init; `SpriteResources.load` swaps the placeholder out, so re-bind them
 * after. No compute pipelines to pre-warm (the WebGL voxel producer is CPU-side).
 * Audio is NOT here — it's not a render resource; engine-client races it.
 */
export async function loadResources(
    renderer: WebGlState,
    opts: { blockRegistry: Blocks; settings: Performance.Settings; resources: EngineResources },
): Promise<void> {
    const r = renderer.resources;
    await Promise.all([
        SpriteResources.load(r.sprite, opts.resources.loader, opts.resources.spriteAtlas),
        VoxelResources.load(
            r.voxel,
            opts.blockRegistry,
            opts.settings.voxelWorkerCount,
            opts.settings.voxelWorkerQueueDepth,
            opts.resources,
        ),
    ]);
    ExtrudedSpriteResources.rebindAtlas(r.extrudedSprite, r.sprite.atlas);
    ParticleResources.rebindAtlas(r.particle, r.sprite.atlas);
}

/**
 * HMR: re-fetch block atlas + rebuild voxel resources (and voxel-mesh resources,
 * which bind the atlas + texAnim). Resource level only — returns whether the
 * resources actually swapped, so `./index` can rebuild each room's voxel visuals.
 */
export async function swapVoxelResources(
    renderer: WebGlState,
    opts: {
        blockRegistry: Blocks;
        voxelBudget: VoxelArena.VoxelArenaBudget;
        settings: Performance.Settings;
        resources: EngineResources;
    },
): Promise<boolean> {
    const r = renderer.resources;
    const { resources: nextVoxel, changed } = await VoxelResources.refresh(
        r.voxel,
        opts.blockRegistry,
        renderer.environmentResources,
        opts.voxelBudget,
        renderer.timeResources,
        opts.settings.voxelWorkerCount,
        opts.settings.voxelWorkerQueueDepth,
        opts.resources,
    );
    r.voxel = nextVoxel;

    // voxelMeshResources binds the engine-global atlas + texAnim, so it must
    // rebuild alongside voxelResources whenever those swap.
    if (changed) {
        VoxelMeshResources.dispose(r.voxelMesh);
        r.voxelMesh = VoxelMeshResources.init(
            r.voxel.atlas,
            r.voxel.texAnimBuffer,
            renderer.timeResources,
            renderer.environmentResources,
        );
    }
    return changed;
}

/**
 * HMR: re-fetch the sprite atlas, rebind the extruded + particle materials that
 * hold their own TextureNodes against it, and wipe the extruded silhouette pool
 * (every bake is stale). Returns whether the atlas changed, so `./index` can
 * rebuild each room's extruded-sprite visuals.
 */
export async function swapSpriteResources(renderer: WebGlState, opts: { resources: EngineResources }): Promise<boolean> {
    const r = renderer.resources;
    const changed = await SpriteResources.refresh(r.sprite, opts.resources.loader, opts.resources.spriteAtlas);
    if (!changed) return false;
    ExtrudedSpriteResources.rebindAtlas(r.extrudedSprite, r.sprite.atlas);
    ParticleResources.rebindAtlas(r.particle, r.sprite.atlas);
    ExtrudedSpriteResources.clearGeometryPool(r.extrudedSprite);
    return true;
}

/** dispose the client-global resources. mirrors the WebGPU dispose order;
 *  modelResources has no dispose (matches WebGPU behaviour). */
export function disposeResources(renderer: WebGlState): void {
    const r = renderer.resources;
    if (!r) return;
    ShadowResources.dispose(r.shadow);
    CloudResources.dispose(r.cloud);
    VoxelMeshResources.dispose(r.voxelMesh);
    VoxelResources.dispose(r.voxel);
    ParticleResources.dispose(r.particle);
    ExtrudedSpriteResources.dispose(r.extrudedSprite);
    SpriteResources.dispose(r.sprite);
}

// ═══════════════ active-room visuals (was room-visuals.ts) ═══════════════

/** the active room's GPU visual sets. */
export type RoomVisuals = {
    voxel: VoxelVisuals.VoxelVisuals;
    voxelMesh: VoxelMeshVisuals.VoxelMeshVisuals;
    model: ModelVisuals.ModelVisuals;
    domUi: DomUi.DomUi;
    sprite: SpriteVisuals.SpriteVisuals;
    extrudedSprite: ExtrudedSpriteVisuals.ExtrudedSpriteVisuals;
    shadow: ShadowVisuals.ShadowVisuals;
    particle: ParticleVisuals.ParticleVisuals;
    /** env render state (sky/sun/moon/star meshes + cloud anchor). driven each
     *  frame from the active room's client-side `environment` config. */
    env: Environment.EnvVisuals;
};

/** the active slot: the room + its visuals, plus the `scene`/`visibility` handles
 *  teardown needs captured up front so it never depends on the room outliving it. */
export type RoomActive = {
    room: ClientRoom;
    scene: ClientRoom['scene'];
    visibility: ClientRoom['visibility'];
    visuals: RoomVisuals;
};

/**
 * Reconcile the active slot to `activeRoom` (the client's source of truth). When it
 * differs from the currently-held room: tear the old one down, then build the new
 * one (null → just teardown). A no-op when already matching. Called at the top of
 * every `updateFrame`, so all downstream per-frame work keys off the reconciled
 * `state.active` and can never touch a stale room.
 */
export function reconcile(state: WebGlState, activeRoom: ClientRoom | null): void {
    if ((state.active?.room ?? null) === activeRoom) return;
    teardown(state);
    if (activeRoom) state.active = build(state, activeRoom);
}

/**
 * Build the active room's visual bundle from its scene graph (`scene` /
 * `overlayScene` / `nodes` / `viewport`) + the backend's client-global resources +
 * env buffers + pipeline, mount its world into the single-world voxel arena (marks
 * chunks dirty so the prioritised remesh path refills it), and force-push its env
 * config into the engine-global env UBOs. Returns the slot.
 */
function build(state: WebGlState, room: ClientRoom): RoomActive {
    const res = state.resources;
    const { scene, overlayScene, nodes } = room;

    const voxel = VoxelVisuals.initRoomMeshes(scene, res.voxel);
    const voxelMesh = VoxelMeshVisuals.init(res.voxelMesh.batch, scene, nodes);
    const model = ModelVisuals.init(res.model.batch, scene, nodes);
    // CanvasTrait quads render in the overlay scene (crisp, post-fxaa); HtmlTrait
    // panels are DOM. the scene depth node lets canvas materials discard fragments
    // occluded by world geometry.
    const domUi = DomUi.init(overlayScene, room.viewport, nodes, state.pipeline.sceneDepthNode);
    const sprite = SpriteVisuals.init(res.sprite.batch, scene, nodes);
    const extrudedSprite = ExtrudedSpriteVisuals.init(res.extrudedSprite.batch, scene, nodes);
    const shadow = ShadowVisuals.init(res.shadow.batch, scene, nodes);
    const particle = ParticleVisuals.init(res.particle.batch, scene, res.sprite);
    // env render state: sky/sun/moon/star meshes + cloud anchor, drawn with the
    // engine-global env + cloud resources. The room's env *config* is client data
    // (`room.environment`) the renderer reads each frame.
    const env = Environment.initEnvVisuals(scene, state.environmentResources, res.cloud);

    const visuals: RoomVisuals = { voxel, voxelMesh, model, domUi, sprite, extrudedSprite, shadow, particle, env };

    // mount this room's world into the single-world arena + push its env so any
    // rebind this frame matches what its scripts set.
    VoxelVisuals.mountRoom(voxel, room.voxels);
    Environment.flushActive(room.environment, state.environmentResources);

    return { room, scene, visibility: room.visibility, visuals };
}

/**
 * Dispose the active room's visual bundle, release its world's arena chunks, and
 * clear the active slot. No-op when nothing is active. Uses the slot's captured
 * `scene`/`visibility`, so it stays correct even when the room was already torn
 * down (a leave reconciles on the next frame; `dispose()` calls this at shutdown).
 */
export function teardown(state: WebGlState): void {
    if (!state.active) return;
    const { scene, visibility, visuals: rv } = state.active;
    VoxelVisuals.dispose(rv.voxel, scene);
    // release the active world's chunks from the arena + mesh worker cache.
    VoxelVisuals.unmountRoom(state.resources.voxel);
    VoxelMeshVisuals.dispose(rv.voxelMesh, state.resources.voxelMesh.batch, visibility);
    ModelVisuals.dispose(rv.model, state.resources.model.batch, visibility);
    DomUi.dispose(rv.domUi);
    SpriteVisuals.dispose(rv.sprite, state.resources.sprite.batch, visibility);
    ExtrudedSpriteVisuals.dispose(
        rv.extrudedSprite,
        state.resources.extrudedSprite.batch,
        state.resources.extrudedSprite,
        visibility,
    );
    ShadowVisuals.dispose(rv.shadow, state.resources.shadow.batch);
    ParticleVisuals.dispose(rv.particle, state.resources.particle.batch);
    Environment.disposeEnvVisuals(rv.env);
    state.active = null;
}

/**
 * per-frame update of the active room's visuals. Order + Debug labels mirror the
 * WebGPU frame loop exactly. The mesher + arena metrics always run (it's always
 * the active room — its world is the one resident in the arena). Reads the
 * client-resolved POV camera from `ctx`; no-op when there is no active room or its
 * POV camera isn't resolved (no active CameraTrait).
 */
export function updateActiveRoom(state: WebGlState, ctx: FrameContext): void {
    if (!state.active) return;
    const povCamera = ctx.povCamera;
    if (!povCamera) return;
    const { room, visuals: rv } = state.active;
    const res = state.resources;

    Debug.begin(room.clientMetrics, 'mesh');
    // streaming rooms defer meshing a chunk until its 26-neighbourhood has
    // arrived (mesh once, correct AO/light); local rooms load all at once so
    // there's no trickle to dedupe — mesh immediately.
    VoxelVisuals.update(rv.voxel, res.voxel, room.voxels, room.voxels.registry, povCamera.position, !room.local);
    Debug.end(room.clientMetrics, 'mesh');

    // arena occupancy + fragmentation, recorded post-update so the sample
    // reflects this frame's allocs.
    if (room.clientMetrics.enabled) {
        const quadR = VoxelArena.arenaReport(res.voxel.arenas.quadArena);
        Debug.record(room.clientMetrics, 'voxels/arena/quad/usedPct', (100 * quadR.used) / quadR.slotCount, '%');
        Debug.record(room.clientMetrics, 'voxels/arena/quad/largestFreePct', (100 * quadR.largestFree) / quadR.slotCount, '%');
        Debug.record(room.clientMetrics, 'voxels/arena/quad/allocs', quadR.allocs, 'count');
    }

    Debug.begin(room.clientMetrics, 'voxel-mesh');
    VoxelMeshVisuals.update(rv.voxelMesh, res.voxelMesh.batch, room.voxels, room.visibility);
    Debug.end(room.clientMetrics, 'voxel-mesh');

    Debug.begin(room.clientMetrics, 'model');
    ModelVisuals.update(rv.model, res.model.batch, res.model, ctx.resources, room.visibility);
    Debug.end(room.clientMetrics, 'model');

    Debug.begin(room.clientMetrics, 'dom-ui');
    DomUi.update(rv.domUi, povCamera, ctx.viewport);
    Debug.end(room.clientMetrics, 'dom-ui');

    Debug.begin(room.clientMetrics, 'sprite');
    SpriteVisuals.update(rv.sprite, res.sprite.batch, res.sprite, room.voxels, povCamera, room.visibility);
    Debug.end(room.clientMetrics, 'sprite');

    Debug.begin(room.clientMetrics, 'extruded-sprite');
    ExtrudedSpriteVisuals.update(rv.extrudedSprite, res.extrudedSprite.batch, res.extrudedSprite, room.voxels, room.visibility);
    Debug.end(room.clientMetrics, 'extruded-sprite');

    Debug.begin(room.clientMetrics, 'shadow');
    ShadowVisuals.update(rv.shadow, res.shadow.batch, room.voxels, povCamera);
    Debug.end(room.clientMetrics, 'shadow');

    // particle visuals reads pool[0..count) directly, no scene-graph traits. runs
    // after Particles.update (per-frame loop) so freshly-stepped positions feed
    // this frame's pose buffer.
    Debug.begin(room.clientMetrics, 'particle');
    ParticleVisuals.update(rv.particle, res.particle.batch, room.particles, room.voxels, ctx.now);
    Debug.end(room.clientMetrics, 'particle');
}

/**
 * HMR: rebuild the active room's voxel + voxel-mesh visuals against freshly-swapped
 * resources. The engine-global arenas/geometries/materials moved to the new
 * `state.resources.voxel`/`voxelMesh`; the old meshes still point at the disposed
 * ones, so drop + re-init. No-op when `room` isn't the active room.
 */
export function rebuildVoxelVisuals(state: WebGlState, room: ClientRoom): void {
    if (!state.active || state.active.room !== room) return;
    const rv = state.active.visuals;
    VoxelVisuals.dispose(rv.voxel, room.scene);
    VoxelMeshVisuals.dispose(rv.voxelMesh, state.resources.voxelMesh.batch, room.visibility);
    rv.voxel = VoxelVisuals.initRoomMeshes(room.scene, state.resources.voxel);
    rv.voxelMesh = VoxelMeshVisuals.init(state.resources.voxelMesh.batch, room.scene, room.nodes);
    // the refresh blew away the previous arena (new packer is empty), so re-mount:
    // marks the room's chunks dirty and the prioritised remesh path refills it.
    VoxelVisuals.mountRoom(rv.voxel, room.voxels);
}

/**
 * HMR: rebuild the active room's extruded-sprite visuals after the sprite atlas
 * swapped. Its alive states hold now-dangling GeometrySlot refs into the cleared
 * pool; dropping them lets next frame's update lazily re-acquire into the fresh
 * pool. No-op when `room` isn't the active room.
 */
export function rebuildExtrudedSpriteVisuals(state: WebGlState, room: ClientRoom): void {
    if (!state.active || state.active.room !== room) return;
    const rv = state.active.visuals;
    ExtrudedSpriteVisuals.dispose(
        rv.extrudedSprite,
        state.resources.extrudedSprite.batch,
        state.resources.extrudedSprite,
        room.visibility,
    );
    rv.extrudedSprite = ExtrudedSpriteVisuals.init(state.resources.extrudedSprite.batch, room.scene, room.nodes);
}
