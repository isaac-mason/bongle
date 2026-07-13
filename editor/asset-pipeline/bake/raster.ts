// browser-native raster + hash helpers for the bake.
//
// The pipeline runs in a worker with OffscreenCanvas / createImageBitmap /
// crypto.subtle — no sharp, no skia-canvas, no node:crypto. Image decode is
// createImageBitmap; nearest-neighbour scaling is a smoothing-off drawImage;
// png encode is convertToBlob. Hashing is Web Crypto SHA-256 (async, same as
// audio's gate).

/** decode encoded image bytes (png/jpg/webp/…) to an ImageBitmap. */
export function decodeBitmap(bytes: Uint8Array): Promise<ImageBitmap> {
    return createImageBitmap(new Blob([bytes as BlobPart]));
}

/** a fresh w×h OffscreenCanvas + its 2d context (nearest sampling). */
export function makeCanvas(w: number, h: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('[bongle] OffscreenCanvas 2d context unavailable');
    ctx.imageSmoothingEnabled = false;
    return { canvas, ctx };
}

/** draw `src` scaled into a new w×h canvas with nearest sampling. */
export function scaleTo(src: CanvasImageSource, w: number, h: number): OffscreenCanvas {
    const { canvas, ctx } = makeCanvas(w, h);
    ctx.drawImage(src, 0, 0, w, h);
    return canvas;
}

/** raw rgba pixels of a canvas (whole surface). */
export function canvasPixels(c: OffscreenCanvas): Uint8ClampedArray {
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('[bongle] OffscreenCanvas 2d context unavailable');
    return ctx.getImageData(0, 0, c.width, c.height).data;
}

/** encode an OffscreenCanvas to png bytes. */
export async function encodePng(c: OffscreenCanvas): Promise<Uint8Array> {
    const blob = await c.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
}

/** SHA-256 hex of some bytes (Web Crypto; browser + node webcrypto). */
export async function sha256Hex(bytes: Uint8Array | Uint8ClampedArray): Promise<string> {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const digest = await crypto.subtle.digest('SHA-256', buf as unknown as BufferSource);
    const view = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < view.length; i++) hex += view[i]!.toString(16).padStart(2, '0');
    return hex;
}

const textEncoder = new TextEncoder();

/** SHA-256 hex over a list of string/bytes parts, length-delimited. */
export async function sha256HexParts(parts: (string | Uint8Array | Uint8ClampedArray)[]): Promise<string> {
    const chunks: Uint8Array[] = [];
    for (const p of parts) {
        const bytes =
            typeof p === 'string'
                ? textEncoder.encode(p)
                : p instanceof Uint8Array
                  ? p
                  : new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
        const len = new Uint8Array(4);
        new DataView(len.buffer).setUint32(0, bytes.length);
        chunks.push(len, bytes);
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const flat = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        flat.set(c, off);
        off += c.length;
    }
    return sha256Hex(flat);
}
