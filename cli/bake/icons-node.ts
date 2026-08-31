// lib/cli/bake/icons-node.ts — the node headless icon render (the GPU half of the
// pipeline), the sibling of the browser pipeline-worker's renderIcons(). Runs
// AFTER the data bake (reads the baked voxels-atlas.png back). Gated on the
// OPTIONAL `webgpu` (Dawn) dep — no binding, no icons, data bake unaffected.
//
// The GPU device is created from `webgpu` (Object.assign(globalThis, globals) +
// create([])) and injected into createHeadlessRenderContext; textures decode via
// the node-canvas `decodeImage` (no createImageBitmap/OffscreenCanvas in node);
// block meshing is the synchronous meshChunk path (no Web Worker). PNG encode is
// skia-canvas — sharp's libvips (pulled in transitively by gltf-transform) clashes
// with node-canvas's libgio on macOS, so the whole bake stays off node-canvas.

import { Canvas } from 'skia-canvas';
import type { Filesystem } from '../../os/interface';
import { createClientResourceLoader } from '../../src/asset-pipeline/loader';
import { decodeImageNode } from './decode-image-node';

// Dawn's AsyncRunner self-schedules a setImmediate that pumps ProcessEvents on the
// native instance. If V8 collects the instance while one of those is still queued,
// the callback locks a freed mutex and the process dies with SIGSEGV/SIGABRT. The
// locals below would go out of scope the moment renderIcons returns, so pin them
// here for the process lifetime; `bongle`'s one-shot exit(0) does the teardown.
const pinnedGpu: unknown[] = [];

/** the project's engine-asset-pipeline `Icons` namespace (same bongle instance as
 *  the data bake — shares the baked atlas + registry). */
type Icons = typeof import('../../src/asset-pipeline')['Icons'];

/** RGBA8 pixels → PNG bytes via skia-canvas (node; no OffscreenCanvas). */
function skiaEncodePng(pixels: Uint8Array, width: number, height: number): Uint8Array {
    const canvas = new Canvas(width, height);
    const ctx2d = canvas.getContext('2d');
    const imageData = ctx2d.createImageData(width, height);
    imageData.data.set(pixels);
    ctx2d.putImageData(imageData, 0, 0);
    return new Uint8Array(canvas.toBufferSync('png'));
}

export async function renderIcons(fs: Filesystem, Icons: Icons, atlasHash: string | null): Promise<boolean> {
    // one-shot bake: `cache: false` always re-renders, matching the data bake's
    // own cache flag (a hit can mask a draw-fn change between invocations).
    const plan = await Icons.planIconBake(fs, { atlasHash, cache: false });
    if (Icons.iconBakeIsNoop(plan)) return true;

    let webgpu: typeof import('webgpu');
    try {
        webgpu = await import('webgpu');
    } catch {
        console.log('  · icons: `webgpu` not installed — skipping (install it for headless icon rendering)');
        return false;
    }
    Object.assign(globalThis, webgpu.globals);
    const gpu = webgpu.create([]);
    pinnedGpu.push(gpu);
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
        console.log('  · icons: no GPU adapter — skipping');
        return false;
    }
    const device = await adapter.requestDevice();
    pinnedGpu.push(adapter, device);

    // reads baked client assets (voxels-atlas.png, model bins) back out of the fs,
    // with the node-canvas decoder attached for raw-bytes texture upload.
    const iconLoader = { ...createClientResourceLoader(fs), decodeImage: decodeImageNode };
    const ctx = await Icons.createHeadlessRenderContext({ device, adapter });
    const { deps, dispose } = await Icons.buildRenderDeps(ctx, iconLoader);
    try {
        const result = await Icons.runIconBake(deps, fs, plan, async (px, w, h) => skiaEncodePng(px, w, h));
        console.log(result.blockAtlas ? '  · icons: wrote voxels-icons.png' : '  · icons: no renderable blocks');
        if (result.prefabs > 0) console.log(`  · icons: wrote ${result.prefabs} prefab icon(s)`);
        return true;
    } finally {
        dispose();
    }
}
