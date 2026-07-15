// scripts/build-deps.mjs — the DEPENDENCY PREBUNDLE.
//
// World C (llm/plan-in-browser-editor.md): bongle ships as SOURCE into the
// editor vfs; the only thing that still needs a build step is the third-party
// npm deps, because many are CJS and the editor's per-module transform can't
// eval CJS. This converts each dep bongle/src imports into browser ESM, seeded
// as a real node_modules package the vfs resolver reads like any other.
//
// Uses node `rolldown` (same bundler family as the in-browser publish build in
// editor/build/build.ts + vite 8), so CJS→ESM + tree-shaking semantics match
// what the publish bundle later does to these same packages.
//
// DEDUP — the React pitch. `react` is EXTERNAL in every other package, so
// react-dom/base-ui/dnd-kit emit a bare `import … from "react"` → the vfs
// resolver maps every one to the SINGLE seeded node_modules/react → one React
// instance across engine + game (hooks/context work, no "invalid hook call").
//
// react + react-dom are bundled in ONE graph (not react-dom externalizing
// react): react-dom is CJS, and a CJS module's `require("react")` of an EXTERNAL
// stays a runtime require → a throwing shim in the browser. Sharing one graph
// makes react-dom reference the same react module directly. react-dom is then a
// thin re-export package pointing back into node_modules/react (single dir so
// the shared-chunk relative imports resolve).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const require = createRequire(import.meta.url);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'deps-dist', 'node_modules');

// The exact specifiers bongle/src imports (audit 2026-07-15) + the react runtime
// entries oxc's automatic JSX emits (react/jsx-runtime). sharp is node-only
// (externalized), react-colorful is declared-but-unused (shredded). react +
// react-dom are handled separately (REACT_INPUTS). Keep in sync with src imports
// — a bare import of an unseeded dep fails at resolve.
const SPECIFIERS = [
    'zustand',
    '@base-ui/react/collapsible',
    '@base-ui/react/context-menu',
    '@base-ui/react/menu',
    '@base-ui/react/popover',
    '@dnd-kit/react',
    '@dnd-kit/react/sortable',
    '@dnd-kit/helpers',
    '@tanstack/react-virtual',
    '@gltf-transform/core',
    '@gltf-transform/functions',
    'meshoptimizer',
    '@breezystack/lamejs',
    'fflate',
];

// react family → one graph in node_modules/react/. `_dom`/`_dom-client` are
// private subpaths the react-dom re-export package points at.
const REACT_INPUTS = {
    index: 'react',
    'jsx-runtime': 'react/jsx-runtime',
    'jsx-dev-runtime': 'react/jsx-dev-runtime',
    _dom: 'react-dom',
    '_dom-client': 'react-dom/client',
};

/** split 'a/b/c' or '@scope/pkg/sub' → { pkg, subpath: '.'|'./x', name } */
function split(spec) {
    const scoped = spec.startsWith('@');
    const parts = spec.split('/');
    const pkg = scoped ? `${parts[0]}/${parts[1]}` : parts[0];
    const rest = scoped ? parts.slice(2) : parts.slice(1);
    return { pkg, subpath: rest.length ? `./${rest.join('/')}` : '.', name: rest.length ? rest.join('/') : 'index' };
}

/** the installed package's own package.json (for version + sideEffects). */
function originalPkg(pkg) {
    try {
        let dir = dirname(fileURLToPath(import.meta.resolve(`${pkg}/package.json`, import.meta.url)));
        for (;;) {
            const pj = join(dir, 'package.json');
            if (existsSync(pj)) {
                const j = JSON.parse(readFileSync(pj, 'utf8'));
                if (j.name === pkg) return j;
            }
            const up = dirname(dir);
            if (up === dir) break;
            dir = up;
        }
    } catch {}
    return {};
}

// react et al branch on process.env.NODE_ENV; fold to a literal so dev-only code
// DCEs and no `process` ref survives into the browser realm. (rolldown 1.1.2 has
// no top-level `define`; a transform pass is the same mechanism env-replace uses.)
const defineNodeEnv = {
    name: 'define-node-env',
    transform(code) {
        if (!code.includes('process.env.NODE_ENV')) return null;
        return { code: code.replaceAll('process.env.NODE_ENV', JSON.stringify('production')), map: null };
    },
};

const quietLog = (level, log, next) => {
    if (log.code === 'CIRCULAR_DEPENDENCY' || log.code === 'INVALID_ANNOTATION') return;
    next(level, log);
};

// Convert external CJS `require("react")` → an ESM import, so the externalized
// dep resolves as a real module in the browser realm instead of a throwing
// `__require` shim (some CJS deps — e.g. base-ui's transitive deps — require
// react rather than import it). This is what rolldown's builtin
// `esm-external-require` does; its JS wrapper (`esmExternalRequirePlugin`) only
// ships in rolldown >=1.1.5 (blocked here by minimumReleaseAge), so it's
// hand-rolled for the prebundle. The publish build (@rolldown/browser 1.1.5) can
// use the builtin directly.
const esmExternalRequire = (patterns) => ({
    name: 'esm-external-require',
    transform(code) {
        const re = /(^|[^.\w$])require\(\s*(['"])([^'"]+)\2\s*\)/g;
        const need = new Map();
        let hit = false;
        const out = code.replace(re, (m, pre, _q, spec) => {
            if (!patterns.some((rx) => rx.test(spec))) return m;
            hit = true;
            let binding = need.get(spec);
            if (!binding) {
                binding = `__ereq${need.size}`;
                need.set(spec, binding);
            }
            return `${pre}${binding}`;
        });
        if (!hit) return null;
        const imports = [...need].map(([spec, b]) => `import ${b} from ${JSON.stringify(spec)};`).join('\n');
        return { code: `${imports}\n${out}`, map: null };
    },
});

/** bundle `input` (name→specifier) → write chunks under node_modules/<destPkg>/,
 *  return the total bytes written. */
async function bundlePackage(input, external, destPkg, extraPlugins = []) {
    const bundle = await rolldown({
        input,
        cwd: ROOT,
        platform: 'browser',
        external,
        plugins: [...extraPlugins, defineNodeEnv],
        onLog: quietLog,
    });
    const { output } = await bundle.generate({
        format: 'es',
        exports: 'named',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        minify: true,
    });
    await bundle.close();

    const dir = join(OUT, destPkg);
    let bytes = 0;
    for (const o of output) {
        if (o.type !== 'chunk') continue;
        const dest = join(dir, o.fileName);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, o.code);
        bytes += o.code.length;
    }
    return bytes;
}

const writePkg = (pkg, exportsMap) => {
    const orig = originalPkg(pkg);
    const json = { name: pkg, version: orig.version ?? '0.0.0', type: 'module', exports: exportsMap };
    // preserve `sideEffects: false` so the PUBLISH build can tree-shake unused
    // exports out of a seeded dep. Only when the original explicitly declares it;
    // otherwise stay conservative. (NOTE: this only helps once a dep keeps its
    // per-module structure — a flattened barrel still can't shake; see the icons
    // discussion in src/icons/create-icon.tsx.)
    if (orig.sideEffects === false) json.sideEffects = false;
    writeFileSync(join(OUT, pkg, 'package.json'), `${JSON.stringify(json, null, 2)}\n`);
};

rmSync(join(ROOT, 'deps-dist'), { recursive: true, force: true });
let totalBytes = 0;

// ── react family (react + react-dom, one graph) ─────────────────────────────
// react/react-dom are CJS with no ESM build, and assign their exports inside a
// wrapper fn that cjs-module-lexer can't see — so NEITHER rolldown nor esbuild
// exposes react's named exports, and `import { createContext } from 'react'`
// would be undefined. Wrap each entry: import the CJS default, then re-export
// its actual runtime keys (read via `require()` here) as ESM named exports. One
// graph (react + react-dom share the real react module → single instance).
const reactVirtual = {};
for (const [file, spec] of Object.entries(REACT_INPUTS)) {
    const real = require.resolve(spec);
    const keys = Object.keys(require(spec)).filter((k) => k !== 'default' && k !== '__esModule' && /^[A-Za-z_$][\w$]*$/.test(k));
    reactVirtual[`\0react:${file}`] = `import __m from ${JSON.stringify(real)};\nexport default __m;\nexport const { ${keys.join(', ')} } = __m;\n`;
}
const reactNamedExports = {
    name: 'react-named-exports',
    resolveId: (id) => (id in reactVirtual ? id : null),
    load: (id) => reactVirtual[id] ?? null,
};
const reactInput = Object.fromEntries(Object.keys(REACT_INPUTS).map((file) => [file, `\0react:${file}`]));
totalBytes += await bundlePackage(reactInput, [/^node:/], 'react', [reactNamedExports]);
writePkg('react', {
    '.': './index.js',
    './jsx-runtime': './jsx-runtime.js',
    './jsx-dev-runtime': './jsx-dev-runtime.js',
    './_dom': './_dom.js',
    './_dom-client': './_dom-client.js',
});
// react-dom = thin re-export package → the shared react graph (single instance).
mkdirSync(join(OUT, 'react-dom'), { recursive: true });
writeFileSync(join(OUT, 'react-dom', 'index.js'), 'export * from "react/_dom";\n');
writeFileSync(join(OUT, 'react-dom', 'client.js'), 'export * from "react/_dom-client";\n');
writePkg('react-dom', { '.': './index.js', './client': './client.js' });
console.log('bundled react + react-dom (shared graph)');

// ── every other dep (react/react-dom externalized → single identity) ────────
const groups = new Map();
for (const spec of SPECIFIERS) {
    const { pkg } = split(spec);
    if (!groups.has(pkg)) groups.set(pkg, []);
    groups.get(pkg).push(spec);
}
// Every seeded package is a SINGLE instance: externalize all the OTHER seeded
// packages from each bundle, so cross-references resolve to the one seeded copy
// instead of a duplicate bundled-in copy. Same reason react is shared — e.g.
// @gltf-transform/functions imports @gltf-transform/core, whose static state (the
// graph→document map) must be shared; a duplicated core breaks
// Document.fromGraph (returns null → `null.getLogger()`).
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const seededNames = ['react', 'react-dom', ...new Set(SPECIFIERS.map((s) => split(s).pkg))];
const nameRe = (n) => new RegExp(`^${escapeRe(n)}($|/)`);
for (const [pkg, specs] of groups) {
    const input = {};
    const exportsMap = {};
    for (const spec of specs) {
        const { subpath, name } = split(spec);
        input[name] = spec;
        exportsMap[subpath] = `./${name}.js`;
    }
    const shared = seededNames.filter((n) => n !== pkg).map(nameRe);
    totalBytes += await bundlePackage(input, [/^node:/, ...shared], pkg, [esmExternalRequire(shared)]);
    writePkg(pkg, exportsMap);
    console.log(`bundled ${pkg} (${specs.length} entr${specs.length === 1 ? 'y' : 'ies'})`);
}

console.log(`\ndeps prebundle → deps-dist/node_modules (${(totalBytes / 1024 / 1024).toFixed(2)} MB, ${groups.size + 2} packages)`);
