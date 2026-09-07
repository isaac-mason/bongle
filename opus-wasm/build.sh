#!/bin/sh
# Build lib/opus-wasm/dist/opus.mjs from src/wrapper.c + libopus (emscripten).
#
# Owns a tiny emscripten build instead of a permanent npm/native dep (mirrors
# lib/zstd-wasm). The opus source is fetched build-time only (gitignored); the
# OUTPUT (dist/opus.mjs, ~324KB / ~150KB gz, encode-only) is committed, so
# consumers never need emscripten or the opus checkout. Encode-only: the client
# decodes natively via decodeAudioData.
#
# Requires emsdk (emcc). Run: sh lib/opus-wasm/build.sh
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

OPUS_VER=1.5.2
# The git checkout needs autotools (autogen.sh); the release tarball ships a
# ready ./configure, so fetch that.
if [ ! -d opus ]; then
    echo "fetching opus $OPUS_VER (build-time only)…"
    curl -sSL -o "opus-$OPUS_VER.tar.gz" "https://downloads.xiph.org/releases/opus/opus-$OPUS_VER.tar.gz"
    tar xzf "opus-$OPUS_VER.tar.gz"
    mv "opus-$OPUS_VER" opus
fi

# No wasm SIMD: libopus has no wasm intrinsics paths (its SIMD is SSE/NEON, hence
# --disable-intrinsics), and -msimd128 autovectorization measured no encode speedup
# while adding ~48KB to the module.
OPUS_CFLAGS="-O3"

echo "building libopus.a (wasm)…"
cd opus
# rebuild when the flags change: the stamp records what .libs/libopus.a was built with.
if [ ! -f .libs/libopus.a ] || [ "$(cat .buildflags 2>/dev/null)" != "$OPUS_CFLAGS" ]; then
    [ -f Makefile ] && emmake make distclean >/dev/null 2>&1
    # --host forces autoconf into cross-compile mode (don't try to RUN wasm test
    # programs natively — the "cannot run C compiled programs" error otherwise).
    emconfigure ./configure --host=wasm32-unknown-emscripten \
        --disable-shared --disable-doc --disable-extra-programs \
        --disable-stack-protector --disable-intrinsics CFLAGS="$OPUS_CFLAGS" >/dev/null
    emmake make -j4 >/dev/null
    printf '%s' "$OPUS_CFLAGS" > .buildflags
fi
cd "$HERE"

echo "linking dist/opus.mjs…"
mkdir -p dist
emcc -O3 -I opus/include src/wrapper.c opus/.libs/libopus.a \
    -o dist/opus.mjs \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
    -sSINGLE_FILE=1 \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16 \
    -sEXPORTED_FUNCTIONS=_oe_init,_oe_encode,_oe_free,_malloc,_free \
    -sALLOW_MEMORY_GROWTH=1

echo "done: $HERE/dist/opus.mjs"
