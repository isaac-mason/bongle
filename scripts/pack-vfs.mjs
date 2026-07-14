// scripts/pack-vfs.mjs — pack the editor's seed payload into one zip.
//
// The editor seeds its vfs node_modules from THIS archive (fetched + unzipped
// once into OPFS) instead of inlining every file into the editor bundle via
// import.meta.glob (which bloated the bundle) + fetching each asset separately.
// One compressed download, unpacked once. Zip paths are relative to the vfs
// node_modules root: `bongle/dist/index.js` → node_modules/bongle/dist/index.js.
//
// Runs LAST in `pnpm run build` (after vite build → dist/, gather-lib-runtime →
// vendor/, tsgo → dist/types/, gather-lib-types) so all inputs — runtime JS AND
// the emitted .d.ts — exist. Emits editor/editor-node-modules.zip, which
// engine-dist.ts imports via ?url.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_LIBS = ['mathcat', 'gpucat', 'crashcat', 'packcat'];

/** zip path → bytes. */
const files = {};
const enc = new TextEncoder();

const addFile = (zipPath, absPath) => {
    files[zipPath] = new Uint8Array(readFileSync(absPath));
};
const addTree = (zipPrefix, absDir, keep) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
        const abs = join(absDir, entry.name);
        const zp = `${zipPrefix}/${entry.name}`;
        if (entry.isDirectory()) addTree(zp, abs, keep);
        else if (!keep || keep(abs)) addFile(zp, abs);
    }
};

// bongle: the built dist (js/css/assets), minus sourcemaps.
addTree('bongle/dist', join(ROOT, 'dist'), (abs) => !abs.includes(`${sep}types${sep}`) && !abs.endsWith('.map'));
files['bongle/package.json'] = enc.encode(`${JSON.stringify({ name: 'bongle', type: 'module' })}\n`);
if (existsSync(join(ROOT, 'README.md'))) addFile('bongle/README.md', join(ROOT, 'README.md'));
if (existsSync(join(ROOT, 'docs'))) {
    addTree('bongle/docs', join(ROOT, 'docs'), (abs) => abs.endsWith('.md') && !abs.includes(`${sep}template${sep}`));
}

// bongle + first-party lib type declarations + @webgpu/types ambient globals
// (emitted by tsgo, gathered by gather-lib-types.mjs). The bongle package.json is
// a types-aware exports map so Monaco resolves bare specifiers to .d.ts; the libs
// resolve as their own node_modules packages (user code imports them directly).
const typesRoot = join(ROOT, 'dist/types/node_modules');
for (const pkg of ['bongle', ...VENDOR_LIBS, '@webgpu/types']) {
    const dir = join(typesRoot, pkg);
    if (existsSync(dir)) addTree(pkg, dir);
}

// first-party libs (from vendor/): package.json + built js + README.
for (const lib of VENDOR_LIBS) {
    const d = join(ROOT, 'vendor', lib);
    addFile(`${lib}/package.json`, join(d, 'package.json'));
    if (existsSync(join(d, 'README.md'))) addFile(`${lib}/README.md`, join(d, 'README.md'));
    addTree(`${lib}/dist`, join(d, 'dist'), (abs) => abs.endsWith('.js'));
}

const zip = zipSync(files, { level: 6 });
const out = join(ROOT, 'editor/editor-node-modules.zip');
writeFileSync(out, zip);
console.log(`packed ${Object.keys(files).length} files → editor/editor-node-modules.zip (${(zip.length / 1024 / 1024).toFixed(2)} MB)`);
