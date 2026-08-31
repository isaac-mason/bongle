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

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_LIBS = ['math', 'gpucat', 'crashcat', 'packcat', 'dashcat'];

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
// `sideEffects` for the SEEDED manifest, which ships dist/ ONLY. The real package.json's array is
// SRC-relative (`src/builtins/**`, `src/index.ts`, …) and matches nothing under dist/, so copying it
// verbatim would declare the whole engine side-effect-free and let a game build drop the builtin
// registrations. Computed against what we actually pack instead: every dist js is side-effectful
// EXCEPT the kit area entries, which are pure declaration modules (`export const stone = block(…)`)
// and are the point of the whole exercise — a game that touches two blocks should ship two, not 198.
// A NEW chunk is side-effectful by default, which is the safe direction to fail in.
//
// The kit targets come off the `./kit/*` exports, so the two can't drift — but the target carries
// the subpath `*` (`./dist/kit-*.js`), so match it as a pattern rather than a literal.
const isKitTarget = (() => {
    const patterns = Object.entries(exportsForSeed)
        .filter(([subpath]) => subpath.startsWith('./kit/'))
        .map(([, target]) => (typeof target === 'string' ? target : (target.import ?? target.default)))
        .map((t) => new RegExp(`^${t.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`));
    if (patterns.length === 0) throw new Error('pack-vfs: no ./kit/* export — the kit leaves would seed as side-effectful');
    return (rel) => patterns.some((re) => re.test(rel));
})();
const sideEffects = Object.keys(files)
    .filter((p) => p.startsWith('bongle/dist/') && p.endsWith('.js'))
    .map((p) => `./${p.slice('bongle/'.length)}`)
    .filter((rel) => !isKitTarget(rel))
    .sort();

files['bongle/package.json'] = enc.encode(
    `${JSON.stringify({ name: 'bongle', version: real.version, type: 'module', exports: exportsForSeed, sideEffects }, null, 2)}\n`,
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

// ── examples/ (source only) → node_modules/bongle/examples/<name> ────────────
// seed the first-party example projects as free, in-editor reference code (the
// file tree grays node_modules + Monaco opens it read-only, so they read like a
// bundled reference). performance-* benchmarks are dev noise — skipped. Build
// output + deps + baked resources are excluded: just the authored src/content.
const EXAMPLE_SKIP_DIRS = new Set(['node_modules', 'dist', 'resources']);
const addExampleTree = (zipPrefix, absDir) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
        if (entry.name === '.DS_Store') continue;
        const abs = join(absDir, entry.name);
        const zp = `${zipPrefix}/${entry.name}`;
        if (entry.isDirectory()) {
            if (EXAMPLE_SKIP_DIRS.has(entry.name)) continue;
            addExampleTree(zp, abs);
        } else addFile(zp, abs);
    }
};
const examplesRoot = join(ROOT, 'examples');
if (existsSync(examplesRoot)) {
    for (const entry of readdirSync(examplesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('performance-')) continue;
        addExampleTree(`bongle/examples/${entry.name}`, join(examplesRoot, entry.name));
    }
}

// ── @webgpu/types — ambient GPU* globals for Monaco (types-only package) ─────
const webgpuDir = dirname(require.resolve('@webgpu/types/package.json'));
addFile('@webgpu/types/package.json', join(webgpuDir, 'package.json'));
addTree('@webgpu/types', webgpuDir, (abs) => abs.endsWith('.d.ts'));

// ── @types/react (+ react-dom) — declarations for the prebundled React ───────
// build-deps.mjs emits browser ESM only, so the seeded `react` carries no .d.ts.
// A project writing JSX (tsconfig `jsx: react-jsx` → `react/jsx-runtime`) then
// gets TS7016 on the runtime import and TS7026 for a missing JSX.IntrinsicElements,
// with every element falling back to `any`. React is version-locked to the editor
// exactly like the first-party libs above, so its types ship the same way theirs do.
// TS finds these by convention (node_modules/@types/<pkg>), so the prebundled
// package.json needs no `types` field.
const addTypesPackage = (spec, resolver) => {
    const dir = dirname(resolver.resolve(`${spec}/package.json`));
    addFile(`${spec}/package.json`, join(dir, 'package.json'));
    addTree(spec, dir, (abs) => abs.endsWith('.d.ts'));
    return dir;
};
const typesReactDir = addTypesPackage('@types/react', require);
addTypesPackage('@types/react-dom', require);
// csstype is @types/react's OWN dependency and pnpm doesn't hoist it here, so
// resolve it from there. Without it `CSSProperties` degrades to `any` under
// skipLibCheck and every `style={{ … }}` silently stops being checked.
addTypesPackage('csstype', createRequire(join(typesReactDir, 'package.json')));

// Dev serves this zip from localhost + unzips straight into OPFS, so compression
// is wasted CPU per rebuild — dev.sh sets BONGLE_VFS_ZIP_LEVEL=0 (store). Prod
// (website Docker build) leaves it unset → level 6 for the R2/network payload.
const zipLevel = process.env.BONGLE_VFS_ZIP_LEVEL ? Number(process.env.BONGLE_VFS_ZIP_LEVEL) : 6;
const zip = zipSync(files, { level: zipLevel });
// The seed is consumed by the platform editor shell (apps/editor/engine-dist.ts). Write
// it there when the monorepo is present; fall back to lib/editor for a standalone lib
// build (a bare bongle checkout with no platform sibling — which doesn't need the seed).
const appsEditor = join(ROOT, '../apps/editor');
const out = existsSync(appsEditor) ? join(appsEditor, 'editor-node-modules.zip') : join(ROOT, 'editor/editor-node-modules.zip');
writeFileSync(out, zip);
const outLabel = existsSync(appsEditor) ? 'apps/editor/editor-node-modules.zip' : 'editor/editor-node-modules.zip';
console.log(`packed ${Object.keys(files).length} files → ${outLabel} (${(zip.length / 1024 / 1024).toFixed(2)} MB)`);
