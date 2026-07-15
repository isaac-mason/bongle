// raster capability + hash helpers for the bake.
//
// The bake composites atlases with a 2d canvas. That's a browser API
// (OffscreenCanvas) in the editor and a native lib (@napi-rs/canvas) in node, so
// it's an INJECTED capability (`Raster`, the image analogue of `DecodeAudio`) —
// see raster-browser.ts for the OffscreenCanvas impl. The abstract handle types
// (RasterCanvas / RasterContext2D / RasterImage) are the minimal 2d subset the
// bake uses; both OffscreenCanvas and @napi-rs/canvas satisfy them structurally.
//
// Hashing stays here as plain exports: `crypto.subtle` is native in both the
// browser and node, so the rebuild-gate hashes need no injection.

/** an opaque decoded image (browser: ImageBitmap; node: canvas Image), usable as
 *  a drawImage source. `close()` frees it eagerly where the impl supports it
 *  (ImageBitmap); node images just GC, so it's optional. */
export type RasterImage = {
    readonly width: number;
    readonly height: number;
    close?(): void;
};

/** an offscreen raster surface (browser: OffscreenCanvas; node: Canvas), usable
 *  as a drawImage source and read back via `Raster.canvasPixels`. */
export type RasterCanvas = {
    readonly width: number;
    readonly height: number;
};

/** the 2d-context subset the bake (and user draw() fns) composite with. */
export type RasterContext2D = {
    imageSmoothingEnabled: boolean;
    fillStyle: string;
    drawImage(image: RasterImage | RasterCanvas, dx: number, dy: number): void;
    drawImage(image: RasterImage | RasterCanvas, dx: number, dy: number, dw: number, dh: number): void;
    fillRect(x: number, y: number, w: number, h: number): void;
};

/** host-injected raster capability (see pipeline InitCtx). */
export type Raster = {
    /** decode encoded image bytes (png/jpg/webp/…) to a drawImage source. */
    decodeBitmap(bytes: Uint8Array): Promise<RasterImage>;
    /** a fresh w×h surface + its 2d context (nearest sampling). */
    makeCanvas(w: number, h: number): { canvas: RasterCanvas; ctx: RasterContext2D };
    /** draw `src` scaled into a new w×h surface with nearest sampling. */
    scaleTo(src: RasterImage | RasterCanvas, w: number, h: number): RasterCanvas;
    /** raw rgba pixels of a surface (whole area). */
    canvasPixels(c: RasterCanvas): Uint8ClampedArray;
    /** encode a surface to png bytes. */
    encodePng(c: RasterCanvas): Promise<Uint8Array>;
};

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
