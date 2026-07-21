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
# Assemble into a staging dir; build-plugin.sh content-hashes it and moves it to
# $OUT/<hash>/ (see scripts/stamp.mjs). $OUT holds exactly one <hash>/ dir.
STAGING="$OUT/.staging"

if [ ! -e "$BB/package.json" ]; then
	echo "error: the Blockbench submodule is not initialised." >&2
	echo "       run: git submodule update --init lib/blockbench/blockbench" >&2
	exit 1
fi

echo "==> Building upstream Blockbench web app"
( cd "$BB" && npm ci && npm run build-web )

echo "==> Assembling $STAGING"
# Ship only what the served site loads. Blockbench's source tree (js/, types/,
# *.ts) + source maps are build input the browser never touches; the rest of the
# excludes are repo/dev files, the desktop-app build + electron icons, and PWA
# extras that an embedded iframe doesn't use.
rm -rf "$STAGING"
mkdir -p "$STAGING"
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
	"$BB/" "$STAGING/"

# Trim runtime assets we don't need embedded: keep only the English locale
# (Blockbench fetches others on demand; the embed runs in English) and drop the
# start-screen promo images (the start screen is skipped), keeping news.json.
find "$STAGING/lang" -type f -name '*.json' ! -name 'en.json' -delete 2>/dev/null || true
find "$STAGING/content" -type f ! -name 'news.json' -delete 2>/dev/null || true

# Neuter Blockbench's plugin-stats telemetry: on load it `$.getJSON`s
# blckbn.ch/api/stats/plugins, which fails CORS from the embed origin (their API
# only allows web.blockbench.net) and spams the console. Repoint it at an inline
# empty JSON result so it resolves cleanly with no network call. (node, not sed,
# for macOS/Linux portability — the Blockbench build already needs node.)
node -e 'const f=process.argv[1],fs=require("fs");fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace("https://blckbn.ch/api/stats/plugins?weeks=2","data:application/json,[]"))' "$STAGING/dist/bundle.js"

# Bundle the plugin + branding + inject, then content-hash the staged bundle into
# $OUT/<hash>/. Shared with the fast, plugin-only rebuild (build-plugin.sh);
# reuses the esbuild the Blockbench build just installed, so no extra network
# fetch here or in the Docker asset-builder.
"$ROOT/build-plugin.sh" "$STAGING"

echo "==> Done. Static Blockbench in $OUT"
