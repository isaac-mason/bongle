// editor/bundler/dev-server.ts — in-browser dev server for user project code.
//
// The single source of truth for the module runner: reads user modules from
// the project `Filesystem`, transforms them (bundler/transform.ts), owns one
// module graph per env, and propagates HMR. Engine imports (bare specifiers
// like `bongle`, `bongle/internal`) are NOT served here — they externalize to
// the host's engine (resolved by the runner's externals map).
//
// Speaks the Vite ModuleRunner transport protocol: fetchModule(...) → result,
// plus pushing HMR payloads to each env's registered channel. init()+State+
// standalone-fns, matching the engine convention.

import {
    type Bundler,
    dirOf,
    initSymbolTables,
    type PackageJson,
    posixJoin,
    resolveFile,
    resolvePackage,
    type SymbolTableRegistry,
    wrapModuleDeps,
} from '../../build';
import type { Filesystem } from '../fs';
import { ensureProcessShim } from './runner';
import { type TransformResult, transformModule } from './transform';

/** a HotPayload subset the runner accepts. */
export type HotPayload = { type: 'update' | 'custom' | 'full-reload' | 'connected'; [k: string]: unknown };

export type FetchResult =
    | { code: string; file: string; id: string; url: string; invalidate: boolean }
    | { cache: true }
    | { externalize: string; type: 'module' };

/** per-env module-graph node. */
type ModNode = {
    id: string;
    importers: Set<string>;
    imports: Set<string>;
    /** every user module self-accepts (the bongle postlude injects it). */
    selfAccepts: boolean;
    lastVersion: number;
};

export type DevServerState = {
    /** project working copy — user module source + the seeded engine dist
     *  (node_modules/bongle/dist) live here. */
    fs: Filesystem;
    /** per-env module graphs, created lazily as envs register. */
    graphs: Map<string, Map<string, ModNode>>;
    /** transform cache: module id → { version, result }. SHARED across realms —
     *  the transform is env-neutral now (see transform.ts), so the engine's
     *  modules are read + compiled ONCE, and every realm reuses the result. */
    transformCache: Map<string, { version: number; result: TransformResult }>;
    /** global monotonic HMR timestamp. ONLY stamps js-update payloads so the
     *  runner cache-busts the changed boundary's re-import URL. NOT a cache key
     *  (that role caused whole-graph re-eval — see moduleVersion). */
    version: number;
    /** per-module content version, bumped only when THAT module's own source
     *  changes. This is the runner-cache + transform-cache validity key: an
     *  edit to one module leaves every other module's version untouched, so the
     *  runner reuses their evaluated instances (and any singleton they hold —
     *  e.g. the engine `registry`) instead of re-evaluating the whole graph. */
    moduleVersion: Map<string, number>;
    /** HMR push channels registered by each env's transport. */
    pushers: Map<string, (p: HotPayload) => void>;
    /** node_modules package.json cache (pkg name → parsed json | null miss). */
    pkgCache: Map<string, PackageJson | null>;
    /** DepGraph AST pass state: module id → SymbolTable, shared across envs
     *  (dep edges are env-independent). Feeds the __kit.deps consumer wrap. */
    symbolTables: SymbolTableRegistry;
    /** dep-wrapped source cache: module id → { version, code }. The wrap is
     *  env-independent, so it runs once per module content version and both
     *  realms reuse it (the per-env transform layers env literals on top). */
    depWrapCache: Map<string, { version: number; code: string }>;
    /** resolution cache: `${importer}\0${spec}` → resolved id. A module's deps
     *  re-resolve on every fetch (3 realms × every import), and each resolve does
     *  several OPFS `stat` probes — memoise them. Cleared on edit (a new file can
     *  change a resolution). */
    resolveCache: Map<string, string>;
    /** cold-start cost breakdown (SPIKE, task #13) — cumulative ms per phase. */
    perf: { modules: number; resolveMs: number; readMs: number; transformMs: number };
    /** `?worker` bundle cache: entry id → self-contained bundled code. A worker
     *  can't run the ModuleRunner, so its graph is bundled once (like vite's
     *  ?worker) and blob-spawned. Immutable seed → keyed by entry id alone. */
    workerCache: Map<string, string>;
};

export function initDevServer(fs: Filesystem): DevServerState {
    return {
        fs,
        graphs: new Map(),
        transformCache: new Map(),
        version: 0,
        moduleVersion: new Map(),
        pushers: new Map(),
        pkgCache: new Map(),
        symbolTables: initSymbolTables(),
        depWrapCache: new Map(),
        resolveCache: new Map(),
        perf: { modules: 0, resolveMs: 0, readMs: 0, transformMs: 0 },
        workerCache: new Map(),
    };
}

const isBare = (spec: string) => !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('\0');
const isEngine = (spec: string) => spec === 'bongle' || spec.startsWith('bongle/');

// A DEP that externalizes = a node builtin only. Everything else a transformed
// module imports resolves in the vfs: relative + root-relative from fs, `bongle*`
// from the prebundled dist, and bare first-party libs (mathcat/gpucat/…) from
// their seeded node_modules package. Third-party npm is bundled INTO bongle, so
// it never appears as a bare dep here. A residual bare miss still externalizes
// via fetchModule's read-failure path.
const isExternalDep = (spec: string) => spec.startsWith('node:');

export function registerPusher(state: DevServerState, env: string, push: (p: HotPayload) => void): void {
    state.pushers.set(env, push);
}

/** normalize a module id to its fs-relative form: strip cache-bust query +
 *  any leading slash. Module ids ARE fs paths ('src/index.ts'). */
function normalize(id: string): string {
    return id.replace(/[?#].*$/, '').replace(/^\/+/, '');
}

// worker imports (`x?worker&inline`) resolve to a synthetic id fetchModule
// serves as a Worker-constructor module (bundled + blob-spawned — see
// bongle-plugin.ts + the WORKER_ID_PREFIX branch in fetchModule).
const WORKER_ID_PREFIX = '\0worker:';

/** resolve a user specifier relative to its importer to an fs-relative id (or a
 *  synthetic `\0worker:` id). Extension/index + package.json `exports` handling
 *  lives in resolve.ts (a documented subset of Node resolution over the vfs);
 *  this keeps only the dev-transport concerns (the `?worker` tag, and a
 *  best-effort id on a miss so fetchModule surfaces a clear error / externalizes
 *  a bare dep). */
async function resolve(state: DevServerState, spec: string, importer: string | undefined): Promise<string> {
    const key = `${importer ?? ''}\0${spec}`;
    const hit = state.resolveCache.get(key);
    if (hit !== undefined) return hit;
    const id = await resolveUncached(state, spec, importer);
    state.resolveCache.set(key, id);
    return id;
}

async function resolveUncached(state: DevServerState, spec: string, importer: string | undefined): Promise<string> {
    const importerDir = dirOf(importer ? normalize(importer) : '');

    // worker entry import — strip the query, resolve the base module, tag it.
    const q = spec.indexOf('?');
    if (q !== -1 && /\bworker\b/.test(spec.slice(q))) {
        const base = spec.slice(0, q);
        const baseId = base.startsWith('.')
            ? ((await resolveFile(state.fs, posixJoin(importerDir, base))) ?? posixJoin(importerDir, base))
            : normalize(base);
        return `${WORKER_ID_PREFIX}${baseId}`;
    }

    // relative → extension/index probe.
    if (spec.startsWith('.')) {
        const target = posixJoin(importerDir, spec);
        return (await resolveFile(state.fs, target)) ?? `${target.replace(/\.[a-z]+$/i, '')}.ts`;
    }

    // bare (bongle source, first-party libs, prebundled deps) via package.json
    // `exports` — one resolver, no bongle special-case.
    if (isBare(spec)) {
        const pkg = await resolvePackage(state.fs, spec, { pkgCache: state.pkgCache });
        if (pkg) return pkg;
    }

    const rooted = normalize(spec);
    const atRoot = await resolveFile(state.fs, rooted);
    if (atRoot) return atRoot;

    // A `/`-absolute miss is often a RELATIVE dynamic import the module-runner
    // collapsed against the raw (unresolved) request specifier — dropping the
    // importer's real prefix (vite module-runner `dynamicRequest` does
    // `posixResolve(posixDirname(rawSpec), dep)`, and our specifiers stay
    // relative rather than pre-resolved to root-absolute). Reconstruct by
    // resolving the tail up the RESOLVED importer's directory tree, closest
    // first — the level the collapse landed on is where the file exists.
    if (spec.startsWith('/') && importer) {
        for (let dir = dirOf(normalize(importer)); ; dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') {
            const hit = await resolveFile(state.fs, dir ? `${dir}/${rooted}` : rooted);
            if (hit) return hit;
            if (!dir) break;
        }
    }
    return rooted;
}

function graphOf(state: DevServerState, env: string): Map<string, ModNode> {
    let g = state.graphs.get(env);
    if (!g) {
        g = new Map();
        state.graphs.set(env, g);
    }
    return g;
}

function ensureNode(state: DevServerState, env: string, id: string): ModNode {
    const g = graphOf(state, env);
    let n = g.get(id);
    if (!n) {
        n = { id, importers: new Set(), imports: new Set(), selfAccepts: false, lastVersion: -1 };
        g.set(id, n);
    }
    return n;
}

/** DepGraph AST wrap for a user module, memoised per content version and
 *  shared across envs (dep edges don't vary by realm). Resolves import specs
 *  through the dev server's own resolver so the cross-module walk uses the
 *  same module ids that key the graph. */
async function ensureDepWrapped(state: DevServerState, id: string, source: string, mv: number): Promise<string> {
    const cached = state.depWrapCache.get(id);
    if (cached && cached.version === mv) return cached.code;
    const code = await wrapModuleDeps(id, source, state.symbolTables, (spec) => resolve(state, spec, id));
    state.depWrapCache.set(id, { version: mv, code });
    return code;
}

/** transport: fetch a module for `env`. Bare specifiers externalize. */
export async function fetchModule(
    state: DevServerState,
    env: string,
    rawId: string,
    importer: string | undefined,
    opts: { cached?: boolean },
): Promise<FetchResult> {
    // node builtins externalize up front (stubbed by the runner's evaluator).
    if (rawId.startsWith('node:')) return { externalize: rawId, type: 'module' };

    const tResolve = performance.now();
    const id = await resolve(state, rawId, importer);
    state.perf.resolveMs += performance.now() - tResolve;

    // synthetic modules served without an fs read:
    //  - `\0worker:<entry>` — a `?worker` import: bundle the worker's graph into
    //    one self-contained blob (like vite's ?worker) → a WorkerWrapper module.
    //  - `*.css` — engine `import './x.css'`. Styles ship as the prebuilt
    //    bongle.css (injected by client-main); serve an empty side-effect module.
    if (id.startsWith(WORKER_ID_PREFIX)) {
        const entryId = id.slice(WORKER_ID_PREFIX.length);
        // lazy: @rolldown/browser's wasm loads only when a ?worker is actually hit.
        const [{ bundleWorkerEntry, workerWrapperModule }, { rolldown }] = await Promise.all([
            import('../../build/bongle-plugin'),
            import('@rolldown/browser'),
        ]);
        let jsContent = state.workerCache.get(entryId);
        if (jsContent === undefined) {
            // the worker runs in the client render pipeline (CPU compute, no DOM).
            jsContent = await bundleWorkerEntry(
                state.fs,
                entryId,
                { client: true, server: false, editor: true },
                { rolldown: rolldown as unknown as Bundler['rolldown'], prepare: ensureProcessShim },
            );
            state.workerCache.set(entryId, jsContent);
        }
        const result = await transformModule(`${entryId}.worker.js`, workerWrapperModule(jsContent), { capture: false });
        return { code: result.code, file: id, id, url: id, invalidate: false };
    }
    if (id.endsWith('.css')) {
        const result = await transformModule(`${id}.js`, '', { capture: false });
        return { code: result.code, file: id, id, url: id, invalidate: false };
    }

    const node = ensureNode(state, env, id);

    // per-module content version: the cache-validity key. Unchanged for modules
    // an edit didn't touch, so their runner + transform caches stay valid.
    const mv = state.moduleVersion.get(id) ?? 0;

    // SHARED transform cache (env-neutral): a hit skips BOTH the read and the
    // transform, so the engine's ~360 modules are read + compiled ONCE, not once
    // per realm. The module GRAPH below is still per-env (HMR boundaries differ
    // by realm); only the transformed code is shared.
    let result: TransformResult;
    const cached = state.transformCache.get(id);
    if (cached && cached.version === mv) {
        result = cached.result;
    } else {
        let source: string;
        const tRead = performance.now();
        try {
            source = await state.fs.readText(id);
        } catch {
            // not a user/engine module in the vfs → a bare npm dep the realm
            // native-imports. relative/absolute misses are real errors.
            if (isBare(rawId) && !isEngine(rawId)) return { externalize: rawId, type: 'module' };
            throw new Error(`[dev-server:${env}] module not found: ${rawId} (resolved ${id}) from ${importer}`);
        }
        state.perf.readMs += performance.now() - tRead;
        // seeded lib source (node_modules/**) is NOT user code — no capture
        // wrapper; user project modules get it + the DepGraph AST pass (shared).
        const capture = !id.startsWith('node_modules/');
        const input = capture ? await ensureDepWrapped(state, id, source, mv) : source;
        const tTransform = performance.now();
        result = await transformModule(id, input, { capture });
        state.perf.transformMs += performance.now() - tTransform;
        state.transformCache.set(id, { version: mv, result });
    }
    node.selfAccepts = !id.startsWith('node_modules/'); // user modules self-accept (postlude); lib chunks don't

    // refresh this env's import edges.
    node.imports.clear();
    const tDeps = performance.now();
    for (const dep of result.deps) {
        if (isExternalDep(dep)) continue; // externals aren't graph nodes
        const depId = await resolve(state, dep, id);
        node.imports.add(depId);
        ensureNode(state, env, depId).importers.add(id);
    }
    state.perf.resolveMs += performance.now() - tDeps;

    // SPIKE (task #13): cold-start breakdown, logged as it grinds through the
    // ~360 engine modules × 3 realms. resolve = OPFS stat probes, read = OPFS
    // reads, transform = oxc strip + module-runner rewrite (wasm).
    if (++state.perf.modules % 100 === 0) {
        const p = state.perf;
        console.log(
            `[perf] ${p.modules} modules | resolve ${p.resolveMs | 0}ms · read ${p.readMs | 0}ms · transform ${p.transformMs | 0}ms`,
        );
    }

    if (opts.cached && node.lastVersion === mv) return { cache: true };
    const invalidate = node.lastVersion !== mv && node.lastVersion !== -1;
    node.lastVersion = mv;
    return { code: result.code, file: id, id, url: id, invalidate };
}

/** edit → HMR: re-read the changed file, bump version, push updates per env. */
export async function applyEdit(state: DevServerState, path: string): Promise<void> {
    const id = normalize(path);
    state.version++;
    // bump ONLY this module's content version — its transform + runner cache go
    // stale, every other module stays valid (reused, not re-evaluated).
    state.moduleVersion.set(id, (state.moduleVersion.get(id) ?? 0) + 1);
    state.transformCache.delete(id);
    // stale dep wrap: re-run the AST pass on next fetch (rebuilds this module's
    // SymbolTable against the now-complete registry and re-wraps its consumers).
    state.depWrapCache.delete(id);
    // a new/renamed/deleted file can change what a specifier resolves to.
    state.resolveCache.clear();

    for (const [env, g] of state.graphs) {
        if (!g.has(id)) continue; // this env never loaded the module
        const boundaries = computeBoundaries(g, id);
        const push = state.pushers.get(env);
        if (boundaries === 'full-reload') {
            push?.({ type: 'full-reload', triggeredBy: id });
            continue;
        }
        // every user module self-accepts, so path === acceptedPath.
        push?.({
            type: 'update',
            updates: boundaries.map((b) => ({
                type: 'js-update',
                path: b,
                acceptedPath: b === id ? id : b,
                timestamp: state.version,
                firstInvalidatedBy: id,
            })),
        });
    }
}

/** walk importers until every path hits a self-accepting boundary. */
function computeBoundaries(g: Map<string, ModNode>, changed: string): string[] | 'full-reload' {
    const boundaries = new Set<string>();
    const visited = new Set<string>();
    const queue = [changed];
    while (queue.length) {
        const cur = queue.shift()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        const node = g.get(cur);
        if (!node) return 'full-reload';
        if (node.selfAccepts) {
            boundaries.add(cur);
            continue;
        }
        if (node.importers.size === 0) return 'full-reload';
        for (const imp of node.importers) queue.push(imp);
    }
    return [...boundaries];
}

/** runner → server: hot.invalidate() bounces here as vite:invalidate; climb to
 *  importers and push self-updates so the cascade re-evaluates them. */
export function handleRunnerMessage(state: DevServerState, env: string, payload: unknown): void {
    const p = payload as { type?: string; event?: string; data?: { path?: string; firstInvalidatedBy?: string } };
    if (p?.type !== 'custom' || p.event !== 'vite:invalidate' || !p.data?.path) return;
    const g = state.graphs.get(env);
    if (!g) return;
    const node = g.get(normalize(p.data.path));
    if (!node) return;

    const boundaries = new Set<string>();
    const visited = new Set<string>([node.id]);
    const queue = [...node.importers];
    let fullReload = false;
    while (queue.length) {
        const cur = queue.shift()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        const n = g.get(cur);
        if (!n) continue;
        if (n.selfAccepts) boundaries.add(cur);
        else if (n.importers.size === 0) fullReload = true;
        else for (const imp of n.importers) queue.push(imp);
    }
    const push = state.pushers.get(env);
    if (fullReload) {
        push?.({ type: 'full-reload', triggeredBy: node.id });
        return;
    }
    if (boundaries.size === 0) return;
    for (const b of boundaries) {
        const bn = g.get(b);
        if (bn) bn.lastVersion = -2; // force re-fetch/invalidate next fetch
    }
    push?.({
        type: 'update',
        updates: [...boundaries].map((b) => ({
            type: 'js-update',
            path: b,
            acceptedPath: b,
            timestamp: state.version,
            firstInvalidatedBy: p.data?.firstInvalidatedBy,
        })),
    });
}
