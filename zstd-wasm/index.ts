// lib/zstd-wasm — zstd COMPRESS for the browser (editor) server.
//
// Our own tiny emscripten build (src/wrapper.c → dist/zstd.mjs, committed) so
// there's no permanent npm dep. Compress only; the client decodes with the
// hand-vendored fzstd (kept small for play-bundle size). Output is a standard
// zstd frame, so client fzstd + node game-room both interoperate.

// @ts-expect-error — committed emscripten build, no bundled types.
import createZstdModule from './dist/zstd.mjs';

type ZstdModule = {
    _malloc(n: number): number;
    _free(p: number): void;
    _zc_compress(dst: number, dstCap: number, src: number, srcSize: number, level: number): number;
    _zc_bound(srcSize: number): number;
    _zc_is_error(code: number): number;
    HEAPU8: Uint8Array;
};

let mod: ZstdModule | null = null;

/** Load the wasm module (once). Await before `zstdCompress`. */
export async function initZstd(): Promise<void> {
    if (!mod) mod = (await createZstdModule()) as ZstdModule;
}

/** zstd-compress `payload` (default level 3). Requires `initZstd()` first.
 *  Always re-reads `HEAPU8` after allocs (it can move under memory growth). */
export function zstdCompress(payload: Uint8Array, level = 3): Uint8Array {
    const m = mod;
    if (!m) throw new Error('[zstd-wasm] not initialized — await initZstd() first');
    const srcPtr = m._malloc(payload.length);
    m.HEAPU8.set(payload, srcPtr);
    const cap = m._zc_bound(payload.length);
    const dstPtr = m._malloc(cap);
    const size = m._zc_compress(dstPtr, cap, srcPtr, payload.length, level);
    const failed = m._zc_is_error(size) !== 0;
    const out = failed ? null : m.HEAPU8.slice(dstPtr, dstPtr + size);
    m._free(srcPtr);
    m._free(dstPtr);
    if (!out) throw new Error('[zstd-wasm] compress failed');
    return out;
}
