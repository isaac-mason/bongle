// lib/cli/pipeline/decode-image-node.ts — the node `decodeImage` capability, over
// skia-canvas. The engine's texture loaders (voxel-texture-array, model-resources)
// branch on `loader.decodeImage`: present (node) → raw RGBA uploaded directly;
// absent (browser) → createImageBitmap.
//
// skia-canvas (Skia), not node-canvas: the bake also loads sharp (gltf-transform
// pulls it in transitively), and node-canvas's libgio clashes with sharp's libvips
// over the GObject runtime on macOS (→ SIGSEGV). Skia carries no GObject native.

import { Canvas, loadImage } from 'skia-canvas';

export async function decodeImageNode(bytes: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8Array }> {
    const img = await loadImage(Buffer.from(bytes));
    const canvas = new Canvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    return { width: img.width, height: img.height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}
