#!/bin/sh
# Build lib/zstd-wasm/dist/zstd.mjs from src/wrapper.c + libzstd (emscripten).
#
# Owns a tiny emscripten build instead of a permanent npm dep. The zstd source
# is fetched build-time only (gitignored); the OUTPUT (dist/zstd.mjs) is
# committed, so consumers never need emscripten or the zstd checkout.
#
# Requires emsdk (emcc). Run: sh lib/zstd-wasm/build.sh
# 
# Last built with:
# > emcc --version
# emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.2 (7a2d97d627ff4945eae28847ce0387ac52b92c09)

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

# emscripten env (adjust EMSDK if yours lives elsewhere).
: "${EMSDK:=$HOME/Development/emsdk}"
# shellcheck disable=SC1091
. "$EMSDK/emsdk_env.sh" >/dev/null 2>&1

ZSTD_TAG=v1.5.6
if [ ! -d zstd ]; then
    echo "fetching zstd $ZSTD_TAG (build-time only)…"
    git clone --depth 1 --branch "$ZSTD_TAG" https://github.com/facebook/zstd.git zstd
fi

echo "building libzstd.a (wasm)…"
emmake make -C zstd/lib libzstd.a -j

echo "linking dist/zstd.mjs…"
emcc -O3 -I zstd/lib src/wrapper.c zstd/lib/libzstd.a \
    -o dist/zstd.mjs \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker \
    -sSINGLE_FILE=1 \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
    -sEXPORTED_FUNCTIONS=_zc_compress,_zc_bound,_zc_is_error,_malloc,_free \
    -sALLOW_MEMORY_GROWTH=1

echo "done: $HERE/dist/zstd.mjs"
