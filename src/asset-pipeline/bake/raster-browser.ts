// the browser Raster impl (OffscreenCanvas / createImageBitmap / convertToBlob),
// the image analogue of decode-audio-browser.ts. Runs in a worker — no DOM
// canvas. The node impl (@napi-rs/canvas) is a sibling the pipeline CLI injects.

import type { Raster, RasterCanvas, RasterContext2D } from './raster';

export function createBrowserRaster(): Raster {
    const makeCanvas = (w: number, h: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } => {
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('[bongle] OffscreenCanvas 2d context unavailable');
        ctx.imageSmoothingEnabled = false;
        return { canvas, ctx };
    };
    return {
        decodeBitmap: (bytes) => createImageBitmap(new Blob([bytes as BlobPart])),
        makeCanvas: (w, h) => makeCanvas(w, h) as unknown as { canvas: RasterCanvas; ctx: RasterContext2D },
        scaleTo(src, w, h) {
            const { canvas, ctx } = makeCanvas(w, h);
            ctx.drawImage(src as unknown as CanvasImageSource, 0, 0, w, h);
            return canvas;
        },
        canvasPixels(c) {
            const ctx = (c as unknown as OffscreenCanvas).getContext('2d');
            if (!ctx) throw new Error('[bongle] OffscreenCanvas 2d context unavailable');
            return ctx.getImageData(0, 0, c.width, c.height).data;
        },
        async encodePng(c) {
            const blob = await (c as unknown as OffscreenCanvas).convertToBlob({ type: 'image/png' });
            return new Uint8Array(await blob.arrayBuffer());
        },
    };
}
