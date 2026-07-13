#!/usr/bin/env bash
#
# Fast path: re-bundle ONLY the bongle plugin (esbuild) + branding, and re-inject,
# into the already-assembled Blockbench bundle at lib/editor/public/static/blockbench.
# It does NOT rebuild upstream Blockbench (that's build.sh, run once). Use this
# while iterating on plugin/ (generic.js / bridge.js) or overlay/.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BB="$ROOT/blockbench"
OUT="$ROOT/../editor/public/static/blockbench"

if [ ! -e "$OUT/index.html" ]; then
	echo "error: Blockbench bundle not assembled yet at $OUT." >&2
	echo "       run the full build once first: pnpm -C lib run blockbench:build" >&2
	exit 1
fi

ESBUILD="$BB/node_modules/.bin/esbuild"
if [ ! -x "$ESBUILD" ]; then
	echo "error: esbuild not found at $ESBUILD." >&2
	echo "       run the full build once first (it installs it): pnpm -C lib run blockbench:build" >&2
	exit 1
fi

echo "==> Bundling merged bongle plugin (generic + bridge)"
# The starter .bbmodel is inlined at build time via the json loader.
"$ESBUILD" "$ROOT/plugin/src/index.js" \
	--bundle --format=iife --loader:.bbmodel=json --outfile="$OUT/bongle.js"

echo "==> Overlaying branding + injecting"
[ -d "$ROOT/overlay" ] && cp -R "$ROOT/overlay/." "$OUT/"
node "$ROOT/scripts/inject.mjs" "$OUT/index.html"

echo "==> Done. Plugin re-bundled into $OUT"
