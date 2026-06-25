import {
    type Camera,
    type CanvasTarget,
    type ComputeDispatch,
    d,
    fxaa,
    Inspector,
    mix,
    type PassNode,
    PerspectiveCamera,
    pass,
    RenderPipeline,
    renderOutput,
    Scene,
    Uniform,
    uniform,
    vec4f,
    WebGPURenderer,
} from 'gpucat';
import { ENVIRONMENT_DEFAULT } from '../api/environment';
import type { CameraTrait } from '../builtins/camera';
import { getWorldPosition, getWorldQuaternion, TransformTrait } from '../builtins/transform';
import { getTrait } from '../core/scene/nodes';
import { getCameraTint } from '../core/voxels/camera-tint';
import type { Voxels } from '../core/voxels/voxels';
import * as Environment from './environment';
import type { ClientRoom } from './rooms';
import { elapsedTime } from './voxels/voxel-material';
import type { VoxelResources } from './voxels/voxel-resources';
import * as VoxelVisuals from './voxels/voxel-visuals';

export type Renderer = {
    renderer: WebGPURenderer;
    /** engine-global env GPU buffers — one set across the whole engine,
     *  flushed each frame from the active room's CPU shadow (see
     *  `Environment.updateForCamera`). every env-aware shader (sky, voxel,
     *  model, sprite, cloud) binds these by name through its per-room
     *  geometry. */
    environmentResources: Environment.EnvironmentResources;
    /** engine-global render pipeline — one set across all rooms; the active
     *  room swaps in via `setActiveScene` each frame. */
    pipeline: EngineRenderPipeline;
};

/**
 * sync construction — WebGPURenderer + env GPU buffers + render pipeline.
 * gpucat objects defer their actual GPU work until `renderer.init()` runs,
 * so the pipeline can be wired against the buffers up front; only the
 * device handshake stays async (`load`).
 *
 * No Inspector is constructed at boot — `setInspectorVisible(true)` lazily
 * builds one on first show and disposes it when hidden (full teardown of
 * GPU resources, DOM, and window listeners).
 */
export function init(): Renderer {
    const renderer = new WebGPURenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    const environmentResources = Environment.createEnvironmentResources(ENVIRONMENT_DEFAULT);
    const pipeline = createRenderPipeline(renderer);
    return { renderer, environmentResources, pipeline };
}

/**
 * Headless construction for the asset pipeline (`src/asset-pipeline`). Renders
 * into an offscreen RenderTarget against a caller-supplied Dawn device +
 * adapter — no canvas swapchain, no window dimension reads. The env GPU buffers
 * + render pipeline build identically to the browser `init()`; this just swaps
 * the surface. There is no `setSize`: the asset pipeline sizes per-pass
 * RenderTargets itself (see offline snapshot sessions).
 */
export function initHeadless(gpu: { device: GPUDevice; adapter: GPUAdapter }): Renderer {
    const renderer = new WebGPURenderer({
        antialias: true,
        headless: true,
        device: gpu.device,
        adapter: gpu.adapter,
        format: 'rgba8unorm',
    });
    const environmentResources = Environment.createEnvironmentResources(ENVIRONMENT_DEFAULT);
    const pipeline = createRenderPipeline(renderer);
    return { renderer, environmentResources, pipeline };
}

/** async device handshake. all GPU objects defer their real work until now. */
export async function load(state: Renderer): Promise<void> {
    await state.renderer.init();
}

/**
 * Install or remove the gpucat Inspector overlay. Driven each frame by
 * debugOpen + debugTab. Idempotent: only acts on edges, so the per-frame
 * call is a cheap identity check when state hasn't changed.
 *
 * On show: constructs a fresh Inspector, attaches it via `setInspector`,
 * mounts the panel to document.body (bongle never mounts the WebGPURenderer's
 * implicit canvas — each room renders to its own canvas via canvas targets,
 * so the inspector's self-attach finds nothing), and docks/opens it.
 *
 * On hide: `setInspector(null)` triggers the Inspector's dispose path which
 * tears down GPU query resources, removes the DOM, drops window listeners,
 * and clears detached tab panels.
 */
export function setInspectorVisible(state: Renderer, visible: boolean): void {
    const isOn = state.renderer.inspector instanceof Inspector;
    if (visible === isOn) return;

    if (visible) {
        const inspector = new Inspector();
        state.renderer.setInspector(inspector);

        if (!inspector.domElement.parentElement) {
            document.body.appendChild(inspector.domElement);
            const profiler = inspector.profiler;
            if (profiler.position !== 'bottom') profiler.setPosition('bottom');
            if (!profiler.panel.classList.contains('visible')) profiler.togglePanel();
        }
    } else {
        state.renderer.setInspector(null);
    }
}

/**
 * the engine's single, persistent render pipeline. one set across the
 * whole engine — built once at boot, then reused for every active room.
 * swapping rooms mutates `passNode.scene` (and the matrices on `camera`)
 * instead of building a fresh pipeline, so the compiled post-chain (fxaa
 * + tint) is paid for exactly once.
 *
 * a fullscreen tint applied after fxaa is driven by `screenTint` — when
 * `w=0` the mix collapses to the input (free fast path). callers update
 * the uniform each frame based on the block at the camera position.
 */
export type EngineRenderPipeline = {
    pipeline: RenderPipeline;
    /**
     * the scene pass. its `scene` slot is mutated per frame to point at
     * the active room's scene (see `setActiveScene`); its `camera` slot
     * is `pipeline.camera`, set once at construction.
     */
    passNode: PassNode;
    /**
     * the camera the pass renders through. composed each frame from the
     * active camera node's TransformTrait + CameraTrait via
     * `syncRenderCamera`. owned here, not by CameraTrait — CameraTrait is
     * plain projection data.
     */
    camera: PerspectiveCamera;
    /** rgba tint uniform — set w=0 for no tint. */
    screenTint: Uniform<d.vec4f>;
};

function createRenderPipeline(webGpuRenderer: WebGPURenderer): EngineRenderPipeline {
    const camera = new PerspectiveCamera(75 * (Math.PI / 180));
    // pass() needs a non-null Scene at construction; we use a throwaway
    // placeholder and mutate `passNode.scene = activeRoom.scene` each
    // frame. the placeholder is never rendered.
    const placeholderScene = new Scene();
    const scenePass = pass(placeholderScene, camera);
    const fxaaPass = fxaa(scenePass.getTextureNode());

    const screenTint = new Uniform(d.vec4f, [0, 0, 0, 0]);
    const tintNode = uniform(screenTint);
    const tinted = vec4f(mix(fxaaPass.rgb, tintNode.rgb, tintNode.a), fxaaPass.a).toVar('tinted');

    const outputNode = renderOutput(tinted);
    return {
        pipeline: new RenderPipeline(webGpuRenderer, outputNode),
        passNode: scenePass,
        camera,
        screenTint,
    };
}

/**
 * compose the pipeline's persistent render camera from the active CameraTrait
 * (and its sibling TransformTrait). pose comes from the camera node's world
 * transform; fov/near/far come from CameraTrait. projection rebuilds only on
 * change. idempotent — safe to call multiple times per frame.
 *
 * no-op when cameraTrait is null (no active POV).
 */
export function syncRenderCamera(pipeline: EngineRenderPipeline, cameraTrait: CameraTrait | null): void {
    if (!cameraTrait) return;
    const camNode = cameraTrait._node;
    const transform = getTrait(camNode, TransformTrait);
    const out = pipeline.camera;
    if (transform) {
        const wp = getWorldPosition(transform);
        const wq = getWorldQuaternion(transform);
        out.position[0] = wp[0]!;
        out.position[1] = wp[1]!;
        out.position[2] = wp[2]!;
        out.quaternion[0] = wq[0]!;
        out.quaternion[1] = wq[1]!;
        out.quaternion[2] = wq[2]!;
        out.quaternion[3] = wq[3]!;
    }

    let projDirty = false;
    if (out.fov !== cameraTrait.fov) {
        out.fov = cameraTrait.fov;
        projDirty = true;
    }
    if (out.near !== cameraTrait.near) {
        out.near = cameraTrait.near;
        projDirty = true;
    }
    if (out.far !== cameraTrait.far) {
        out.far = cameraTrait.far;
        projDirty = true;
    }
    if (projDirty) out.updateProjectionMatrix();

    out.updateWorldMatrix();
    out.updateViewMatrix();
}

/**
 * point the persistent pass at the active room's scene. `PassNode.scene`
 * is `readonly` in TS but read fresh each frame in `updateBefore` — the
 * runtime resolves the swap on the next render.
 */
function setActiveScene(pipeline: EngineRenderPipeline, scene: Scene): void {
    (pipeline.passNode as { scene: Scene }).scene = scene;
}

/**
 * ensure pipeline.camera's aspect matches the viewport. called per frame
 * after syncRenderCamera. projection rebuilds only on change.
 */
export function bindRenderCamera(pipeline: EngineRenderPipeline, canvasTarget: CanvasTarget): void {
    const { width, height } = canvasTarget.getSize();
    if (width <= 0 || height <= 0) return;
    const aspect = width / height;
    const camera = pipeline.camera;
    if (camera.aspect !== aspect) {
        camera.aspect = aspect;
        camera.updateProjectionMatrix();
    }
}

/**
 * transparent-clear pipeline for offline tasks (icon atlases). callers
 * supply a per-pass camera so each subject can be framed independently.
 * skips screen tint — icons composite against a neutral background.
 */
export function createOfflinePipeline(state: Renderer, scene: Scene, camera: Camera): RenderPipeline {
    const scenePass = pass(scene, camera, { clearColor: [0, 0, 0, 0] });
    const fxaaPass = fxaa(scenePass.getTextureNode());
    const outputNode = renderOutput(fxaaPass);
    return new RenderPipeline(state.renderer, outputNode);
}

const _tintScratch: [number, number, number, number] = [0, 0, 0, 0];

/**
 * sample camera-relative world context (block at the eye, depth, etc) and
 * push the results into the engine-global pipeline uniforms. add new
 * context-driven uniforms here.
 */
function updateCameraEnvironment(pipeline: EngineRenderPipeline, voxels: Voxels, camera: Camera): void {
    const p = camera.position;
    if (!getCameraTint(_tintScratch, voxels, p[0], p[1], p[2])) _tintScratch[3] = 0;
    pipeline.screenTint.value = _tintScratch;
}

export function resize(state: Renderer, width: number, height: number) {
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
 * every active room — only `passNode.scene` (and the camera + env buffer
 * contents) rotate per frame.
 */
export function render(
    state: Renderer,
    room: ClientRoom,
    camera: Camera | null,
    voxelResources: VoxelResources,
    voxelViewChunkRadius: number,
): void {
    // canvas target — guard avoids redundant reconfigure on the gpu side.
    if (state.renderer.getCanvasTarget() !== room.canvasTarget) {
        state.renderer.setCanvasTarget(room.canvasTarget);
    }

    // env flush + screen tint — only the active camera defines what world
    // context the post-chain should see this frame. when camera is null
    // (e.g. boot before a control is bound) we still render whatever the
    // pipeline last saw — the room will compose with stale env, which is
    // fine for the rare null window.
    if (camera) {
        updateCameraEnvironment(state.pipeline, room.voxels, camera);
        Environment.updateForCamera(room.environment, camera);
        // CPU per-(section, facing) cull — builds per-pass visibleSlices
        // + single-entry drawIndirect. expansion compute fans these out
        // into per-quad visibleQuads downstream.
        VoxelVisuals.cullCPU(voxelResources, camera, voxelViewChunkRadius);
    }

    // point the engine-global pass at this room's scene before render —
    // the pipeline graph is shared, only `passNode.scene` rotates.
    setActiveScene(state.pipeline, room.scene);

    const dispatches: ComputeDispatch[] = [];

    // voxel expansion (3 dispatches: opaque, transparent, translucent —
    // skipped per-pass when no visible slices). fans per-(section, facing)
    // visible slices into per-quad entries the VS reads.
    for (const disp of VoxelVisuals.expandDispatches(voxelResources)) dispatches.push(disp);

    // drive the voxel animation clock — gpucat no longer ticks time itself.
    elapsedTime.value = performance.now() / 1000;
    state.renderer.compute(dispatches);
    state.pipeline.pipeline.render();
}

/** tear down the renderer and release gpu resources. */
export function dispose(state: Renderer): void {
    state.renderer.dispose();
}
