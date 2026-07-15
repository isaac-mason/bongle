// scripts/pack-vfs.mjs — pack the editor's seed payload into one zip.
//
// World C (llm/plan-in-browser-editor.md): the editor seeds bongle as SOURCE
// (not a dist prebundle) into its vfs node_modules, alongside the first-party
// libs, the dependency prebundle (scripts/build-deps.mjs), and the engine
// stylesheet. The editor's vfs resolver + per-module transform then treat bongle
// like any source package — one package.json surface, npm-native.
//
// The archive is fetched + unzipped once into OPFS (engine-dist.ts). Zip paths
// are relative to the vfs node_modules root: `bongle/src/index.ts` →
// node_modules/bongle/src/index.ts. Runs LAST in `pnpm run build` (after
// build-deps → deps-dist/, gather-lib-runtime → vendor/, tsgo → dist/types/,
// gather-lib-types) so all inputs exist.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
    if (!existsSync(absDir)) return;
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
        const abs = join(absDir, entry.name);
        const zp = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) addTree(zp, abs, keep);
        else if (!keep || keep(abs)) addFile(zp, abs);
    }
};

// ── bongle: SOURCE tree + a source-pointing package.json ────────────────────
// The whole src/ (ts/tsx AND binary assets — ogg/png/glb referenced by
// `new URL(x, import.meta.url)` resolve to these vfs files) + interface/. No
// dist js: the editor transforms the source per-module.
addTree('bongle/src', join(ROOT, 'src'));
addTree('bongle/interface', join(ROOT, 'interface'));
// root-level asset dirs referenced by source via `new URL('../../../avatars/…',
// import.meta.url)` (escapes src/) — seed them at the same bongle-relative path.
addTree('bongle/avatars', join(ROOT, 'avatars'));
// engine stylesheet: still prebuilt (tailwind) into dist/bongle.css and injected
// by client-main from this path — the one build artifact bongle source can't
// produce in-browser. `import './editor.css'` in source resolves to an empty
// module (the editor's transform handles .css); this file carries the styles.
if (existsSync(join(ROOT, 'dist/bongle.css'))) addFile('bongle/dist/bongle.css', join(ROOT, 'dist/bongle.css'));
if (existsSync(join(ROOT, 'README.md'))) addFile('bongle/README.md', join(ROOT, 'README.md'));

// source-pointing exports, derived from lib/package.json (the ONE public
// surface). Keep entries whose target is a seeded ./src or ./interface source
// file; add the `env` seam (bongle source imports it, the editor resolves it);
// drop the dead editor/fs* entries (0 consumers, not seeded).
const real = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const bongleExports = {};
for (const [key, val] of Object.entries(real.exports)) {
    const target = typeof val === 'string' ? val : (val.import ?? val.default);
    if (typeof target !== 'string') continue;
    if (!/^\.\/(src|interface)\/.*\.tsx?$/.test(target) && target !== './src/index.ts') continue;
    bongleExports[key] = target;
}
bongleExports['./env'] ??= './src/api/env.ts';
bongleExports['./package.json'] = './package.json';
files['bongle/package.json'] = enc.encode(
    `${JSON.stringify({ name: 'bongle', version: real.version, type: 'module', exports: bongleExports }, null, 2)}\n`,
);

// ── dependency prebundle (scripts/build-deps.mjs → deps-dist/node_modules) ───
// react/react-dom/lucide/… as browser ESM, seeded at the vfs node_modules root.
const depsRoot = join(ROOT, 'deps-dist/node_modules');
if (!existsSync(depsRoot)) throw new Error('deps-dist missing — run `node scripts/build-deps.mjs` first');
addTree('', depsRoot);

// ── first-party libs (vendor/): built dist js + package.json ────────────────
for (const lib of VENDOR_LIBS) {
    const d = join(ROOT, 'vendor', lib);
    addFile(`${lib}/package.json`, join(d, 'package.json'));
    if (existsSync(join(d, 'README.md'))) addFile(`${lib}/README.md`, join(d, 'README.md'));
    addTree(`${lib}/dist`, join(d, 'dist'), (abs) => abs.endsWith('.js'));
}

// ── types for Monaco ────────────────────────────────────────────────────────
// bongle types come from its seeded .ts source directly (no d.ts gathering). The
// first-party libs ship as built js, so their d.ts + @webgpu ambient globals are
// still gathered (gather-lib-types.mjs) for Monaco.
const typesRoot = join(ROOT, 'dist/types/node_modules');
for (const pkg of [...VENDOR_LIBS, '@webgpu/types']) {
    addTree(pkg, join(typesRoot, pkg));
}

const zip = zipSync(files, { level: 6 });
const out = join(ROOT, 'editor/editor-node-modules.zip');
writeFileSync(out, zip);
console.log(`packed ${Object.keys(files).length} files → editor/editor-node-modules.zip (${(zip.length / 1024 / 1024).toFixed(2)} MB)`);
