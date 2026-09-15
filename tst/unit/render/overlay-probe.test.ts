import {
    createBoxGeometry,
    LineMaterial,
    LineSegmentsGeometry,
    Material,
    Mesh,
    PerspectiveCamera,
    pass,
    positionClip,
    RenderPipeline,
    RenderTarget,
    readPixels,
    renderOutput,
    Scene,
    vec4f,
    WebGPURenderer,
} from 'gpucat';
import { describe, expect, it } from 'vitest';
import * as Lines from '../../../src/render/overlay/lines';
import * as Quads from '../../../src/render/overlay/quads';

async function makeRenderer(): Promise<WebGPURenderer> {
    const { create, globals } = await import('webgpu');
    Object.assign(globalThis, globals);
    const gpu = create([]);
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error('no GPU adapter');
    const device = await adapter.requestDevice();
    device.addEventListener('uncapturederror', (e) => {
        // biome-ignore lint/suspicious/noExplicitAny: diagnostic
        console.error('[gpu]', (e as any).error?.message);
    });
    const renderer = new WebGPURenderer({ antialias: false, headless: true, device, adapter, format: 'rgba8unorm' });
    await renderer.init();
    return renderer;
}

// the engine pipeline aborts Dawn headlessly; PROBE_ENGINE=1 opts into that half.
const ENGINE_PASS = process.env.PROBE_ENGINE === '1';

function magentaPixels(rgba: Uint8Array): number {
    let n = 0;
    for (let i = 0; i < rgba.length; i += 4) if (rgba[i]! > 150 && rgba[i + 1]! < 80 && rgba[i + 2]! > 150) n++;
    return n;
}

async function renderScene(renderer: WebGPURenderer, scene: Scene, cameraZ: number, engine: boolean): Promise<number> {
    const camera = new PerspectiveCamera(Math.PI / 3, 1, 0.1, 100);
    camera.position[2] = cameraZ;
    camera.lookAt([0, 0, 0]);
    camera.updateWorldMatrix();
    camera.updateViewMatrix();
    camera.updateProjectionMatrix();
    const target = new RenderTarget(64, 64, { colorFormat: 'rgba8unorm' });
    renderer.renderTarget = target;
    scene.updateWorldMatrix();
    void engine;
    const pipeline = new RenderPipeline(renderer, renderOutput(pass(scene, camera, { clearColor: [0, 0, 0, 1] })));
    pipeline.render();
    const pixels = await readPixels(renderer, target);
    return magentaPixels(pixels);
}

describe('overlay probe', () => {
    it('renders the three batches headlessly', async () => {
        const renderer = await makeRenderer();

        const solid = new Scene();
        const box = new Mesh(createBoxGeometry(2, 2, 2), new Material({ vertex: positionClip, fragment: vec4f(1, 0, 1, 1) }));
        box.frustumCulled = false;
        solid.add(box);
        const solidLit = [
            await renderScene(renderer, solid, 5, false),
            ENGINE_PASS ? await renderScene(renderer, solid, 5, true) : -1,
        ];

        const control = new Scene();
        const geometry = new LineSegmentsGeometry([-1, 0, 0, 1, 0, 0], 4);
        const mesh = new Mesh(geometry, new LineMaterial({ color: vec4f(1, 0, 1, 1), lineWidth: 5 }));
        mesh.frustumCulled = false;
        control.add(mesh);
        const controlLit = [
            await renderScene(renderer, control, 5, false),
            ENGINE_PASS ? await renderScene(renderer, control, 5, true) : -1,
        ];

        const ours = new Scene();
        const lines = Lines.init(ours, 16, 5);
        Lines.begin(lines, 1);
        Lines.line(lines, -1, 0, 0, 1, 0, 0, 1, 0, 1, 1);
        Lines.end(lines);
        const linesLit = [
            await renderScene(renderer, ours, 5, false),
            ENGINE_PASS ? await renderScene(renderer, ours, 5, true) : -1,
        ];

        const quadScene = new Scene();
        const quads = Quads.init(quadScene, 16);
        Quads.begin(quads, 1);
        Quads.dot(quads, 0, 0, 0, 20, 1, 0, 1, 1);
        Quads.end(quads);
        const quadsLit = [
            await renderScene(renderer, quadScene, 5, false),
            ENGINE_PASS ? await renderScene(renderer, quadScene, 5, true) : -1,
        ];

        expect(solidLit[0], 'solid box').toBeGreaterThan(0);
        expect(controlLit[0], 'gpucat line control').toBeGreaterThan(0);
        expect(linesLit[0], 'lines batch').toBeGreaterThan(0);
        expect(quadsLit[0], 'quads batch through the placeholder atlas').toBeGreaterThan(0);
    }, 60_000);
});
