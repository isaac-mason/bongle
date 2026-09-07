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
import { init as initLexer, parse as parseModule } from 'es-module-lexer';
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

// ── the seed is the import CLOSURE of the exports, not the contents of dist/ ───
// `build:incremental` (the dev.sh watcher) never empties dist, so every rebuild leaves its
// predecessor's hashed chunks behind (`core-<hash>.js` ...). Packing the directory shipped all
// of them: dozens of dead megabyte chunks written into OPFS on every boot. Walk the relative
// imports from each export target instead and drop every dist js nothing reaches.
await initLexer;
{
    const decoder = new TextDecoder();
    const exportTargets = Object.values(exportsForSeed)
        .map((t) => (typeof t === 'string' ? t : (t.import ?? t.default)))
        .filter((t) => typeof t === 'string' && t.endsWith('.js'))
        // `./kit/*` patterns name `./dist/kit-*.js`; expand against what dist holds.
        .flatMap((t) => {
            if (!t.includes('*')) return [`bongle/${t.replace(/^\.\//, '')}`];
            const re = new RegExp(`^bongle/${t.replace(/^\.\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
            return Object.keys(files).filter((f) => re.test(f));
        });
    const reachable = new Set();
    const pending = [...exportTargets];
    while (pending.length > 0) {
        const path = pending.pop();
        if (reachable.has(path)) continue;
        const bytes = files[path];
        if (bytes === undefined) throw new Error(`pack-vfs: export target '${path}' is not in dist`);
        reachable.add(path);
        const [imports] = parseModule(decoder.decode(bytes), path);
        for (const imp of imports) {
            if (imp.n === undefined || imp.d === -2 || !imp.n.startsWith('.')) continue;
            const dir = path.slice(0, path.lastIndexOf('/'));
            const target = new URL(imp.n, `file:///${dir}/`).pathname.slice(1);
            if (target.endsWith('.js')) pending.push(target);
        }
    }
    let dropped = 0;
    for (const path of Object.keys(files)) {
        if (path.startsWith('bongle/dist/') && path.endsWith('.js') && !reachable.has(path)) {
            delete files[path];
            dropped++;
        }
    }
    console.log(`bongle dist: ${reachable.size} modules reachable from the exports, ${dropped} unreachable chunk(s) dropped`);
}
addTree('bongle/avatars', join(ROOT, 'avatars'), (abs) => !abs.endsWith('.DS_Store'));
if (existsSync(join(ROOT, 'README.md'))) addFile('bongle/README.md', join(ROOT, 'README.md'));
// engine docs (the generated reader-facing markdown) → node_modules/bongle/docs,
// so the in-editor markdown viewer can open them.
for (const md of ['docs.md', 'api.md']) {
    if (existsSync(join(ROOT, 'docs', md))) addFile(`bongle/docs/${md}`, join(ROOT, 'docs', md));
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
    // crashcat's `./three` adapter imports `three`, which the engine neither seeds nor uses; a
    // seeded module must resolve every import (the seed is loaded natively), so it stays out.
    const isThreeAdapter = (abs) => lib === 'crashcat' && /\/dist\/three(\.js|\/)/.test(abs);
    addTree(`${lib}/dist`, join(d, 'dist'), (abs) => (abs.endsWith('.js') || abs.endsWith('.d.ts')) && !isThreeAdapter(abs));
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

// ── bare specifiers → relative paths, seed-wide ─────────────────────────────
// The editor loads the seed NATIVELY (the dev server externalizes node_modules/** to
// project-fs URLs and each realm `import()`s them), and a browser resolves only
// relative/absolute specifiers. Every package here imports its siblings by bare name
// (build-deps.mjs externalizes the other seeded packages for single identity; bongle's
// dist imports `math`, `gpucat`, `bongle/kit/*`, ...), so rewrite each one to the
// relative path of the file the seeded manifest resolves it to. The published npm
// dist keeps its bare specifiers; only the seed is rewritten. `node:*` and non-literal
// dynamic imports are left alone. Anything unresolvable fails the pack: a bare
// specifier that survives would surface as a browser link error at boot.
const decoder = new TextDecoder();
const manifestCache = new Map();
const readManifest = (pkg) => {
    let m = manifestCache.get(pkg);
    if (m === undefined) {
        const raw = files[`${pkg}/package.json`];
        m = raw === undefined ? null : JSON.parse(decoder.decode(raw));
        manifestCache.set(pkg, m);
    }
    return m;
};
const stripDot = (rel) => rel.replace(/^\.\//, '');
const pickCondition = (target, where) => {
    if (typeof target === 'string') return target;
    if (target === null || typeof target !== 'object') throw new Error(`pack-vfs: unsupported export target at ${where}`);
    const t = target.import ?? target.default;
    if (t === undefined) throw new Error(`pack-vfs: no import/default condition at ${where}`);
    return pickCondition(t, where);
};
const escapeRe = (t) => t.replace(/[.+^${}()|[\]\\]/g, '\\$&');
/** bare specifier → seed path of the file it names. */
const resolveBare = (spec) => {
    const parts = spec.split('/');
    const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const subpath = spec.length > pkg.length ? `.${spec.slice(pkg.length)}` : '.';
    const manifest = readManifest(pkg);
    if (manifest === null) throw new Error(`pack-vfs: '${spec}' names a package not in the seed ('${pkg}')`);
    const exp = manifest.exports;
    let target;
    if (exp === undefined || exp === null) {
        target = subpath === '.' ? (manifest.main ?? 'index.js') : subpath;
    } else if (typeof exp === 'string') {
        if (subpath !== '.') throw new Error(`pack-vfs: '${spec}' has no subpath export`);
        target = exp;
    } else {
        const subpathMap = Object.keys(exp).some((k) => k.startsWith('.')) ? exp : { '.': exp };
        if (subpathMap[subpath] !== undefined) {
            target = pickCondition(subpathMap[subpath], `${pkg} exports ${subpath}`);
        } else {
            for (const [key, val] of Object.entries(subpathMap)) {
                const star = key.indexOf('*');
                if (star === -1) continue;
                const m = subpath.match(new RegExp(`^${escapeRe(key.slice(0, star))}(.*)${escapeRe(key.slice(star + 1))}$`));
                if (m === null) continue;
                target = pickCondition(val, `${pkg} exports ${key}`).replace('*', m[1]);
                break;
            }
            if (target === undefined) throw new Error(`pack-vfs: '${spec}' is not exported by ${pkg}`);
        }
    }
    const path = `${pkg}/${stripDot(target)}`;
    if (files[path] === undefined) throw new Error(`pack-vfs: '${spec}' resolves to '${path}', which is not in the seed`);
    return path;
};
const relativeSpecifier = (fromFile, toFile) => {
    const from = fromFile.split('/').slice(0, -1);
    const to = toFile.split('/');
    let i = 0;
    while (i < from.length && i < to.length && from[i] === to[i]) i++;
    const up = from.length - i;
    return `${up === 0 ? './' : '../'.repeat(up)}${to.slice(i).join('/')}`;
};
const isBare = (spec) => !/^(\.|\/|node:|data:|blob:|https?:)/.test(spec);

await initLexer;
let rewrittenFiles = 0;
let rewrittenSpecifiers = 0;
for (const [path, bytes] of Object.entries(files)) {
    if (!path.endsWith('.js')) continue;
    const source = decoder.decode(bytes);
    const [imports] = parseModule(source, path);
    const edits = [];
    for (const imp of imports) {
        // `n` is the specifier when it is a string literal (static, re-export, or dynamic with a
        // literal); `d === -2` is import.meta. Non-literal dynamic imports have no `n`.
        if (imp.n === undefined || imp.d === -2 || !isBare(imp.n)) continue;
        let resolved;
        try {
            resolved = resolveBare(imp.n);
        } catch (e) {
            throw new Error(`${e.message} (imported from ${path})`);
        }
        edits.push({ s: imp.s, e: imp.e, text: relativeSpecifier(path, resolved) });
    }
    if (edits.length === 0) continue;
    let out = source;
    for (const edit of edits.sort((a, b) => b.s - a.s)) out = out.slice(0, edit.s) + edit.text + out.slice(edit.e);
    files[path] = enc.encode(out);
    rewrittenFiles++;
    rewrittenSpecifiers += edits.length;
}
console.log(`rewrote ${rewrittenSpecifiers} bare specifiers in ${rewrittenFiles} seeded modules to relative paths`);

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
