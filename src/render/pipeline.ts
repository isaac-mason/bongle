import {
    add,
    type Camera,
    type DepthTextureNode,
    d,
    f32,
    fxaa,
    mix,
    mul,
    type Node,
    type PassNode,
    type PerspectiveCamera,
    pass,
    RenderPipeline,
    renderOutput,
    Scene,
    sub,
    Uniform,
    uniform,
    vec4f,
} from 'gpucat';
import { getCameraTint } from '../core/voxels/camera-tint';
import type { Voxels } from '../core/voxels/voxels';

/** The gpucat renderer either backend passes to `new RenderPipeline(...)`. */
type GpuRenderer = ConstructorParameters<typeof RenderPipeline>[0];

export type RenderParts = {
    scenePass: PassNode;
    overlayPass: PassNode;
    camera: PerspectiveCamera;
};

/**
 * Per-game overrides for the render chain, set with `setRenderPipeline`. Every stage
 * is optional and defaults to the engine's own implementation. Stages compose
 * downward: overriding `resolve` still gets correct tinting and overlay compositing.
 * Stage order is fixed and a stage that doesn't exist can't be inserted between others.
 */
export type RenderStages = {
    /** Runs before the graph is built, on the passes themselves. */
    configure?: (parts: RenderParts) => void;
    /** Default: `fxaa(color)`. */
    resolve?: (ctx: { color: Node<d.vec4f>; depth: DepthTextureNode; camera: PerspectiveCamera }) => Node<d.vec4f>;
    /** Default: mix toward the camera-in-block tint, a no-op at `tint.a == 0`. */
    tint?: (ctx: { color: Node<d.vec4f>; tint: Node<d.vec4f> }) => Node<d.vec4f>;
    /** Default: premultiplied-over. `overlay` is the CanvasTrait / HUD pass. */
    composite?: (ctx: { color: Node<d.vec4f>; overlay: Node<d.vec4f> }) => Node<d.vec4f>;
    /** Default: `renderOutput(color)`, tone mapping and color space. */
    output?: (ctx: { color: Node<d.vec4f> }) => Node<d.vec4f>;
};

let activeStages: RenderStages = {};
/** Bumped on every `setRenderPipeline`; a pipeline built from an older version rebuilds itself on the next frame. */
let stagesVersion = 0;

/**
 * Overrides the render chain for this game. Call at module scope beside `config()`.
 * Calling again rebuilds the graph before the next frame, which is what makes it
 * survive HMR. The rebuild discards the passes and makes new ones rather than
 * reusing them, since `configure` mutates pass state with no generic way to undo it.
 */
export function setRenderPipeline(stages: RenderStages): void {
    activeStages = stages;
    stagesVersion++;
}

/**
 * The engine's single, persistent render pipeline: one set per backend, built once at
 * boot, reused for every active room. Swapping rooms mutates `passNode.scene` and the
 * matrices on `camera` instead of building a fresh pipeline, so the compiled post-chain
 * pays its cost exactly once. `screenTint` at `w=0` collapses the mix to a free fast path.
 */
export type EngineRenderPipeline = {
    pipeline: RenderPipeline;
    /** Its `scene` slot is mutated per frame to point at the active room's scene; `camera` slot is set once at construction. */
    passNode: PassNode;
    /** The backend's `Renderer.camera`, composed each frame from the active camera node's TransformTrait + CameraTrait. */
    camera: PerspectiveCamera;
    /** RGBA tint uniform; `w=0` means no tint. */
    screenTint: Uniform<d.vec4f>;
    /** Kept so the pipeline can rebuild itself when the stages change. */
    renderer: GpuRenderer;
    builtFrom: number;
    /** Renders the active room's `overlayScene` after fxaa, so overlays are never blurred by the post-chain. Occlusion is per-material, by sampling `sceneDepthNode` and discarding. */
    overlayPassNode: PassNode;
    /** The scene pass's depth as a sampled texture node; overlay materials `.load()` it to discard occluded fragments. */
    sceneDepthNode: DepthTextureNode;
};

export function createRenderPipeline(renderer: GpuRenderer, camera: PerspectiveCamera): EngineRenderPipeline {
    // pass() needs a non-null Scene at construction; this placeholder is never rendered,
    // and `passNode.scene` is mutated to the active room's scene each frame.
    const placeholderScene = new Scene();
    // No MSAA: WebGPU can't resolve a multisampled depth attachment, and this pass's
    // depth is sampled downstream by dom-ui's overlay occlusion as texture_depth_2d.
    const scenePass = pass(placeholderScene, camera, { label: 'scene' });

    // Renders the active room's overlay scene over the tinted scene, after the scene
    // resolve, so CanvasTrait text/images stay crisp. Blends against a transparent-black
    // clear with straight-alpha factors, so its texture is premultiplied (rgb already x a);
    // composited premultiplied-over below as out = bg*(1-a) + rgb.
    const overlayPass = pass(placeholderScene, camera, {
        label: 'overlay',
        clearColor: [0, 0, 0, 0],
    });

    // Both passes exist and `configure` has run before anything reads from them, so
    // `setMRT`/`setResolutionScale` land before the graph is shaped around their results.
    const stages = activeStages;
    stages.configure?.({ scenePass, overlayPass, camera });

    const sceneColor = scenePass.getTextureNode();
    const sceneDepthNode = scenePass.getDepthTextureNode();
    const resolved = (
        stages.resolve ? stages.resolve({ color: sceneColor, depth: sceneDepthNode, camera }) : fxaa(sceneColor)
    ).toVar('resolved');

    const screenTint = new Uniform(d.vec4f, [0, 0, 0, 0]);
    const tintNode = uniform(screenTint);
    const tinted = (
        stages.tint
            ? stages.tint({ color: resolved, tint: tintNode })
            : vec4f(mix(resolved.rgb, tintNode.rgb, tintNode.a), resolved.a)
    ).toVar('tinted');

    const overlayTex = overlayPass.getTextureNode();
    const overRgb = add(mul(tinted.rgb, sub(f32(1), overlayTex.a)), overlayTex.rgb);
    const composited = (
        stages.composite ? stages.composite({ color: tinted, overlay: overlayTex }) : vec4f(overRgb, tinted.a)
    ).toVar('overlayComposite');

    const outputNode = stages.output ? stages.output({ color: composited }) : renderOutput(composited);
    const engine: EngineRenderPipeline = {
        pipeline: new RenderPipeline(renderer, outputNode),
        passNode: scenePass,
        overlayPassNode: overlayPass,
        sceneDepthNode,
        camera,
        screenTint,
        renderer,
        builtFrom: stagesVersion,
    };
    return engine;
}

/**
 * Rebuilds the graph if `setRenderPipeline` has been called since it was built. Driven
 * from the top of each backend's `render`, before `setActiveScene`. Mutates `engine` in
 * place rather than replacing it, since the client and both backends hold references to it.
 */
export function rebuildRenderPipelineIfStale(engine: EngineRenderPipeline): void {
    if (engine.builtFrom === stagesVersion) return;
    const previous = engine.pipeline;
    Object.assign(engine, createRenderPipeline(engine.renderer, engine.camera));
    previous.dispose?.();
}

/**
 * Points the persistent passes at the active room's scenes and flushes their world
 * matrices. `PassNode.scene` is `readonly` in TS but read fresh each frame in
 * `updateBefore`, so the runtime resolves the swap on the next render. gpucat never
 * auto-updates matrices, so a scene must be flushed each frame or anything posed
 * since the last render draws with a stale/identity `matrixWorld`.
 */
export function setActiveScene(pipeline: EngineRenderPipeline, scene: Scene, overlayScene: Scene): void {
    scene.updateWorldMatrix();
    overlayScene.updateWorldMatrix();
    (pipeline.passNode as { scene: Scene }).scene = scene;
    (pipeline.overlayPassNode as { scene: Scene }).scene = overlayScene;
}

const _tintScratch: [number, number, number, number] = [0, 0, 0, 0];

/** Samples camera-relative world context (block at the eye, depth, etc) and pushes the results into the engine-global pipeline uniforms. */
export function updateCameraEnvironment(pipeline: EngineRenderPipeline, voxels: Voxels, camera: Camera): void {
    const p = camera.position;
    if (!getCameraTint(_tintScratch, voxels, p[0], p[1], p[2])) _tintScratch[3] = 0;
    pipeline.screenTint.value = _tintScratch;
}
