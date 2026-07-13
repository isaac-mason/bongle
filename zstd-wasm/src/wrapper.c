// Minimal zstd COMPRESS wrapper for the browser editor server. Decompress is
// the client's job (hand-vendored fzstd, kept tiny for play-bundle size), so
// this exposes only compress + its bound. Thin C over libzstd; EMSCRIPTEN_
// KEEPALIVE forces the symbols into the wasm exports.

#include <zstd.h>
#include <emscripten.h>

EMSCRIPTEN_KEEPALIVE
size_t zc_compress(void *dst, size_t dstCap, const void *src, size_t srcSize, int level) {
    return ZSTD_compress(dst, dstCap, src, srcSize, level);
}

EMSCRIPTEN_KEEPALIVE
size_t zc_bound(size_t srcSize) {
    return ZSTD_compressBound(srcSize);
}

EMSCRIPTEN_KEEPALIVE
unsigned zc_is_error(size_t code) {
    return ZSTD_isError(code);
}
