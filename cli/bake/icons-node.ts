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
import type { Filesystem } from '../../src/asset-pipeline/filesystem';
import { createClientResourceLoader } from '../../src/asset-pipeline/loader';
import { decodeImageNode } from './decode-image-node';

/** the project's engine-asset-pipeline `Icons` namespace (same bongle instance as
 *  the data bake — shares the baked atlas + registry). */
type Icons = typeof import('../../src/asset-pipeline')['Icons'];

export async function renderBlockIcons(fs: Filesystem, Icons: Icons): Promise<boolean> {
    let webgpu: typeof import('webgpu');
    try {
        webgpu = await import('webgpu');
    } catch {
        console.log('  · icons: `webgpu` not installed — skipping (install it for headless icon rendering)');
        return false;
    }
    Object.assign(globalThis, webgpu.globals);
    const gpu = webgpu.create([]);
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
        console.log('  · icons: no GPU adapter — skipping');
        return false;
    }
    const device = await adapter.requestDevice();

    // reads baked client assets (voxels-atlas.png, model bins) back out of the fs,
    // with the node-canvas decoder attached for raw-bytes texture upload.
    const iconLoader = { ...createClientResourceLoader(fs), decodeImage: decodeImageNode };
    const ctx = await Icons.createHeadlessRenderContext({ device, adapter });
    const { deps, dispose } = await Icons.buildRenderDeps(ctx, iconLoader);
    try {
        const atlas = await Icons.renderBlockIconAtlas(deps);
        if (atlas.atlasWidth === 0 || atlas.atlasHeight === 0) {
            console.log('  · icons: no renderable blocks — nothing to write');
            return false;
        }
        const canvas = new Canvas(atlas.atlasWidth, atlas.atlasHeight);
        const ctx2d = canvas.getContext('2d');
        const imageData = ctx2d.createImageData(atlas.atlasWidth, atlas.atlasHeight);
        imageData.data.set(atlas.pixels);
        ctx2d.putImageData(imageData, 0, 0);
        const png = canvas.toBufferSync('png');
        await fs.write('resources/client/voxels-icons.png', new Uint8Array(png));
        await fs.write(
            'resources/client/voxels-icons.json',
            JSON.stringify({
                coords: atlas.coords,
                cols: atlas.cols,
                rows: atlas.rows,
                iconPx: atlas.iconPx,
                atlasWidth: atlas.atlasWidth,
                atlasHeight: atlas.atlasHeight,
            }),
        );
        console.log(`  · icons: wrote voxels-icons.png (${(png.length / 1024).toFixed(0)} KB)`);
        return true;
    } finally {
        dispose();
    }
}
