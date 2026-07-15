// lib/cli/raster-node.ts — the node Raster impl (node-canvas), sibling to the
// browser one (src/asset-pipeline/bake/raster-browser.ts). node-canvas's 2d
// context is CanvasRenderingContext2D-compatible, so it satisfies the abstract
// RasterContext2D / RasterCanvas / RasterImage structurally; the casts are the
// DOM-type ↔ node-type boundary.

import { createCanvas, loadImage } from 'canvas';
import type { Raster, RasterCanvas, RasterContext2D, RasterImage } from '../src/asset-pipeline/bake/raster';

export function createNodeRaster(): Raster {
    const makeCanvas = (w: number, h: number) => {
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        return { canvas, ctx };
    };
    return {
        async decodeBitmap(bytes) {
            return (await loadImage(Buffer.from(bytes))) as unknown as RasterImage;
        },
        makeCanvas: (w, h) => makeCanvas(w, h) as unknown as { canvas: RasterCanvas; ctx: RasterContext2D },
        scaleTo(src, w, h) {
            const { canvas, ctx } = makeCanvas(w, h);
            ctx.drawImage(src as unknown as Parameters<typeof ctx.drawImage>[0], 0, 0, w, h);
            return canvas as unknown as RasterCanvas;
        },
        canvasPixels(c) {
            const ctx = (c as unknown as ReturnType<typeof createCanvas>).getContext('2d');
            return ctx.getImageData(0, 0, c.width, c.height).data;
        },
        async encodePng(c) {
            return new Uint8Array((c as unknown as ReturnType<typeof createCanvas>).toBuffer('image/png'));
        },
    };
}
