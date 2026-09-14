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
    type Texture,
    texture,
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
import * as MeshResources from './mesh/mesh-resources';
import * as MeshVisuals from './mesh/mesh-visuals';
import type { OfflineRenderer, TileTarget } from './offline';
import * as ParticleResources from './particles/particle-resources';
import * as ParticleVisuals from './particles/particle-visuals';
import {
    createRenderPipeline,
    type EngineRenderPipeline,
    rebuildRenderPipelineIfStale,
    setActiveScene,
    updateCameraEnvironment,
} from './pipeline';
import * as ShadowResources from './shadows/shadow-resources';
import * as ShadowVisuals from './shadows/shadow-visuals';
import * as ExtrudedSpriteResources from './sprites/extruded-sprite-resources';
import * as ExtrudedSpriteVisuals from './sprites/extruded-sprite-visuals';
import * as SpriteResources from './sprites/sprite-resources';
import * as SpriteVisuals from './sprites/sprite-visuals';
import * as Time from './time';
import { flushMeshQueue, meshQueueStats, readMeshPerf } from './voxels/mesher';
import * as VoxelAoi from './voxels/voxel-aoi';
import * as VoxelArena from './voxels/voxel-arena';
import * as VoxelLightSample from './voxels/voxel-light-sample';
import * as VoxelLightVolume from './voxels/voxel-light-volume';
import * as VoxelMeshResources from './voxels/voxel-mesh-resources';
import * as VoxelMeshVisuals from './voxels/voxel-mesh-visuals';
import * as VoxelResources from './voxels/voxel-resources-gpu';
import * as VoxelVisuals from './voxels/voxel-visuals';

/** Per-frame CPU budget for rebaking light tiles; a time budget rather than a tile count so it self-calibrates on slower devices. */
const LIGHT_BAKE_BUDGET_MS = 1.5;

export const kind = 'webgpu' as const;

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
    return {
        renderer,
        environmentResources,
        pipeline,
        timeResources: Time.init(),
        resources: null!,
        active: null,
    };
}

/** Headless twin of `init` for the Node WebGPU icon renderer (no canvas/window). */
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
    return {
        renderer,
        environmentResources,
        pipeline,
        timeResources: Time.init(),
        resources: null!,
        active: null,
    };
}

/** Async device handshake; returns the adapter's caps for the client's perf-tier detect. */
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

export function resize(state: WebGpuState, width: number, height: number, pixelRatio: number): void {
    state.renderer.setPixelRatio(pixelRatio);
    state.renderer.setSize(width, height);
}

/** Toggles the gpucat Inspector overlay; lazily attached on first show, detached on hide. */
export function setInspectorVisible(state: WebGpuState, visible: boolean): void {
    if (visible) {
        if (!state.renderer.inspector) {
            const inspector = new Inspector();
            state.renderer.setInspector(inspector);
            // The inspector self-attaches its shell into the shared canvas' parent; pointer-events inherits, so reassert it.
            inspector.domElement.style.pointerEvents = 'auto';
        }
    } else if (state.renderer.inspector) {
        state.renderer.setInspector(null);
    }
}

/** Reconciles the active slot, then polls the model pools and drives the active room's visuals. */
export function updateFrame(state: WebGpuState, activeRoom: ClientRoom | null, ctx: FrameContext): void {
    reconcile(state, activeRoom);
    if (!state.active) return;
    MeshResources.update(state.resources.model, ctx.resources);
    updateActiveRoom(state, ctx);
}

/** Renders the active room, draws with `state.pipeline.camera`, queues the voxel compute cull/emit, then runs the pipeline. */
export function render(state: WebGpuState, voxelViewChunkRadius: number): void {
    if (!state.active) return;
    // A game's `setRenderPipeline` may have re-declared the stages since the last frame; rebuild ahead of `setActiveScene`.
    rebuildRenderPipelineIfStale(state.pipeline);
    const { room } = state.active;
    const camera = state.pipeline.camera;
    const voxelResources = state.resources.voxel;

    Time.tick(state.timeResources, performance.now() / 1000);

    updateCameraEnvironment(state.pipeline, room.voxels, camera);
    Environment.updateForCamera(
        state.active.visuals.env,
        room.environment,
        state.environmentResources,
        state.resources.cloud,
        camera,
        state.timeResources,
        voxelViewChunkRadius,
    );
    VoxelResources.updateCull(voxelResources, camera, voxelViewChunkRadius);

    setActiveScene(state.pipeline, room.render.scene, room.render.overlayScene);

    const dispatches: ComputeDispatch[] = [];
    for (const disp of VoxelResources.cullDispatches(voxelResources)) dispatches.push(disp);

    state.renderer.compute(dispatches);

    state.pipeline.pipeline.render();
}

/** Tears down the active room's visuals, then the gpucat renderer. */
export function dispose(state: WebGpuState): void {
    teardown(state);
    state.renderer.dispose();
}

/** HMR: swaps voxel resources and rebuilds the active room's voxel visuals. */
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

/** HMR: swaps sprite resources and rebuilds the active room's extruded-sprite visuals. */
export async function refreshSpriteResources(state: WebGpuState, opts: { resources: EngineResources }): Promise<boolean> {
    const changed = await swapSpriteResources(state, opts);
    if (changed && state.active) {
        rebuildExtrudedSpriteVisuals(state, state.active.room);
    }
    return changed;
}

export function createOfflinePipeline(state: WebGpuState, scene: Scene, camera: Camera): RenderPipeline {
    const scenePass = pass(scene, camera, { clearColor: [0, 0, 0, 0] });
    const fxaaPass = fxaa(scenePass.getTextureNode());
    const outputNode = renderOutput(fxaaPass);
    return new RenderPipeline(state.renderer, outputNode);
}

/** Renders `scene` into `target` via a caller-owned offline `pipeline`, queuing the voxel compute for `voxelResources` first, and restores the prior render target. */
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

/** Composes one block into `sceneColor`'s tile cell by rendering geometry directly, so the target's own viewport/scissor confine it. First tile clears the target, the rest load. */
export function composeSceneToTarget(
    state: WebGpuState,
    voxelResources: VoxelResources.VoxelResources,
    scene: Scene,
    camera: Camera,
    sceneColor: RenderTarget,
    voxelViewChunkRadius: number,
    tile: TileTarget,
): void {
    const r = state.renderer;
    const saved = r.renderTarget;
    r.renderTarget = sceneColor;
    sceneColor.viewport = tile.rect;
    sceneColor.scissor = tile.rect;
    sceneColor.scissorTest = true;
    r.autoClear = tile.clear;
    r.clearColor = [0, 0, 0, 0]; // transparent icon background
    VoxelResources.updateCull(voxelResources, camera, voxelViewChunkRadius);
    const dispatches: ComputeDispatch[] = [];
    for (const disp of VoxelResources.cullDispatches(voxelResources)) dispatches.push(disp);
    scene.updateWorldMatrix();
    Time.tick(state.timeResources, performance.now() / 1000);
    if (dispatches.length > 0) r.compute(dispatches);
    r.render(scene, camera);
    r.renderTarget = saved;
}

/** The one-shot post pipeline (fxaa, then tonemap/output) reading a composited HDR `sceneColor`. */
export function createOfflinePostPipeline(state: WebGpuState, sceneColor: RenderTarget): RenderPipeline {
    // `.texture` is Texture|CubeTexture; our scene-color target is a plain 2D target.
    const fxaaPass = fxaa(texture(sceneColor.texture as Texture));
    return new RenderPipeline(state.renderer, renderOutput(fxaaPass));
}

/** Runs the post pipeline once over the whole grid into `atlas`, full-frame, clears first. */
export function renderPostToTarget(state: WebGpuState, atlas: RenderTarget, postPipeline: RenderPipeline): void {
    const r = state.renderer;
    const saved = r.renderTarget;
    r.renderTarget = atlas;
    atlas.viewport = null;
    atlas.scissor = null;
    atlas.scissorTest = false;
    r.autoClear = true;
    Time.tick(state.timeResources, performance.now() / 1000);
    postPipeline.render();
    r.renderTarget = saved;
}

/** Stands up the WebGPU offline backend. Device is injected (Node Dawn) or requested from `navigator.gpu` (browser worker). */
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
    const budget = Performance.voxelArenaBudgetForTier(performance);
    const offline: OfflineRenderer = {
        kind,
        caps,
        performance,
        budget,
        rebuildDeps: (loader) => buildOfflineDeps(state, offline, budget, loader),
        createPipeline: (scene, camera) => createOfflinePipeline(state, scene, camera),
        renderToTarget: (deps, room, camera, target, pipeline, radius) =>
            // Built by this backend's buildOfflineDeps, so voxelResources is the gpu type.
            renderRoomToTarget(
                state,
                deps.voxelResources as VoxelResources.VoxelResources,
                room.render.scene,
                camera,
                target,
                pipeline,
                radius,
            ),
        composeSceneToTarget: (deps, room, camera, sceneColor, radius, tile) =>
            composeSceneToTarget(
                state,
                deps.voxelResources as VoxelResources.VoxelResources,
                room.render.scene,
                camera,
                sceneColor,
                radius,
                tile,
            ),
        createPostPipeline: (sceneColor) => createOfflinePostPipeline(state, sceneColor),
        renderPostToTarget: (atlas, postPipeline) => renderPostToTarget(state, atlas, postPipeline),
        readTarget: (target) => readPixels(state.renderer, target),
        // deps built by this backend's buildOfflineDeps → voxelResources is the gpu type.
        unmountRoom: (deps) =>
            VoxelResources.unmountRoom(deps.voxelResources as VoxelResources.VoxelResources, deps.voxelResources.meshDispatcher),
        remeshChunkInto: (deps, voxels, registry, chunk, meshOutput) =>
            VoxelResources.remeshChunkInto(
                deps.voxelResources as VoxelResources.VoxelResources,
                voxels,
                registry,
                chunk,
                meshOutput,
            ),
        dispose: () => dispose(state),
    };
    return offline;
}

/** Builds a `RenderRoomDeps` (and teardown) for the offline icon room against the realm's live registry and the just-baked assets read through `loader`. Rebuilt per bake so the voxel atlas reflects the latest baked textures. */
async function buildOfflineDeps(
    state: WebGpuState,
    offline: OfflineRenderer,
    budget: VoxelArena.VoxelArenaBudget,
    loader: ResourceLoader,
): Promise<{ deps: RenderRoomDeps; dispose: () => void }> {
    // This path doesn't call engine-client.load(), so rebuild the derived index fields before reading the block registry.
    reindexRegistry(registry);

    const resources = initEngineResources(loader, 'client');
    // No net in a headless render room; a `local:` room's send no-ops anyway.
    const rpc = Rpc.init({ send() {}, broadcast() {} });

    const cloudResources = CloudResources.init(state.environmentResources);
    const modelResources = MeshResources.init(state.environmentResources);
    const voxelResources = VoxelResources.init(registry.blockRegistry, state.environmentResources, budget, state.timeResources);
    const voxelMeshResources = VoxelMeshResources.init(voxelResources.textures, state.timeResources, state.environmentResources);

    // The offline path builds its own resources, so it must route the light volume too:
    // model and voxel-mesh materials bind `lightTiles`/`lightGrid` by name.
    for (const geometry of [modelResources.batch.geometry, voxelMeshResources.batch.geometry]) {
        VoxelLightSample.routeLightVolumeBuffers(geometry, voxelResources.lightVolume);
    }

    // workerCount=0 means synchronous remesh. Waits for the atlas upload and the voxel
    // compute pipelines to compile, so the bakers never gate on it themselves.
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
        MeshResources.dispose(modelResources);
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
        get canvas() {
            return state.renderer.domElement;
        },
        get onDeviceLost() {
            return state.renderer.onDeviceLost;
        },
        set onDeviceLost(cb) {
            state.renderer.onDeviceLost = cb;
        },
        load: () => load(state),
        dispose: () => dispose(state),
        resize: (w, h, pr) => resize(state, w, h, pr),
        setInspectorVisible: (v) => setInspectorVisible(state, v),
        time: state.timeResources,
        initResources: (o) => initResources(state, o),
        loadResources: (o) => loadResources(state, o),
        disposeResources: () => disposeResources(state),
        atlases: () => ({ voxel: state.resources?.voxel.textures ?? null, sprite: state.resources?.sprite ?? null }),
        updateFrame: (activeRoom, ctx) => updateFrame(state, activeRoom, ctx),
        render: (radius) => render(state, radius),
        voxelWorldDrawable: () => voxelWorldDrawable(state),
        refreshBlockResources: (o) => refreshBlockResources(state, o),
        refreshSpriteResources: (o) => refreshSpriteResources(state, o),
    };
}

/** Resident-and-settled: a chunk mesh is on the GPU and the mesher has nothing queued or in flight. A room with no voxel content reports drawable rather than waiting forever. */
function voxelWorldDrawable(state: WebGpuState): boolean {
    if (!state.active) return false;
    const mesher = state.resources.voxel.meshDispatcher;
    if (mesher === null) return true;
    const stats = meshQueueStats(mesher);
    const queued = stats.perSlot.reduce((n, s) => n + s.pending + s.pendingUrgent, 0);
    if (stats.inFlightTotal > 0 || queued > 0) return false;
    return state.resources.voxel.arenas.residentKeys.size > 0 || state.active.room.voxels.chunks.size === 0;
}

/** The eight client-global GPU resource sets, owned by the backend. */
export type BackendResources = {
    sprite: SpriteResources.SpriteResources;
    extrudedSprite: ExtrudedSpriteResources.ExtrudedSpriteResources;
    particle: ParticleResources.ParticleResources;
    cloud: CloudResources.CloudResources;
    model: MeshResources.MeshResources;
    shadow: ShadowResources.ShadowResources;
    voxel: VoxelResources.VoxelResources;
    voxelMesh: VoxelMeshResources.VoxelMeshResources;
};

/** Sync construction of every resource set: builds materials and cull computes against the placeholder atlas so downstream inits can name-bind it immediately. Async atlas fetches happen in `loadResources`. */
export function initResources(
    renderer: WebGpuState,
    opts: { blockRegistry: Blocks; voxelBudget: VoxelArena.VoxelArenaBudget },
): void {
    const sprite = SpriteResources.init(renderer.environmentResources);
    const extrudedSprite = ExtrudedSpriteResources.init(sprite, renderer.environmentResources);
    const particle = ParticleResources.init(sprite.atlas, renderer.environmentResources);
    const cloud = CloudResources.init(renderer.environmentResources);
    const model = MeshResources.init(renderer.environmentResources);
    const shadow = ShadowResources.init();
    const voxel = VoxelResources.init(
        opts.blockRegistry,
        renderer.environmentResources,
        opts.voxelBudget,
        renderer.timeResources,
    );
    const voxelMesh = VoxelMeshResources.init(voxel.textures, renderer.timeResources, renderer.environmentResources);
    // Every visual samples light in the shader, so route the volume's buffers to the names their materials bind.
    for (const geometry of [
        particle.batch.geometry,
        sprite.batch.geometry,
        extrudedSprite.batch.geometry,
        model.batch.geometry,
        voxelMesh.batch.geometry,
    ]) {
        VoxelLightSample.routeLightVolumeBuffers(geometry, voxel.lightVolume);
    }

    renderer.resources = { sprite, extrudedSprite, particle, cloud, model, shadow, voxel, voxelMesh };
}

/**
 * Async load pass: pre-warms compile pipelines and fetches the real sprite/voxel
 * atlases. Extruded and particle materials captured a TextureNode against the
 * placeholder atlas during init, so re-bind them after `SpriteResources.load` swaps it out.
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

/** HMR: re-fetches the block atlas and rebuilds voxel and voxel-mesh resources. Returns whether the resources actually swapped, so callers can rebuild each room's voxel visuals. */
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

    // voxelMeshResources binds the engine-global atlas + texAnim, so it must rebuild alongside voxelResources.
    if (changed) {
        VoxelMeshResources.dispose(r.voxelMesh);
        r.voxelMesh = VoxelMeshResources.init(r.voxel.textures, renderer.timeResources, renderer.environmentResources);
        // A new VoxelResources carries a new light volume, so every batch must be re-pointed, not just the one just rebuilt.
        for (const geometry of [
            r.particle.batch.geometry,
            r.sprite.batch.geometry,
            r.extrudedSprite.batch.geometry,
            r.model.batch.geometry,
            r.voxelMesh.batch.geometry,
        ]) {
            VoxelLightSample.routeLightVolumeBuffers(geometry, r.voxel.lightVolume);
        }
    }
    return changed;
}

/** HMR: re-fetches the sprite atlas, rebinds materials that hold their own TextureNodes against it, and wipes the extruded silhouette pool. Returns whether the atlas changed. */
export async function swapSpriteResources(renderer: WebGpuState, opts: { resources: EngineResources }): Promise<boolean> {
    const r = renderer.resources;
    const changed = await SpriteResources.refresh(r.sprite, opts.resources.loader, opts.resources.spriteAtlas);
    if (!changed) return false;
    ExtrudedSpriteResources.rebindAtlas(r.extrudedSprite, r.sprite.atlas);
    ParticleResources.rebindAtlas(r.particle, r.sprite.atlas);
    ExtrudedSpriteResources.clearGeometryPool(r.extrudedSprite);
    return true;
}

/** Disposes the client-global resources. `modelResources` has no dispose. */
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

export type RoomVisuals = {
    voxel: VoxelVisuals.VoxelVisuals;
    voxelMesh: VoxelMeshVisuals.VoxelMeshVisuals;
    model: MeshVisuals.MeshVisuals;
    domUi: DomUi.DomUi;
    sprite: SpriteVisuals.SpriteVisuals;
    extrudedSprite: ExtrudedSpriteVisuals.ExtrudedSpriteVisuals;
    shadow: ShadowVisuals.ShadowVisuals;
    particle: ParticleVisuals.ParticleVisuals;
    /** Sky/sun/moon/star meshes and cloud anchor, driven each frame from the active room's `environment` config. */
    env: Environment.EnvVisuals;
};

/** The active slot: the room and its visuals, plus the `scene`/`visibility` handles teardown needs captured up front. */
export type RoomActive = {
    room: ClientRoom;
    scene: ClientRoom['render']['scene'];
    visibility: ClientRoom['visibility'];
    visuals: RoomVisuals;
};

/** Reconciles the active slot to `activeRoom`: tears the old one down and builds the new one when it differs. No-op when already matching. */
export function reconcile(state: WebGpuState, activeRoom: ClientRoom | null): void {
    if ((state.active?.room ?? null) === activeRoom) return;
    teardown(state);
    if (activeRoom) state.active = build(state, activeRoom);
}

/** Builds the active room's visual bundle, mounts its world into the single-world voxel arena, and force-pushes its env config into the engine-global env UBOs. */
function build(state: WebGpuState, room: ClientRoom): RoomActive {
    const res = state.resources;
    const nodes = room.scene;
    const { scene, overlayScene } = room.render;

    const voxel = VoxelVisuals.initRoomMeshes(scene, res.voxel.geometries, res.voxel.quadMaterials);
    const voxelMesh = VoxelMeshVisuals.init(res.voxelMesh.batch, scene, nodes);
    const model = MeshVisuals.init(res.model.batch, scene, nodes);
    // CanvasTrait quads render in the overlay scene (crisp, post-fxaa); HtmlTrait panels are DOM.
    const domUi = DomUi.init(overlayScene, room.viewport, nodes, state.pipeline.sceneDepthNode);
    const sprite = SpriteVisuals.init(res.sprite.batch, scene, nodes);
    const extrudedSprite = ExtrudedSpriteVisuals.init(res.extrudedSprite.batch, scene, nodes);
    const shadow = ShadowVisuals.init(res.shadow.batch, scene, nodes);
    const particle = ParticleVisuals.init(res.particle.batch, scene, res.sprite);
    const env = Environment.initEnvVisuals(scene, state.environmentResources, res.cloud);

    const visuals: RoomVisuals = { voxel, voxelMesh, model, domUi, sprite, extrudedSprite, shadow, particle, env };

    VoxelVisuals.mountRoom(voxel, room.voxels);
    Environment.flushActive(room.environment, state.environmentResources);

    return { room, scene, visibility: room.visibility, visuals };
}

/** Disposes the active room's visual bundle, releases its world's arena chunks, and clears the active slot. No-op when nothing is active. */
export function teardown(state: WebGpuState): void {
    if (!state.active) return;
    const { scene, visibility, visuals: rv } = state.active;
    VoxelVisuals.dispose(rv.voxel, scene);
    VoxelResources.unmountRoom(state.resources.voxel, state.resources.voxel.meshDispatcher);
    VoxelMeshVisuals.dispose(rv.voxelMesh, state.resources.voxelMesh.batch, visibility);
    MeshVisuals.dispose(rv.model, state.resources.model.batch, visibility);
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

/** Per-frame update of the active room's visuals. No-op with no active room or unresolved POV camera. */
export function updateActiveRoom(state: WebGpuState, ctx: FrameContext): void {
    if (!state.active) return;
    const povCamera = ctx.povCamera;
    if (!povCamera) return;
    const { room, visuals: rv } = state.active;
    const res = state.resources;

    Debug.begin(ctx.profiler, 'mesh');
    // AOI schedules dirty chunks off-thread (streaming rooms wait for the 26-neighbourhood so
    // AO/light mesh correctly the first time), then the GPU producer consumes the staged results.
    // No dispatcher means no worker pool, so skip the drive rather than fail the frame.
    const mesher = res.voxel.meshDispatcher;
    if (mesher !== null) {
        VoxelAoi.reDirtyLost(mesher, room.voxels);
        const toForget: string[] = [];
        VoxelAoi.scheduleDirtyChunks(
            rv.voxel,
            mesher,
            room.voxels,
            res.voxel.lightVolume,
            povCamera.position,
            !room.local,
            toForget,
        );
        VoxelResources.consume(res.voxel, mesher, room.voxels, povCamera.position, toForget);
        // Flush after consume drains: it recycles output buffers back to the workers, which would detach them from an undrained result.
        flushMeshQueue(mesher, room.voxels);
        rv.voxel.lastMeshPerf = readMeshPerf(mesher);
    }
    Debug.end(ctx.profiler, 'mesh');

    // Deliberately outside the `mesher !== null` guard: a room with no mesh worker still has entities/sprites/particles sampling this.
    Debug.begin(ctx.profiler, 'light-volume');
    const lightBakes = VoxelLightVolume.drainLightVolume(
        res.voxel.lightVolume,
        room.voxels,
        povCamera.position,
        LIGHT_BAKE_BUDGET_MS,
        rv.voxel.frame,
    );
    if (ctx.profiler.enabled) {
        Debug.record(ctx.profiler, 'voxels/light/bakes', lightBakes, 'count');
        Debug.record(
            ctx.profiler,
            'voxels/light/queued',
            room.voxels.dirty.lightVolume.size + room.voxels.dirty.lightVolumeUrgent.size,
            'count',
        );
        Debug.record(ctx.profiler, 'voxels/light/urgent', room.voxels.dirty.lightVolumeUrgent.size, 'count');
        Debug.record(ctx.profiler, 'voxels/light/tiles', res.voxel.lightVolume.head, 'count');
    }
    Debug.end(ctx.profiler, 'light-volume');

    // Recorded post-update so the sample reflects this frame's allocs.
    if (ctx.profiler.enabled) {
        const quadR = VoxelArena.arenaReport(res.voxel.arenas.quadArena);
        Debug.record(ctx.profiler, 'voxels/arena/quad/usedPct', (100 * quadR.used) / quadR.slotCount, '%');
        Debug.record(ctx.profiler, 'voxels/arena/quad/largestFreePct', (100 * quadR.largestFree) / quadR.slotCount, '%');
        Debug.record(ctx.profiler, 'voxels/arena/quad/allocs', quadR.allocs, 'count');
    }

    Debug.begin(ctx.profiler, 'voxel-mesh');
    VoxelMeshVisuals.update(rv.voxelMesh, res.voxelMesh.batch, room.visibility);
    Debug.end(ctx.profiler, 'voxel-mesh');

    Debug.begin(ctx.profiler, 'model');
    MeshVisuals.update(rv.model, res.model.batch, res.model, ctx.resources, room.visibility);
    Debug.end(ctx.profiler, 'model');

    Debug.begin(ctx.profiler, 'dom-ui');
    DomUi.update(rv.domUi, povCamera, ctx.viewport);
    Debug.end(ctx.profiler, 'dom-ui');

    Debug.begin(ctx.profiler, 'sprite');
    SpriteVisuals.update(rv.sprite, res.sprite.batch, res.sprite, povCamera, room.visibility);
    Debug.end(ctx.profiler, 'sprite');

    Debug.begin(ctx.profiler, 'extruded-sprite');
    ExtrudedSpriteVisuals.update(rv.extrudedSprite, res.extrudedSprite.batch, res.extrudedSprite, room.visibility);
    Debug.end(ctx.profiler, 'extruded-sprite');

    Debug.begin(ctx.profiler, 'shadow');
    ShadowVisuals.update(rv.shadow, res.shadow.batch, room.voxels, povCamera);
    Debug.end(ctx.profiler, 'shadow');

    // Runs after Particles.update so freshly-stepped positions feed this frame's pose buffer.
    Debug.begin(ctx.profiler, 'particle');
    ParticleVisuals.update(rv.particle, res.particle.batch, room.particles, ctx.now);
    Debug.end(ctx.profiler, 'particle');

    // gpucat zeroes the per-frame fields itself at its own frame boundary, so this just reads them.
    // Sampled before this frame's render, so a reading describes the previous frame.
    if (ctx.profiler.enabled) {
        const info = state.renderer.info;
        // Read bytes with calls: a batch re-uploading its whole capacity when one slot moved
        // spikes bytes with calls flat, while a caller queueing many tiny ranges does the reverse.
        Debug.record(ctx.profiler, 'gpu/upload/bytes', info.buffers.writeBytes, 'B');
        Debug.record(ctx.profiler, 'gpu/upload/calls', info.buffers.writeCalls, 'count');
        Debug.record(ctx.profiler, 'gpu/draws', info.render.drawCalls, 'count');
        // A floor, not a total: indirect draws keep their counts in a GPU buffer never read here.
        Debug.record(ctx.profiler, 'gpu/triangles', info.render.triangles, 'count');
        // Resident objects the renderer is holding; a count climbing frame over frame is a leak, not a workload.
        Debug.record(ctx.profiler, 'gpu/buffers', info.memory.buffers, 'count');
        Debug.record(ctx.profiler, 'gpu/buffers/raw', info.memory.rawBuffers, 'count');
        Debug.record(ctx.profiler, 'gpu/pipelines/render', info.memory.renderPipelines, 'count');
        Debug.record(ctx.profiler, 'gpu/pipelines/compute', info.memory.computePipelines, 'count');
        Debug.record(ctx.profiler, 'gpu/bindGroupLayouts', info.memory.bindGroupLayouts, 'count');
        // `dirty` is what changed this frame; `span` is what the single min..max range actually
        // uploads. span >> dirty means scattered slots are dragging untouched neighbours into the write.
        const meshBatch = res.model.batch;
        Debug.record(ctx.profiler, 'mesh/instances/alive', meshBatch.aliveInstances, 'count');
        Debug.record(ctx.profiler, 'mesh/instances/dirty', meshBatch.dirtyInstances, 'count');
        Debug.record(ctx.profiler, 'mesh/instances/span', meshBatch.dirtySpan, 'count');
    }
}

/** HMR: rebuilds the active room's voxel and voxel-mesh visuals against freshly-swapped resources. No-op when `room` isn't the active room. */
export function rebuildVoxelVisuals(state: WebGpuState, room: ClientRoom): void {
    if (!state.active || state.active.room !== room) return;
    const rv = state.active.visuals;
    VoxelVisuals.dispose(rv.voxel, room.render.scene);
    VoxelMeshVisuals.dispose(rv.voxelMesh, state.resources.voxelMesh.batch, room.visibility);
    rv.voxel = VoxelVisuals.initRoomMeshes(
        room.render.scene,
        state.resources.voxel.geometries,
        state.resources.voxel.quadMaterials,
    );
    rv.voxelMesh = VoxelMeshVisuals.init(state.resources.voxelMesh.batch, room.render.scene, room.scene);
    // The refresh blew away the previous arena, so re-mount to mark chunks dirty and let the remesh path refill it.
    VoxelVisuals.mountRoom(rv.voxel, room.voxels);
}

/** HMR: rebuilds the active room's extruded-sprite visuals after the sprite atlas swapped, dropping now-dangling GeometrySlot refs. No-op when `room` isn't the active room. */
export function rebuildExtrudedSpriteVisuals(state: WebGpuState, room: ClientRoom): void {
    if (!state.active || state.active.room !== room) return;
    const rv = state.active.visuals;
    ExtrudedSpriteVisuals.dispose(
        rv.extrudedSprite,
        state.resources.extrudedSprite.batch,
        state.resources.extrudedSprite,
        room.visibility,
    );
    rv.extrudedSprite = ExtrudedSpriteVisuals.init(state.resources.extrudedSprite.batch, room.render.scene, room.scene);
}
