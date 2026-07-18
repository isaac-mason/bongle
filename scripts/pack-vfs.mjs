// scripts/pack-vfs.mjs — pack the editor's seed payload into one zip.
//
// bongle is a BUILT package now: the editor seeds its DIST (bundled js chunks,
// co-located .d.ts under dist/types, baked-input assets under dist/assets, and
// the prebuilt bongle.css) into its vfs node_modules, alongside the first-party
// libs (built dist js + d.ts), the dependency prebundle, and @webgpu/types. The
// editor's vfs resolver + per-module transform then treat bongle like any built
// npm package — resolving the SAME package.json `exports` the CLI + game build
// use (no bespoke seed package.json, no source tree, no parallel types tree).
//
// The archive is fetched + unzipped once into OPFS (engine-dist.ts). Zip paths
// are relative to the vfs node_modules root: `bongle/dist/index.js` →
// node_modules/bongle/dist/index.js. Runs LAST in `pnpm run build` (after the
// vite lib build → dist/, gather-lib-runtime → vendor/, build-deps → deps-dist/,
// tsgo → dist/types/) so all inputs exist.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_LIBS = ['mathcat', 'gpucat', 'crashcat', 'packcat'];

/** zip path → bytes. */
const files = {};
const enc = new TextEncoder();

const addFile = (zipPath, absPath) => {
    files[zipPath] = new Uint8Array(readFileSync(absPath));
};
const addTree = (zipPrefix, absDir, keep) => {
    if (!existsSync(absDir)) return;
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
        const abs = join(absDir, entry.name);
        const zp = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) addTree(zp, abs, keep);
        else if (!keep || keep(abs)) addFile(zp, abs);
    }
};

// ── bongle: the built DIST (js chunks + co-located d.ts under dist/types +
// baked-input assets under dist/assets + bongle.css) + the REAL package.json.
// The `source` condition is dropped (src isn't seeded — the editor resolves via
// import/types → dist). avatars/ ships raw too (matches the published package's
// `files`; the node-only sample-avatar fallback reads them off disk).
addTree('bongle/dist', join(ROOT, 'dist'));
addTree('bongle/avatars', join(ROOT, 'avatars'), (abs) => !abs.endsWith('.DS_Store'));
if (existsSync(join(ROOT, 'README.md'))) addFile('bongle/README.md', join(ROOT, 'README.md'));
// engine docs (the generated reader-facing markdown) → node_modules/bongle/docs,
// so the in-editor markdown viewer can open them.
for (const md of ['docs.md', 'api.md']) {
    if (existsSync(join(ROOT, 'docs', md))) addFile(`bongle/docs/${md}`, join(ROOT, 'docs', md));
}

const real = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
// seed the real exports, minus the `source` condition (src isn't in the seed).
const exportsForSeed = {};
for (const [key, val] of Object.entries(real.exports)) {
    if (typeof val === 'string') {
        exportsForSeed[key] = val;
    } else {
        const { source: _source, ...rest } = val;
        exportsForSeed[key] = rest;
    }
}
files['bongle/package.json'] = enc.encode(
    `${JSON.stringify({ name: 'bongle', version: real.version, type: 'module', exports: exportsForSeed }, null, 2)}\n`,
);

// ── dependency prebundle (scripts/build-deps.mjs → deps-dist/node_modules) ───
// react/react-dom/lucide/… as browser ESM, seeded at the vfs node_modules root.
const depsRoot = join(ROOT, 'deps-dist/node_modules');
if (!existsSync(depsRoot)) throw new Error('deps-dist missing — run `node scripts/build-deps.mjs` first');
addTree('', depsRoot);

// ── first-party libs (vendor/): built dist js + d.ts + package.json ──────────
// d.ts ride alongside the js now (bongle's d.ts reference them by bare specifier),
// so Monaco resolves their types from the same seeded package — no parallel tree.
for (const lib of VENDOR_LIBS) {
    const d = join(ROOT, 'vendor', lib);
    addFile(`${lib}/package.json`, join(d, 'package.json'));
    if (existsSync(join(d, 'README.md'))) addFile(`${lib}/README.md`, join(d, 'README.md'));
    addTree(`${lib}/dist`, join(d, 'dist'), (abs) => abs.endsWith('.js') || abs.endsWith('.d.ts'));
}

// ── @webgpu/types — ambient GPU* globals for Monaco (types-only package) ─────
const webgpuDir = dirname(require.resolve('@webgpu/types/package.json'));
addFile('@webgpu/types/package.json', join(webgpuDir, 'package.json'));
addTree('@webgpu/types', webgpuDir, (abs) => abs.endsWith('.d.ts'));

const zip = zipSync(files, { level: 6 });
const out = join(ROOT, 'editor/editor-node-modules.zip');
writeFileSync(out, zip);
console.log(`packed ${Object.keys(files).length} files → editor/editor-node-modules.zip (${(zip.length / 1024 / 1024).toFixed(2)} MB)`);
