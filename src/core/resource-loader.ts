/**
 * src/core/resource-loader.ts — the engine's environment resource-I/O capability.
 *
 * Injected into the engine and carried on `Resources` (passed to the texture
 * loaders). Each environment supplies its own:
 *   - client: `loadBytes` = fetch(assetUrl); NO `decodeImage` — the client uses
 *     its DOM image path (createImageBitmap / canvas) inline, unchanged.
 *   - asset pipeline (src/asset-pipeline): `loadBytes` = disk read; `decodeImage`
 *     = sharp.
 *
 * Keeping the sharp implementation behind this injected type is what keeps it
 * out of the client bundle: shared/client code only ever imports the TYPE, and
 * the decode impl lives in the Node-only asset-pipeline entry. There is no
 * conditional `import('sharp')` for a bundler to mis-resolve.
 */

export type ResourceLoader = {
    /** Load an asset's raw bytes by relative url/path (side-picked in `ensureModel`). */
    loadBytes(url: string): Promise<Uint8Array>;
    /**
     * Decode encoded image bytes → RGBA + dimensions. Present ONLY where the
     * environment has no DOM image APIs — i.e. the asset pipeline. When present,
     * the texture loaders take their pipeline branch (loadBytes + decodeImage);
     * when absent (the client), they use the browser DOM path unchanged.
     */
    decodeImage?(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number; rgba: Uint8Array }>;
};
