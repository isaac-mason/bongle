// lib/build/dev-server.ts — the host-neutral dev server for user project code.
//
// The single source of truth for the module runner: reads user modules from the
// project fs, transforms them, owns one module graph per env, and propagates HMR.
// Engine imports (bare specifiers like `bongle`, `bongle/internal`) are NOT served
// here — they externalize to the host's engine (resolved by the runner's externals
// map). Speaks the Vite ModuleRunner transport protocol: fetchModule(...) → result,
// plus pushing HMR payloads to each env's registered channel.
//
// Host-neutral like bundle.ts: the two browser-coupled capabilities are INJECTED
// (see DevServerDeps) — `transform` (oxc TS-strip + module-runner rewrite,
// @rolldown/browser/experimental in the editor) and `bundleWorker` (bundling a
// `?worker` graph, which reaches into rolldown). A node `bongle dev` supplies node
// impls; the rest (resolve, DepGraph capture, HMR) runs unchanged in both.

import { type DepParser, initSymbolTables, type SymbolTableRegistry, wrapModuleDeps } from '../capture/capture-deps';
import { type BuildFs, dirOf, type PackageJson, posixJoin, resolveFile, resolvePackage } from '../resolve';

/** the transformed form of one module, as the ModuleRunner evals it. */
export type TransformResult = {
    code: string;
    deps: string[];
    dynamicDeps: string[];
};

/** transform one module into runner-eval form: (optional capture wrapper →) TS-
 *  strip → module-runner (SSR) rewrite. Browser impl: editor/bundler/transform.ts. */
export type TransformModule = (id: string, source: string, opts: { capture: boolean }) => Promise<TransformResult>;

/** bundle a `?worker` entry's graph into ONE self-contained worker-wrapper module
 *  SOURCE (pre-transform), like vite's `?worker&inline`. Reaches into rolldown, so
 *  it's injected; the editor's impl lazy-loads @rolldown/browser + caches. */
export type BundleWorker = (entryId: string) => Promise<string>;

/** the browser-coupled capabilities the dev server needs, injected at init. */
export type DevServerDeps = {
    transform: TransformModule;
    /** the oxc parser for the capture dep-wrap (host-injected: node rolldown /
     *  browser @rolldown/browser) — see build/capture DepParser. */
    parse: DepParser;
    bundleWorker: BundleWorker;
    /** map a resolved vfs path to a DOM-usable URL, for `?url` asset imports.
     *  In the editor this is the project-fs SW URL (`/@project/<path>`). */
    assetUrl?: (path: string) => string;
};

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
    /** project working copy — user module source + the seeded engine source
     *  (node_modules/bongle/**) live here. */
    fs: BuildFs;
    /** the injected browser-coupled capabilities (transform + worker bundling). */
    deps: DevServerDeps;
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
};

export function initDevServer(fs: BuildFs, deps: DevServerDeps): DevServerState {
    return {
        fs,
        deps,
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

// `?url` asset imports resolve to a synthetic id fetchModule serves as a module
// whose default export is a DOM-usable URL for the asset (the injected
// `assetUrl` — in the editor, the project-fs SW's `/@project/<path>`). The base
// path is a real vfs path, so this works uniformly for `src/**` and seeded
// `node_modules/**` assets alike.
const ASSET_URL_PREFIX = '\0asseturl:';

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

    // `?url` asset import — strip the query, resolve the base file, tag it.
    if (q !== -1 && /\burl\b/.test(spec.slice(q))) {
        const base = spec.slice(0, q);
        const baseId = base.startsWith('.')
            ? ((await resolveFile(state.fs, posixJoin(importerDir, base))) ?? posixJoin(importerDir, base))
            : normalize(base);
        return `${ASSET_URL_PREFIX}${baseId}`;
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
    const code = await wrapModuleDeps(id, source, state.symbolTables, (spec) => resolve(state, spec, id), state.deps.parse);
    state.depWrapCache.set(id, { version: mv, code });
    return code;
}

/** a `?worker` import → bundle its graph (injected) into a self-contained
 *  WorkerWrapper module, then transform it into runner-eval form. */
async function serveWorkerModule(state: DevServerState, id: string): Promise<FetchResult> {
    const entryId = id.slice(WORKER_ID_PREFIX.length);
    const wrapper = await state.deps.bundleWorker(entryId);
    const result = await state.deps.transform(`${entryId}.worker.js`, wrapper, { capture: false });
    return { code: result.code, file: id, id, url: id, invalidate: false };
}

/** read + (capture-wrap + dep-wrap) + transform one module, memoised in the SHARED
 *  env-neutral transform cache. Returns the externalize sentinel when the read
 *  misses on a bare npm dep the realm native-imports; throws on a genuine miss. */
async function loadModuleCode(
    state: DevServerState,
    env: string,
    rawId: string,
    id: string,
    importer: string | undefined,
    mv: number,
): Promise<TransformResult | { externalize: string; type: 'module' }> {
    const cached = state.transformCache.get(id);
    if (cached && cached.version === mv) return cached.result;

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

    // seeded lib source (node_modules/**) is NOT user code — no capture wrapper;
    // user project modules get it + the DepGraph AST pass (shared across envs).
    const capture = !id.startsWith('node_modules/');
    const input = capture ? await ensureDepWrapped(state, id, source, mv) : source;
    const tTransform = performance.now();
    const result = await state.deps.transform(id, input, { capture });
    state.perf.transformMs += performance.now() - tTransform;
    state.transformCache.set(id, { version: mv, result });
    return result;
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

    // synthetic modules served without a normal fs read:
    //  - `\0worker:<entry>` — a `?worker` import → a self-contained WorkerWrapper
    //    module (the worker's graph is bundled by the injected bundleWorker).
    //  - `\0asseturl:<path>` — a `?url` import → a module whose default export is
    //    a DOM-usable URL for the asset (the injected `assetUrl`).
    //  - `*.css` — engine `import './x.css'`. Styles ship as the prebuilt
    //    bongle.css (injected by client-main); serve an empty side-effect module.
    if (id.startsWith(WORKER_ID_PREFIX)) return serveWorkerModule(state, id);
    if (id.startsWith(ASSET_URL_PREFIX)) {
        const path = id.slice(ASSET_URL_PREFIX.length);
        const url = state.deps.assetUrl?.(path) ?? `/${path}`;
        const result = await state.deps.transform(`${path}.url.js`, `export default ${JSON.stringify(url)};`, {
            capture: false,
        });
        return { code: result.code, file: id, id, url: id, invalidate: false };
    }
    if (id.endsWith('.css')) {
        const result = await state.deps.transform(`${id}.js`, '', { capture: false });
        return { code: result.code, file: id, id, url: id, invalidate: false };
    }

    const node = ensureNode(state, env, id);

    // per-module content version: the cache-validity key. Unchanged for modules
    // an edit didn't touch, so their runner + transform caches stay valid.
    const mv = state.moduleVersion.get(id) ?? 0;

    // load + transform, memoised in the SHARED env-neutral cache (a hit skips both
    // read + transform, so the engine's ~360 modules compile ONCE, not once per
    // realm). The module GRAPH below is still per-env — only the code is shared.
    const loaded = await loadModuleCode(state, env, rawId, id, importer, mv);
    if ('externalize' in loaded) return loaded; // a bare npm dep the realm native-imports
    const result = loaded;
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
