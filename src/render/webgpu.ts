// The entire WebGPU render backend, one file: state + lifecycle, client-global
// resources, active-room visuals, the per-frame render tick, offline icon baking,
// and the `create()` handle. Composition + lifecycle glue over the shared render
// modules + the WebGPU voxel producer (compute cull/emit); the sibling `webgl.ts`
// mirrors it with the CPU `cullEmit` producer in place of compute.

import {
    type Camera,
    type ComputeDispatch,
    fxaa,
    Inspector,
    type PerspectiveCamera,
    pass,
    RenderPipeline,
    type RenderTarget,
    readPixels,
    renderOutput,
    type Scene,
    WebGPURenderer,
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
import * as VoxelResources from './voxels/voxel-resources-gpu';
import * as VoxelVisuals from './voxels/voxel-visuals';

export const kind = 'webgpu' as const;

// ═══════════════ state + lifecycle ═══════════════

export type WebGpuState = {
    renderer: WebGPURenderer;
    environmentResources: Environment.EnvironmentResources;
    pipeline: EngineRenderPipeline;
    timeResources: Time.TimeResources;
    resources: BackendResources;
    active: RoomActive | null;
};

export function init(camera: PerspectiveCamera): WebGpuState {
    const renderer = new WebGPURenderer({ antialias: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    const environmentResources = Environment.createEnvironmentResources(ENVIRONMENT_DEFAULT);
    const pipeline = createRenderPipeline(renderer, camera);
    return { renderer, environmentResources, pipeline, timeResources: Time.init(), resources: null!, active: null };
}

/** headless twin of `init` for the Node WebGPU icon renderer (no canvas/window). */
export function initHeadless(gpu: { device: GPUDevice; adapter: GPUAdapter }): WebGpuState {
    const renderer = new WebGPURenderer({
        antialias: false,
        headless: true,
        device: gpu.device,
        adapter: gpu.adapter,
        format: 'rgba8unorm',
    });
    const environmentResources = Environment.createEnvironmentResources(ENVIRONMENT_DEFAULT);
    const pipeline = createRenderPipeline(renderer, RenderCamera.createCamera());
    return { renderer, environmentResources, pipeline, timeResources: Time.init(), resources: null!, active: null };
}

/** async device handshake; returns the adapter's caps for the client's perf-tier detect. */
export async function load(state: WebGpuState): Promise<RenderDeviceCaps> {
    await state.renderer.init();
    const dev = state.renderer.device as GPUDevice | undefined;
    if (dev) {
        dev.addEventListener('uncapturederror', (e) => {
            console.error('[webgpu] uncaptured error:', (e as GPUUncapturedErrorEvent).error.message);
        });
    }
    const { adapter } = state.renderer;
    const info = adapter.info;
    return {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
        maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
        adapterInfo: {
            vendor: (info?.vendor as string) ?? '',
            architecture: (info?.architecture as string) ?? '',
            description: (info?.description as string) ?? '',
        },
    };
}

export function resize(state: WebGpuState, width: number, height: number): void {
    state.renderer.setPixelRatio(window.devicePixelRatio);
    state.renderer.setSize(width, height);
}

/** Toggle the gpucat Inspector overlay (WebGPU GPU-timing panel); lazily attached
 *  on first show, detached on hide. */
export function setInspectorVisible(state: WebGpuState, visible: boolean): void {
    if (visible) {
        if (!state.renderer.inspector) state.renderer.setInspector(new Inspector());
    } else if (state.renderer.inspector) {
        state.renderer.setInspector(null);
    }
}

/** the per-frame render tick: reconcile the active slot, then (if a room is active)
 *  poll the model pools + drive the active room's visuals. */
export function updateFrame(state: WebGpuState, activeRoom: ClientRoom | null, ctx: FrameContext): void {
    reconcile(state, activeRoom);
    if (!state.active) return;
    ModelResources.update(state.resources.model, ctx.resources);
    updateActiveRoom(state, ctx);
}

/** render the active room. Draws with `state.pipeline.camera` (resolved by the client
 *  before this call); queues the voxel compute cull/emit then runs the pipeline. */
export function render(state: WebGpuState, voxelViewChunkRadius: number): void {
    if (!state.active) return;
    const { room } = state.active;
    const camera = state.pipeline.camera;
    const voxelResources = state.resources.voxel;

    if (state.renderer.getCanvasTarget() !== room.canvasTarget) {
        state.renderer.setCanvasTarget(room.canvasTarget);
    }

    Time.tick(state.timeResources, performance.now() / 1000);

    updateCameraEnvironment(state.pipeline, room.voxels, camera);
    Environment.updateForCamera(
        state.active.visuals.env,
        room.environment,
        state.environmentResources,
        state.resources.cloud,
        camera,
        state.timeResources,
    );
    VoxelResources.updateCull(voxelResources, camera, voxelViewChunkRadius);

    setActiveScene(state.pipeline, room.scene, room.overlayScene);

    const dispatches: ComputeDispatch[] = [];
    for (const disp of VoxelResources.cullDispatches(voxelResources)) dispatches.push(disp);

    state.renderer.compute(dispatches);
    state.pipeline.pipeline.render();
}

/** tear down the active room's visuals (reconcile-to-empty), then the gpucat renderer. */
export function dispose(state: WebGpuState): void {
    teardown(state);
    state.renderer.dispose();
}

/** HMR (block/atlas change): swap voxel resources + rebuild the active room's voxel visuals. */
export async function refreshBlockResources(
    state: WebGpuState,
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

/** HMR (sprite atlas change): swap sprite resources + rebuild the active room's extruded-sprite visuals. */
export async function refreshSpriteResources(state: WebGpuState, opts: { resources: EngineResources }): Promise<boolean> {
    const changed = await swapSpriteResources(state, opts);
    if (changed && state.active) {
        rebuildExtrudedSpriteVisuals(state, state.active.room);
    }
    return changed;
}

// ═══════════════ offline (WebGPU-only: Node WebGPU icon baking) ═══════════════

export function createOfflinePipeline(state: WebGpuState, scene: Scene, camera: Camera): RenderPipeline {
    const scenePass = pass(scene, camera, { clearColor: [0, 0, 0, 0] });
    const fxaaPass = fxaa(scenePass.getTextureNode());
    const outputNode = renderOutput(fxaaPass);
    return new RenderPipeline(state.renderer, outputNode);
}

/** render `scene` (via a caller-owned offline `pipeline`) into `target`, queuing the
 *  voxel compute for `voxelResources` first. Restores the prior render target. */
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
    VoxelResources.updateCull(voxelResources, camera, voxelViewChunkRadius);
    const dispatches: ComputeDispatch[] = [];
    for (const disp of VoxelResources.cullDispatches(voxelResources)) dispatches.push(disp);
    scene.updateWorldMatrix();
    Time.tick(state.timeResources, performance.now() / 1000);
    if (dispatches.length > 0) state.renderer.compute(dispatches);
    pipeline.render();
    state.renderer.renderTarget = savedTarget;
}

/** Stand up the WebGPU offline backend (the `OfflineRenderer` handle behind
 *  `render/offline`'s `loadOfflineBackend`). Device is injected (Node Dawn) or
 *  requested from `navigator.gpu` (browser worker). Wraps the offline functions
 *  above + `readPixels` into the backend-neutral contract. */
export async function createOffline(gpu?: { device: GPUDevice; adapter: GPUAdapter }): Promise<OfflineRenderer> {
    let device: GPUDevice;
    let adapter: GPUAdapter;
    if (gpu) {
        ({ device, adapter } = gpu);
    } else {
        if (typeof navigator === 'undefined' || !navigator.gpu) {
            throw new Error('[webgpu offline] WebGPU unavailable here (no navigator.gpu)');
        }
        const requested = await navigator.gpu.requestAdapter();
        if (!requested) throw new Error('[webgpu offline] no GPU adapter');
        adapter = requested;
        device = await adapter.requestDevice();
    }
    const state = initHeadless({ device, adapter });
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
            // deps built by this backend's buildOfflineDeps → voxelResources is the gpu type.
            renderRoomToTarget(
                state,
                deps.voxelResources as VoxelResources.VoxelResources,
                room.scene,
                camera,
                target,
                pipeline,
                radius,
            ),
        readTarget: (target) => readPixels(state.renderer, target),
        dispose: () => dispose(state),
    };
    return offline;
}

/**
 * Build a `RenderRoomDeps` (+ teardown) for the offline icon room, against the
 * realm's live registry and the just-baked assets read through `loader`. Rebuilt
 * per bake so the voxel atlas reflects the latest baked textures; the persistent
 * `state` renderer/device is reused. Arena index 0 is free (no live world room).
 */
async function buildOfflineDeps(
    state: WebGpuState,
    offline: OfflineRenderer,
    budget: VoxelArena.VoxelArenaBudget,
    loader: ResourceLoader,
): Promise<{ deps: RenderRoomDeps; dispose: () => void }> {
    // this path doesn't call engine-client.load(), so rebuild the derived index
    // fields from the (baked) registrations before reading the block registry.
    reindexRegistry(registry);

    const resources = initEngineResources(loader, 'client');
    // no net in a headless render room; a `local:` room's send no-ops anyway.
    const rpc = Rpc.init({ send() {}, broadcast() {} });

    const cloudResources = CloudResources.init(state.environmentResources);
    const modelResources = ModelResources.init(state.environmentResources);
    const voxelResources = VoxelResources.init(registry.blockRegistry, state.environmentResources, budget, state.timeResources);
    const voxelMeshResources = VoxelMeshResources.init(
        voxelResources.textures.atlas,
        voxelResources.textures.texAnimBuffer,
        state.timeResources,
        state.environmentResources,
    );

    // workerCount=0 → synchronous remesh (icons mesh inline via meshChunk); still
    // fetches + decodes the baked atlas. rebuildDeps returns render-ready deps: wait
    // for the atlas upload AND the voxel compute pipelines to compile (WebGPU-only —
    // the offline render dispatches them), so the bakers never gate on it themselves.
    await VoxelResources.load(voxelResources, registry.blockRegistry, 0, 0, resources, state.renderer);
    await Promise.all([voxelResources.textures.ready, voxelResources.computeReady]);

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

// ═══════════════ the handle ═══════════════

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

/** the eight client-global GPU resource sets, owned by the backend. */
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
 * materials + cull computes against the magenta placeholder atlas so the
 * downstream extruded/particle inits can name-bind it immediately. The async
 * atlas fetches happen in `loadResources`. Sets `renderer.resources`.
 */
export function initResources(
    renderer: WebGpuState,
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
        voxel.textures.atlas,
        voxel.textures.texAnimBuffer,
        renderer.timeResources,
        renderer.environmentResources,
    );
    renderer.resources = { sprite, extrudedSprite, particle, cloud, model, shadow, voxel, voxelMesh };
}

/**
 * async load pass: pre-warms compile pipelines + fetches the real sprite/voxel
 * atlases (the placeholder keeps materials valid meanwhile). Both extruded and
 * particle materials captured a TextureNode against the placeholder atlas during
 * init; `SpriteResources.load` swaps the placeholder out, so re-bind them after.
 * Audio is NOT here — it's not a render resource; engine-client races it.
 */
export async function loadResources(
    renderer: WebGpuState,
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
            renderer.renderer,
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
    renderer: WebGpuState,
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
        renderer.renderer,
    );
    r.voxel = nextVoxel;

    // voxelMeshResources binds the engine-global atlas + texAnim, so it must
    // rebuild alongside voxelResources whenever those swap.
    if (changed) {
        VoxelMeshResources.dispose(r.voxelMesh);
        r.voxelMesh = VoxelMeshResources.init(
            r.voxel.textures.atlas,
            r.voxel.textures.texAnimBuffer,
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
export async function swapSpriteResources(renderer: WebGpuState, opts: { resources: EngineResources }): Promise<boolean> {
    const r = renderer.resources;
    const changed = await SpriteResources.refresh(r.sprite, opts.resources.loader, opts.resources.spriteAtlas);
    if (!changed) return false;
    ExtrudedSpriteResources.rebindAtlas(r.extrudedSprite, r.sprite.atlas);
    ParticleResources.rebindAtlas(r.particle, r.sprite.atlas);
    ExtrudedSpriteResources.clearGeometryPool(r.extrudedSprite);
    return true;
}

/** dispose the client-global resources. mirrors the prior engine-client dispose
 *  order; modelResources has no dispose (matches prior behaviour). */
export function disposeResources(renderer: WebGpuState): void {
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
export function reconcile(state: WebGpuState, activeRoom: ClientRoom | null): void {
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
function build(state: WebGpuState, room: ClientRoom): RoomActive {
    const res = state.resources;
    const { scene, overlayScene, nodes } = room;

    const voxel = VoxelVisuals.initRoomMeshes(scene, res.voxel.geometries, res.voxel.quadMaterials);
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
export function teardown(state: WebGpuState): void {
    if (!state.active) return;
    const { scene, visibility, visuals: rv } = state.active;
    VoxelVisuals.dispose(rv.voxel, scene);
    // release the active world's chunks from the arena + mesh worker cache.
    VoxelVisuals.unmountRoom(state.resources.voxel.arenas, state.resources.voxel.meshDispatcher);
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
 * old engine-client frame loop exactly. The mesher + arena metrics always run
 * (it's always the active room — its world is the one resident in the arena).
 * Reads the client-resolved POV camera from `ctx`; no-op when there is no active
 * room or its POV camera isn't resolved (no active CameraTrait).
 */
export function updateActiveRoom(state: WebGpuState, ctx: FrameContext): void {
    if (!state.active) return;
    const povCamera = ctx.povCamera;
    if (!povCamera) return;
    const { room, visuals: rv } = state.active;
    const res = state.resources;

    Debug.begin(room.clientMetrics, 'mesh');
    // streaming rooms defer meshing a chunk until its 26-neighbourhood has
    // arrived (mesh once, correct AO/light); local rooms load all at once so
    // there's no trickle to dedupe — mesh immediately.
    VoxelVisuals.update(rv.voxel, res.voxel.arenas, res.voxel.meshDispatcher, room.voxels, povCamera.position, !room.local);
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
export function rebuildVoxelVisuals(state: WebGpuState, room: ClientRoom): void {
    if (!state.active || state.active.room !== room) return;
    const rv = state.active.visuals;
    VoxelVisuals.dispose(rv.voxel, room.scene);
    VoxelMeshVisuals.dispose(rv.voxelMesh, state.resources.voxelMesh.batch, room.visibility);
    rv.voxel = VoxelVisuals.initRoomMeshes(room.scene, state.resources.voxel.geometries, state.resources.voxel.quadMaterials);
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
export function rebuildExtrudedSpriteVisuals(state: WebGpuState, room: ClientRoom): void {
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
