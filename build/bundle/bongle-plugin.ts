// lib/build/bongle-plugin.ts — the shakeup plugin that compiles bongle (+ the
// user's game) SOURCE into a module graph, used by the publish build (bundle.ts)
// and by worker bundling. ONE resolver (resolve.ts, World C), one set of concerns:
//   - resolve relative + bare (package.json exports) + `/`-absolute + a virtual
//     entry; node: (and caller externals like sharp) stay external;
//   - load: `.css` → empty side-effect module, `?worker` → a self-contained blob;
//   - bake env (replaceEnv) + a caller-specific transform hook.
//
// Host-neutral by construction now: shakeup is pure JS, so the SAME code runs in
// the browser editor and the node CLI with no injected bundler and no host prep.
// The dev path (dev/shakeup-host.ts) drives shakeup's dev server over the same
// resolve.ts; this is its build-time twin.
//
// Hooks are shakeup-shaped: rollup's calling convention, so the plugin context is `this`
// rather than a leading parameter. One bundler, one definition — the editor and the CLI run
// this identical path.

import { bundle, type Plugin, packageSideEffectsFor } from 'shakeup';
import { type EnvValues, replaceEnv } from '../env-replace';
import { type BuildFs, dirOf, posixJoin, resolveFile, resolveModule, shakeupFs } from '../resolve';

// bongle resolves to its BUILT dist (default import/default conditions), like any
// consumer — the dist is env-neutral, so replaceEnv below still bakes env for DCE.
// (The browser editor's vfs only ships dist, not src; and the `source` condition
// is reserved for tooling that has the source tree, e.g. lib's own tsgo.)

type ModuleType = 'ts' | 'tsx' | 'jsx' | 'js';
function moduleTypeOf(id: string): ModuleType {
    const ext = id.slice(id.lastIndexOf('.') + 1);
    return ext === 'tsx' ? 'tsx' : ext === 'ts' ? 'ts' : ext === 'jsx' ? 'jsx' : 'js';
}

/** `?worker` imports resolve to this-prefixed ids; load() bundles + wraps them. */
const WORKER_PREFIX = '\0worker:';

/** `false` / `true` / one glob / an array of globs. Anything else is not a declaration. */
function parseSideEffects(raw: unknown): boolean | string[] | undefined {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') return [raw];
    if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
    return undefined;
}

/** Read `package.json#sideEffects` for a package. shakeup's own resolver surfaces this, but
 *  we resolve + load every module ourselves (resolve.ts), so it never runs and the field would go
 *  unread — which is what kept `bongle/kit` whole: its declarations are pure, but a call to an
 *  imported `block()` is impure per-statement, so without the manifest saying otherwise every one of
 *  them is rooted. The owning package is whatever follows the INNERMOST `node_modules/`: that is the
 *  id's prefix in the editor's flat vfs, and the real nested location under a node host, where a
 *  realpath'd id points into pnpm's store. */
function packageDirOf(id: string): string | null {
    const at = id.lastIndexOf('node_modules/');
    if (at === -1) return null; // project source — decide per statement
    const dir = id.slice(0, at + 'node_modules/'.length);
    const parts = id.slice(at + 'node_modules/'.length).split('/');
    const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    return name ? `${dir}${name}` : null;
}

export type BonglePluginOptions = {
    /** env values baked into every module (replaceEnv). */
    env: EnvValues;
    /** a virtual entry module (e.g. build.ts's generated play entry): id + code.
     *  Served verbatim (not env-replaced/transformed). */
    entry?: { id: string; code: string };
    /** bare specifiers to externalize beyond node: (e.g. sharp for the server). */
    external?: (source: string) => boolean;
    /** extra plugins for the nested `?worker` bundle (the caller's `json()` etc.). */
    workerPlugins?: Plugin[];
};

/** the shakeup plugin that compiles bongle (+ game) source into a module graph. */
export function createBonglePlugin(fs: BuildFs, opts: BonglePluginOptions): Plugin {
    // one nested bundle per worker entry, however many modules import it.
    const workerCache = new Map<string, string>();
    // package dir → its parsed `sideEffects`, so a verdict costs one manifest read per package.
    const sideEffectsCache = new Map<string, boolean | string[] | undefined>();

    /** the manifest's `sideEffects` verdict for `id`, or undefined when nothing declares one. */
    async function sideEffectsOf(id: string): Promise<boolean | undefined> {
        const dir = packageDirOf(id);
        if (dir === null) return undefined;
        if (!sideEffectsCache.has(dir)) {
            let declared: boolean | string[] | undefined;
            try {
                declared = parseSideEffects(JSON.parse(await fs.readText(`${dir}/package.json`)).sideEffects);
            } catch {
                declared = undefined;
            }
            sideEffectsCache.set(dir, declared);
        }
        return packageSideEffectsFor({ dir, sideEffects: sideEffectsCache.get(dir) }, id);
    }
    return {
        name: 'bongle:source',
        async resolveId(source, importer) {
            if (opts.entry && source === opts.entry.id) return opts.entry.id;
            if (source.startsWith('node:')) return { id: source, external: true };
            if (opts.external?.(source)) return { id: source, external: true };

            // `x?worker&inline` → resolve the base entry, tag it for load().
            const q = source.indexOf('?');
            if (q !== -1 && /\bworker\b/.test(source.slice(q))) {
                const base = source.slice(0, q);
                const baseId =
                    base.startsWith('.') && importer
                        ? ((await resolveFile(fs, posixJoin(dirOf(importer), base))) ?? posixJoin(dirOf(importer), base))
                        : ((await resolveModule(fs, base, importer ?? undefined)) ?? base);
                return `${WORKER_PREFIX}${baseId}`;
            }

            const clean = source.replace(/[?#].*$/, '');
            if (!importer) return (await resolveFile(fs, clean)) ?? clean; // an entry input (real file)
            if (clean.startsWith('/')) {
                const rooted = clean.replace(/^\/+/, '');
                return (await resolveFile(fs, rooted)) ?? rooted;
            }
            return resolveModule(fs, clean, importer ?? undefined); // relative + bare (exports)
        },
        async load(id) {
            if (opts.entry && id === opts.entry.id) return { code: opts.entry.code, moduleType: 'js' };
            if (id.startsWith(WORKER_PREFIX)) {
                const entryId = id.slice(WORKER_PREFIX.length);
                // Bundled RIGHT HERE, nested inside this load hook. Under rolldown this
                // was impossible — @rolldown/browser is one wasm instance over a shared
                // WASI pool, so a nested build deadlocked on main-thread Atomics.wait,
                // which forced a whole discovery pre-pass (scan every source file for
                // `?worker` strings, bundle each ahead of time, thread a map through).
                // shakeup is pure JS and reentrant, so the pre-pass is gone.
                let jsContent = workerCache.get(entryId);
                if (jsContent === undefined) {
                    jsContent = await bundleWorkerEntry(fs, entryId, opts.env, opts.workerPlugins);
                    workerCache.set(entryId, jsContent);
                }
                return { code: workerWrapperModule(jsContent), moduleType: 'js' };
            }
            // styles ship prebuilt (bongle.css); the import is a harmless no-op.
            if (id.endsWith('.css')) return { code: '', moduleType: 'js' };
            // the standalone scene barrel statically imports content/scenes/*.json.
            // Converted here rather than via shakeup's `json()` plugin so the same
            // definition also serves rolldown (which would otherwise parse raw JSON as
            // a program). Verified against shakeup's bundler too.
            if (id.endsWith('.json')) return { code: `export default ${await fs.readText(id)}`, moduleType: 'js' };
            return { code: await fs.readText(id), moduleType: moduleTypeOf(id), moduleSideEffects: await sideEffectsOf(id) };
        },
        transform(code, id) {
            if (opts.entry && id === opts.entry.id) return null;
            const out = replaceEnv(code, opts.env);
            return out === code ? null : out;
        },
    };
}

// ── worker bundling (vite's ?worker&inline, over the vfs) ────────────────────

/** bundle a vfs worker entry → one self-contained ESM string, ready to blob. */
export async function bundleWorkerEntry(
    fs: BuildFs,
    entryId: string,
    env: EnvValues,
    extraPlugins: Plugin[] = [],
): Promise<string> {
    const r = await bundle({
        input: { worker: entryId },
        fs: shakeupFs(fs),
        plugins: [createBonglePlugin(fs, { env }), ...extraPlugins],
        external: (s) => s.startsWith('node:'),
        platform: 'browser',
        output: {
            // a Worker blob can't fetch sibling code-split chunks off a blob: url,
            // so inline any dynamic imports.
            inlineDynamicImports: true,
            minify: true,
        },
    });
    if (r.errors.length > 0) throw new Error(`[bongle-plugin] worker bundle failed for ${entryId}:\n${r.errors.join('\n')}`);
    const entry = r.chunks.find((c) => c.isEntry);
    if (!entry) throw new Error(`[bongle-plugin] no worker entry chunk for ${entryId}`);
    return entry.code;
}

/** the module a `?worker` import evaluates to: a `WorkerWrapper` that blobs the
 *  bundled code + `new Worker`s it (mirrors vite's `?worker&inline`). */
export function workerWrapperModule(jsContent: string): string {
    return `const jsContent = ${JSON.stringify(jsContent)};
const blob = typeof self !== 'undefined' && self.Blob && new Blob(['URL.revokeObjectURL(import.meta.url);', jsContent], { type: 'text/javascript;charset=utf-8' });
export default function WorkerWrapper(options) {
    let objURL;
    try {
        objURL = blob && (self.URL || self.webkitURL).createObjectURL(blob);
        if (!objURL) throw '';
        const worker = new Worker(objURL, { type: 'module', name: options?.name });
        worker.addEventListener('error', () => { (self.URL || self.webkitURL).revokeObjectURL(objURL); });
        return worker;
    } catch (e) {
        return new Worker('data:text/javascript;charset=utf-8,' + encodeURIComponent(jsContent), { type: 'module', name: options?.name });
    }
}
`;
}
