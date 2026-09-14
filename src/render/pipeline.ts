// Backend-neutral engine render pipeline.
//
// The single persistent post-chain — scene pass -> fxaa ->
// screen-tint -> overlay composite -> renderOutput — built once per backend and reused for every active
// room (only `passNode.scene` + the camera + tint uniform rotate per frame). The
// whole graph is gpucat node-DSL that compiles to BOTH WGSL and GLSL (fxaa, the
// tint math, and the overlay's `sceneDepthNode.load()` occlusion all work on
// WebGL), so both backends share it. `RenderPipeline` binds through gpucat's
// backend-neutral `Renderer` interface, so `createRenderPipeline` accepts either
// a WebGPURenderer or a WebGLRenderer.

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

/** the gpucat renderer either backend passes to `new RenderPipeline(...)` — its
 *  backend-neutral `Renderer` interface (WebGPURenderer / WebGLRenderer both fit). */
type GpuRenderer = ConstructorParameters<typeof RenderPipeline>[0];

/** the passes themselves, for the things that are not node math: rendering the
 *  scene smaller (`scenePass.setResolutionScale`), or adding a second colour
 *  attachment (`scenePass.setMRT` + `getTextureNode(name)`). */
export type RenderParts = {
    scenePass: PassNode;
    overlayPass: PassNode;
    camera: PerspectiveCamera;
};

/**
 * Per-game overrides for the render chain, set with `setRenderPipeline`.
 *
 * Every stage is optional and defaults to the engine's own implementation, and
 * they COMPOSE DOWNWARD: overriding `resolve` still gets correct tinting and
 * overlay compositing, so a game replacing the resolve never has to learn that
 * premultiplied-over compositing exists or get it subtly wrong.
 *
 * What the engine keeps whatever a game does: both passes and their per-room
 * `scene` swap, the scene pass's depth staying the thing `dom-ui` samples for
 * overlay occlusion, and termination of the graph. None of those can be broken
 * from here.
 *
 * The stage ORDER is fixed, and a stage that does not exist cannot be inserted -
 * a bloom chain lives inside `resolve` rather than beside it. `resolve` returns a
 * node, so nothing stops it building further passes internally; the stage names
 * describe intent, not a hard partition.
 */
export type RenderStages = {
    /** runs before the graph is built, on the passes themselves. */
    configure?: (parts: RenderParts) => void;
    /** default: `fxaa(color)`. */
    resolve?: (ctx: { color: Node<d.vec4f>; depth: DepthTextureNode; camera: PerspectiveCamera }) => Node<d.vec4f>;
    /** default: mix toward the camera-in-block tint, a no-op at `tint.a == 0`. */
    tint?: (ctx: { color: Node<d.vec4f>; tint: Node<d.vec4f> }) => Node<d.vec4f>;
    /** default: premultiplied-over. `overlay` is the CanvasTrait / HUD pass. */
    composite?: (ctx: { color: Node<d.vec4f>; overlay: Node<d.vec4f> }) => Node<d.vec4f>;
    /** default: `renderOutput(color)`, i.e. tone mapping and colour space. */
    output?: (ctx: { color: Node<d.vec4f> }) => Node<d.vec4f>;
};

let activeStages: RenderStages = {};
/** bumped on every `setRenderPipeline`; a pipeline built from an older version
 *  rebuilds itself on the next frame. */
let stagesVersion = 0;

/**
 * Override the render chain for this game.
 *
 * Call it at module scope beside `config()`. Calling it again REBUILDS the graph
 * before the next frame, which is what makes it survive HMR: a game module that
 * re-evaluates re-declares its stages, and the pipeline follows.
 *
 * The rebuild discards the passes and makes new ones rather than reusing them.
 * That is deliberate - `configure` mutates pass state, and there is no generic
 * way to undo an arbitrary mutation, so reusing passes would strand the previous
 * declaration's `setMRT` or `setResolutionScale` with each reload compounding the
 * last. Starting clean is the only version that stays correct under repeated HMR.
 */
export function setRenderPipeline(stages: RenderStages): void {
    activeStages = stages;
    stagesVersion++;
}

/**
 * the engine's single, persistent render pipeline. one set per backend, built
 * once at boot, then reused for every active room. swapping rooms mutates
 * `passNode.scene` (and the matrices on `camera`) instead of building a fresh
 * pipeline, so the compiled post-chain (fxaa + tint) is paid for exactly once.
 *
 * a fullscreen tint applied after fxaa is driven by `screenTint`, when `w=0` the
 * mix collapses to the input (free fast path). callers update the uniform each
 * frame based on the block at the camera position.
 */
export type EngineRenderPipeline = {
    pipeline: RenderPipeline;
    /**
     * the scene pass. its `scene` slot is mutated per frame to point at the active
     * room's scene (see `setActiveScene`); its `camera` slot is `pipeline.camera`,
     * set once at construction.
     */
    passNode: PassNode;
    /**
     * the camera the pass renders through — the backend's `Renderer.camera`, minted
     * in `create()` and passed to `createRenderPipeline`. composed each frame from
     * the active camera node's TransformTrait + CameraTrait via `render/common/camera`
     * (`syncCamera`). CameraTrait itself is plain projection data.
     */
    camera: PerspectiveCamera;
    /** rgba tint uniform, set w=0 for no tint. */
    screenTint: Uniform<d.vec4f>;
    /** kept so the pipeline can rebuild itself when the stages change. */
    renderer: GpuRenderer;
    /** the `stagesVersion` this graph was built from. */
    builtFrom: number;
    /**
     * the overlay pass: renders the active room's `overlayScene` (crisp CanvasTrait
     * panels, future world-space HUD) *after* fxaa, so overlays are never blurred
     * by the post-chain. its `scene` rotates to the active room in `setActiveScene`.
     * occlusion by world geometry is done per-material by *sampling* `sceneDepthNode`
     * and discarding (not a shared depth attachment).
     */
    overlayPassNode: PassNode;
    /**
     * the scene pass's depth as a sampled texture node. overlay materials `.load()`
     * it at their pixel to compare against their own `fragCoord.z` and discard
     * occluded fragments — the same resize-safe texture-binding path fxaa uses for
     * the scene color, so no shared-attachment lifetime hazards.
     */
    sceneDepthNode: DepthTextureNode;
};

export function createRenderPipeline(renderer: GpuRenderer, camera: PerspectiveCamera): EngineRenderPipeline {
    // the backend mints `camera` in create() and exposes it as `Renderer.camera`; the
    // pass binds it here. resolved per-frame from the active CameraTrait via
    // render/common/camera.

    // pass() needs a non-null Scene at construction; we use a throwaway
    // placeholder and mutate `passNode.scene = activeRoom.scene` each frame. the
    // placeholder is never rendered.
    const placeholderScene = new Scene();
    // NO MSAA, and it cannot be added here. Multisampling makes the depth
    // attachment multisampled, and WebGPU has no way to resolve depth - but this
    // pass's depth is SAMPLED downstream, by dom-ui's overlay occlusion, which
    // bind it as an ordinary texture_depth_2d. Enabling `samples` fails bind-group
    // validation for that reason, not through misconfiguration.
    const scenePass = pass(placeholderScene, camera, { label: 'scene' });

    // overlay pass: renders the active room's overlay scene composited over the
    // tinted scene, *after* the scene resolve (so CanvasTrait text/images stay
    // crisp). its
    // `scene` starts as the placeholder and rotates per room in `setActiveScene`.
    // empty overlay collapses to the tinted input (overlayTex.a == 0). occlusion
    // by world geometry is per-material: overlay materials sample `sceneDepthNode`
    // and discard, so this pass owns no shared depth (its own depth is unused).
    //
    // the overlay blends against a transparent-black clear with straight-alpha
    // factors (src-alpha / one-minus-src-alpha), so its texture is *premultiplied*
    // (rgb already × a). composite premultiplied-over: out = bg·(1−a) + rgb.
    const overlayPass = pass(placeholderScene, camera, {
        label: 'overlay',
        clearColor: [0, 0, 0, 0],
    });

    // BOTH passes exist before `configure` runs, so a game can reach either one -
    // and it runs before anything reads from them, so `setMRT` and
    // `setResolutionScale` land before the graph is shaped around their results.
    const stages = activeStages;
    stages.configure?.({ scenePass, overlayPass, camera });

    // fxaa over the scene texture, resolved straight into the tint.
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
 * Rebuild the graph if `setRenderPipeline` has been called since it was built.
 *
 * Driven from the top of each backend's `render`, before `setActiveScene`, so the
 * room re-binds on the same frame - `setActiveScene` already runs every frame, so
 * a fresh pass picks the active scene up with nothing extra to do.
 *
 * The engine object is mutated IN PLACE rather than replaced, because the client
 * and both backends hold references to it that would otherwise go stale.
 */
export function rebuildRenderPipelineIfStale(engine: EngineRenderPipeline): void {
    if (engine.builtFrom === stagesVersion) return;
    const previous = engine.pipeline;
    Object.assign(engine, createRenderPipeline(engine.renderer, engine.camera));
    previous.dispose?.();
}

/**
 * point the persistent passes at the active room's scenes (main 3D scene +
 * overlay scene) and flush their world matrices. `PassNode.scene` is `readonly`
 * in TS but read fresh each frame in `updateBefore`, so the runtime resolves the
 * swap on the next render.
 *
 * gpucat never auto-updates matrices, so a scene must be flushed each frame or
 * anything posed since the last render (editor gizmos, dom-ui quads) draws with a
 * stale/identity `matrixWorld`. Doing it here — at the single point where a scene
 * is bound for rendering — means you can't add a rendered scene without it being
 * made current. Cost is one matrix compose per direct child; both scenes are flat
 * batches, so it's negligible.
 */
export function setActiveScene(pipeline: EngineRenderPipeline, scene: Scene, overlayScene: Scene): void {
    scene.updateWorldMatrix();
    overlayScene.updateWorldMatrix();
    (pipeline.passNode as { scene: Scene }).scene = scene;
    (pipeline.overlayPassNode as { scene: Scene }).scene = overlayScene;
}

const _tintScratch: [number, number, number, number] = [0, 0, 0, 0];

/**
 * sample camera-relative world context (block at the eye, depth, etc) and push
 * the results into the engine-global pipeline uniforms. add new context-driven
 * uniforms here.
 */
export function updateCameraEnvironment(pipeline: EngineRenderPipeline, voxels: Voxels, camera: Camera): void {
    const p = camera.position;
    if (!getCameraTint(_tintScratch, voxels, p[0], p[1], p[2])) _tintScratch[3] = 0;
    pipeline.screenTint.value = _tintScratch;
}
