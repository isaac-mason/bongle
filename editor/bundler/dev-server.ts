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

import type { Filesystem } from '../fs';
import type { EnvValues } from './env-replace';
import { type TransformResult, transformModule } from './transform';

// env-id → env values. Realms use env-ids `client:<n>` / `server` / `pipeline`;
// client realms are client-env, server + pipeline are server-env.
function envValuesFor(env: string): EnvValues {
    return env.startsWith('client')
        ? { client: true, server: false, editor: true }
        : { client: false, server: true, editor: true };
}

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
    /** project working copy — user module source lives here. */
    fs: Filesystem;
    /** true for a specifier that externalizes to the host engine (e.g.
     *  `bongle`, `bongle/internal`) rather than being served from the fs.
     *  Explicit predicate, NOT a leading-char heuristic — `src/index.ts` is a
     *  user module even though it lacks a `./` prefix. */
    isExternal: (spec: string) => boolean;
    /** per-env module graphs, created lazily as envs register. */
    graphs: Map<string, Map<string, ModNode>>;
    /** transform cache: module id → env → { version, result }. Per-env because
     *  the same module transforms differently per realm (envPlugin literals). */
    transformCache: Map<string, Map<string, { version: number; result: TransformResult }>>;
    /** bumped on every edit; drives cache-bust + invalidate. */
    version: number;
    /** HMR push channels registered by each env's transport. */
    pushers: Map<string, (p: HotPayload) => void>;
};

export function initDevServer(fs: Filesystem, isExternal: (spec: string) => boolean): DevServerState {
    return { fs, isExternal, graphs: new Map(), transformCache: new Map(), version: 0, pushers: new Map() };
}

export function registerPusher(state: DevServerState, env: string, push: (p: HotPayload) => void): void {
    state.pushers.set(env, push);
}

/** normalize a module id to its fs-relative form: strip cache-bust query +
 *  any leading slash. Module ids ARE fs paths ('src/index.ts'). */
function normalize(id: string): string {
    return id.replace(/[?#].*$/, '').replace(/^\/+/, '');
}

/** resolve a user specifier relative to its importer to an fs-relative id. */
function resolve(state: DevServerState, spec: string, importer: string | undefined): string {
    if (spec.startsWith('.')) {
        const base = importer ? normalize(importer) : '';
        const dir = base.slice(0, base.lastIndexOf('/'));
        return withExt(state, posixJoin(dir, spec));
    }
    // engine imports resolve to the prebundled dist seeded in the vfs (bundled
    // in, NOT external): `bongle` → dist/index.js, `bongle/X` → dist/X.js.
    if (spec === 'bongle' || spec.startsWith('bongle/')) {
        const sub = spec === 'bongle' ? 'index' : spec.slice('bongle/'.length);
        return `node_modules/bongle/dist/${sub}.js`;
    }
    // root-relative fs path ('src/index.ts' or '/src/index.ts').
    return withExt(state, normalize(spec));
}

function withExt(state: DevServerState, id: string): string {
    // fs paths are known synchronously via a cheap membership probe would be
    // async; instead try the common extensions by convention. The graph only
    // needs a stable id; fetchModule reads the actual bytes.
    for (const cand of [id, `${id}.ts`, `${id}.tsx`, `${id}/index.ts`]) {
        if (state.transformCache.has(cand)) return cand;
    }
    // default to .ts if extension-less (user src is TS).
    return /\.[a-z]+$/.test(id) ? id : `${id}.ts`;
}

function posixJoin(dir: string, rel: string): string {
    const out: string[] = [];
    for (const p of `${dir}/${rel}`.split('/')) {
        if (p === '' || p === '.') continue;
        if (p === '..') out.pop();
        else out.push(p);
    }
    return out.join('/');
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

/** transport: fetch a module for `env`. Bare specifiers externalize. */
export async function fetchModule(
    state: DevServerState,
    env: string,
    rawId: string,
    importer: string | undefined,
    opts: { cached?: boolean },
): Promise<FetchResult> {
    if (state.isExternal(rawId)) return { externalize: rawId, type: 'module' };

    const id = resolve(state, rawId, importer);
    let source: string;
    try {
        source = await state.fs.readText(id);
    } catch {
        throw new Error(`[dev-server:${env}] module not found: ${rawId} (resolved ${id}) from ${importer}`);
    }

    const node = ensureNode(state, env, id);

    // per-env transform cache (id → env → entry). withExt only needs the outer
    // key, so extension resolution still works.
    let byEnv = state.transformCache.get(id);
    if (!byEnv) {
        byEnv = new Map();
        state.transformCache.set(id, byEnv);
    }
    const cached = byEnv.get(env);
    let result: TransformResult;
    if (cached && cached.version === state.version) {
        result = cached.result;
    } else {
        // prebundled lib chunks (node_modules/bongle) are NOT user code — no
        // capture wrapper; user project modules get it.
        const capture = !id.startsWith('node_modules/');
        result = await transformModule(id, source, { env: envValuesFor(env), capture });
        byEnv.set(env, { version: state.version, result });
    }
    node.selfAccepts = !id.startsWith('node_modules/'); // user modules self-accept (postlude); lib chunks don't

    // refresh this env's import edges.
    node.imports.clear();
    for (const dep of result.deps) {
        if (state.isExternal(dep)) continue; // externals aren't graph nodes
        const depId = resolve(state, dep, id);
        node.imports.add(depId);
        ensureNode(state, env, depId).importers.add(id);
    }

    if (opts.cached && node.lastVersion === state.version) return { cache: true };
    const invalidate = node.lastVersion !== state.version && node.lastVersion !== -1;
    node.lastVersion = state.version;
    return { code: result.code, file: id, id, url: id, invalidate };
}

/** edit → HMR: re-read the changed file, bump version, push updates per env. */
export async function applyEdit(state: DevServerState, path: string): Promise<void> {
    const id = normalize(path);
    state.version++;
    state.transformCache.delete(id);

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
