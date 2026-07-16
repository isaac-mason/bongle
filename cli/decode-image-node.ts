// lib/cli/decode-image-node.ts — the node `decodeImage` capability (sharp): the
// asset pipeline's raw-bytes image decode for the headless icon render stack.
// The engine's texture loaders (voxel-texture-array, model-resources) branch on
// `loader.decodeImage`: present (node) → raw RGBA uploaded directly; absent
// (browser) → createImageBitmap. Ported from the pre-World-C node pipeline.

import sharp from 'sharp';

export async function decodeImageNode(bytes: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8Array }> {
    const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}
