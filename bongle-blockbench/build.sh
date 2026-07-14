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
# Ship only what the served site loads. Blockbench's source tree (js/, types/,
# *.ts) + source maps are build input the browser never touches; the rest of the
# excludes are repo/dev files, the desktop-app build + electron icons, and PWA
# extras that an embedded iframe doesn't use.
rm -rf "$OUT"
mkdir -p "$OUT"
rsync -a \
	--exclude '.git' --exclude '.github' --exclude '.vscode' \
	--exclude 'node_modules' --exclude 'electron' --exclude 'types' \
	--exclude '*.map' --exclude '*.ts' --exclude '/js' \
	--exclude '/build' --exclude '/scripts' --exclude 'build.js' \
	--exclude 'package.json' --exclude 'package-lock.json' \
	--exclude 'tsconfig.json' --exclude 'typedoc.*' \
	--exclude 'README.md' --exclude 'CONTRIBUTING.md' --exclude 'CODE_OF_CONDUCT.MD' \
	--exclude '.gitattributes' --exclude '.gitignore' --exclude '.travis.yml' --exclude 'CNAME' \
	--exclude 'icon.icns' --exclude 'icon.ico' --exclude 'icon.png' --exclude 'icon_maskable.png' \
	--exclude 'manifest-beta.webmanifest' \
	"$BB/" "$OUT/"

# Trim runtime assets we don't need embedded: keep only the English locale
# (Blockbench fetches others on demand; the embed runs in English) and drop the
# start-screen promo images (the start screen is skipped), keeping news.json.
find "$OUT/lang" -type f -name '*.json' ! -name 'en.json' -delete 2>/dev/null || true
find "$OUT/content" -type f ! -name 'news.json' -delete 2>/dev/null || true

# Bundle the plugin + branding + inject — shared with the fast, plugin-only
# rebuild (build-plugin.sh). Reuses the esbuild the Blockbench build just
# installed, so no extra network fetch here or in the Docker asset-builder.
"$ROOT/build-plugin.sh"

echo "==> Done. Static Blockbench in $OUT"
