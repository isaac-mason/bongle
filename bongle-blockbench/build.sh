#!/usr/bin/env bash
#
# Build the Blockbench bundle for the bongle editor.
#
#   1. Build the upstream Blockbench web app (pinned submodule at ./blockbench).
#   2. Assemble the static site: Blockbench runtime + the merged bongle plugin
#      (generic window.Bongle API + editor postMessage bridge) + branding.
#
# Output: lib/editor/public/static/blockbench  ->  served same-origin by the
# editor at /static/blockbench, embedded as an <iframe> by the editor's
# "blockbench" app. The assembled bundle is committed (the engine's build
# outputs are committed, not built in CI).

set -euo pipefail

# Blockbench's web build is esbuild-only (node ./build.js --target=web), but
# `electron` is a devDependency whose install script downloads a ~150MB binary
# nothing here runs. Skip it so npm install stays light in dev + CI.
export ELECTRON_SKIP_BINARY_DOWNLOAD=1

ROOT="$(cd "$(dirname "$0")" && pwd)"
BB="$ROOT/blockbench"
OUT="$ROOT/../editor/public/static/blockbench"

if [ ! -e "$BB/package.json" ]; then
	echo "error: the Blockbench submodule is not initialised." >&2
	echo "       run: git submodule update --init lib/bongle-blockbench/blockbench" >&2
	exit 1
fi

echo "==> Building upstream Blockbench web app"
( cd "$BB" && npm ci && npm run build-web )

echo "==> Assembling $OUT"
# Ship only what the served site loads (index.html + dist/bundle.js + css/,
# assets/, fonts, lang, ...). Blockbench's source tree (js/, types/, *.ts) and
# source maps are build input the browser never touches — excluding them slims
# the bundle ~5MB and keeps the website's tsc from type-checking Blockbench.
rm -rf "$OUT"
mkdir -p "$OUT"
rsync -a \
	--exclude '.git' \
	--exclude 'node_modules' \
	--exclude 'electron' \
	--exclude 'types' \
	--exclude '*.map' \
	--exclude '*.ts' \
	--exclude '/js' \
	"$BB/" "$OUT/"

# Bundle the plugin + branding + inject — shared with the fast, plugin-only
# rebuild (build-plugin.sh). Reuses the esbuild the Blockbench build just
# installed, so no extra network fetch here or in the Docker asset-builder.
"$ROOT/build-plugin.sh"

echo "==> Done. Static Blockbench in $OUT"
