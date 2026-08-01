// Backend-neutral engine render pipeline.
//
// The single persistent post-chain — scene pass -> fxaa -> screen-tint -> overlay
// composite -> renderOutput — built once per backend and reused for every active
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
    type PassNode,
    PerspectiveCamera,
    pass,
    RenderPipeline,
    renderOutput,
    Scene,
    sub,
    Uniform,
    uniform,
    vec4f,
} from 'gpucat';
import { getCameraTint } from '../../core/voxels/camera-tint';
import type { Voxels } from '../../core/voxels/voxels';

/** the gpucat renderer either backend passes to `new RenderPipeline(...)` — its
 *  backend-neutral `Renderer` interface (WebGPURenderer / WebGLRenderer both fit). */
type GpuRenderer = ConstructorParameters<typeof RenderPipeline>[0];

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
     * the camera the pass renders through. composed each frame from the active
     * camera node's TransformTrait + CameraTrait via `syncRenderCamera`. owned
     * here, not by CameraTrait, CameraTrait is plain projection data.
     */
    camera: PerspectiveCamera;
    /** rgba tint uniform, set w=0 for no tint. */
    screenTint: Uniform<d.vec4f>;
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

export function createRenderPipeline(renderer: GpuRenderer): EngineRenderPipeline {
    const camera = new PerspectiveCamera(75 * (Math.PI / 180));

    // pass() needs a non-null Scene at construction; we use a throwaway
    // placeholder and mutate `passNode.scene = activeRoom.scene` each frame. the
    // placeholder is never rendered.
    const placeholderScene = new Scene();
    const scenePass = pass(placeholderScene, camera, { label: 'scene' });
    const fxaaPass = fxaa(scenePass.getTextureNode());

    const screenTint = new Uniform(d.vec4f, [0, 0, 0, 0]);
    const tintNode = uniform(screenTint);
    const tinted = vec4f(mix(fxaaPass.rgb, tintNode.rgb, tintNode.a), fxaaPass.a).toVar('tinted');

    // overlay pass: renders the active room's overlay scene composited over the
    // tinted scene, *after* fxaa (so CanvasTrait text/images stay crisp). its
    // `scene` starts as the placeholder and rotates per room in `setActiveScene`.
    // empty overlay collapses to the tinted input (overlayTex.a == 0). occlusion
    // by world geometry is per-material: overlay materials sample `sceneDepthNode`
    // and discard, so this pass owns no shared depth (its own depth is unused).
    //
    // the overlay blends against a transparent-black clear with straight-alpha
    // factors (src-alpha / one-minus-src-alpha), so its texture is *premultiplied*
    // (rgb already × a). composite premultiplied-over: out = bg·(1−a) + rgb.
    const sceneDepthNode = scenePass.getDepthTextureNode();
    const overlayPass = pass(placeholderScene, camera, {
        label: 'overlay',
        clearColor: [0, 0, 0, 0],
    });
    const overlayTex = overlayPass.getTextureNode();
    const overRgb = add(mul(tinted.rgb, sub(f32(1), overlayTex.a)), overlayTex.rgb);
    const composited = vec4f(overRgb, tinted.a).toVar('overlayComposite');

    const outputNode = renderOutput(composited);
    return {
        pipeline: new RenderPipeline(renderer, outputNode),
        passNode: scenePass,
        overlayPassNode: overlayPass,
        sceneDepthNode,
        camera,
        screenTint,
    };
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
