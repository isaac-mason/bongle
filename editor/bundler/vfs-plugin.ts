// editor/bundler/vfs-plugin.ts — the shared @rolldown/browser plugin for
// bundling from the editor's vfs, used by the publish build (build.ts) and by
// worker bundling. ONE resolver (resolve.ts, World C), ONE set of vfs concerns:
//   - resolve relative + bare (package.json exports) + `/`-absolute + a virtual
//     entry; node: (and caller externals like sharp) stay external;
//   - load with the right `moduleType` (bongle ships .ts SOURCE — rolldown must
//     strip types), `.css` → empty side-effect module, `?worker` → a
//     self-contained blob (bundled here, then vite's WorkerWrapper);
//   - bake env (replaceEnv) + a caller-specific transform hook.
//
// The dev path (dev-server.ts) doesn't use this — it drives a ModuleRunner, not
// rolldown — but it shares the same worker bundling helpers below.

import { type Plugin, rolldown } from '@rolldown/browser';
import type { Filesystem } from '../fs';
import { type EnvValues, replaceEnv } from '../../plugin';
import { dirOf, posixJoin, resolveFile, resolveModule } from './resolve';
import { ensureProcessShim } from './runner';

/** `?worker` imports resolve to this-prefixed ids; load() bundles + wraps them. */
const WORKER_PREFIX = '\0worker:';

type ModuleType = 'ts' | 'tsx' | 'jsx' | 'js';
function moduleTypeOf(id: string): ModuleType {
    const ext = id.slice(id.lastIndexOf('.') + 1);
    return ext === 'tsx' ? 'tsx' : ext === 'ts' ? 'ts' : ext === 'jsx' ? 'jsx' : 'js';
}

export type VfsPluginOptions = {
    /** env values baked into every module (replaceEnv). */
    env: EnvValues;
    /** a virtual entry module (e.g. build.ts's generated play entry): id + code.
     *  Served verbatim (not env-replaced/transformed). */
    entry?: { id: string; code: string };
    /** bare specifiers to externalize beyond node: (e.g. sharp for the server). */
    external?: (source: string) => boolean;
    /** caller-specific transform run AFTER env replacement (e.g. build.ts's __kit
     *  injection for user src + asset-url stripping). */
    transformExtra?: (code: string, id: string) => string;
    /** PRE-BUILT `?worker` bundles (entry id → self-contained code). Required for
     *  any `?worker` in the graph: @rolldown/browser can't bundle a nested build
     *  from inside a plugin hook (main-thread Atomics.wait), so workers are built
     *  BEFORE the main bundle (see bundleWorkers) and looked up here. */
    workers?: Map<string, string>;
};

/** the shared vfs bundling plugin. */
export function createVfsPlugin(fs: Filesystem, opts: VfsPluginOptions): Plugin {
    return {
        name: 'bongle:vfs',
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
                        : ((await resolveModule(fs, base, importer)) ?? base);
                return `${WORKER_PREFIX}${baseId}`;
            }

            const clean = source.replace(/[?#].*$/, '');
            if (!importer) return (await resolveFile(fs, clean)) ?? clean; // an entry input (real file)
            if (clean.startsWith('/')) {
                const rooted = clean.replace(/^\/+/, '');
                return (await resolveFile(fs, rooted)) ?? rooted;
            }
            return resolveModule(fs, clean, importer); // relative + bare (exports)
        },
        async load(id) {
            if (opts.entry && id === opts.entry.id) return { code: opts.entry.code, moduleType: 'js' };
            if (id.startsWith(WORKER_PREFIX)) {
                const entryId = id.slice(WORKER_PREFIX.length);
                const jsContent = opts.workers?.get(entryId);
                if (jsContent === undefined) {
                    throw new Error(
                        `[vfs-plugin] worker not pre-bundled: ${entryId} — call bundleWorkers() before the main build (nested @rolldown/browser deadlocks).`,
                    );
                }
                return { code: workerWrapperModule(jsContent), moduleType: 'js' };
            }
            // styles ship prebuilt (bongle.css); the import is a harmless no-op.
            if (id.endsWith('.css')) return { code: '', moduleType: 'js' };
            return { code: await fs.readText(id), moduleType: moduleTypeOf(id) };
        },
        transform(code, id) {
            if (opts.entry && id === opts.entry.id) return null;
            let out = replaceEnv(code, opts.env);
            if (opts.transformExtra) out = opts.transformExtra(out, id);
            return out === code ? null : out;
        },
    };
}

// ── worker bundling (vite's ?worker&inline, over the vfs) ────────────────────

/** discover every `?worker` import across the project + engine source and bundle
 *  each entry AHEAD of the main build (standalone, non-nested rolldown calls) →
 *  a map the createVfsPlugin `?worker` load looks up. */
export async function bundleWorkers(fs: Filesystem, env: EnvValues): Promise<Map<string, string>> {
    const workers = new Map<string, string>();
    for (const dir of ['src', 'node_modules/bongle/src']) {
        const files = await fs.list(dir, { recursive: true }).catch(() => []);
        for (const f of files) {
            if (f.kind !== 'file' || !/\.tsx?$/.test(f.path)) continue;
            const code = await fs.readText(f.path);
            if (!code.includes('?worker')) continue;
            for (const m of code.matchAll(/from\s*['"]([^'"]*\?worker[^'"]*)['"]/g)) {
                const spec = m[1].replace(/\?.*$/, '');
                if (!spec.startsWith('.')) continue; // relative worker entries only (our case)
                const entryId = await resolveFile(fs, posixJoin(dirOf(f.path), spec));
                if (!entryId || workers.has(entryId)) continue;
                workers.set(entryId, await bundleWorkerEntry(fs, entryId, env));
            }
        }
    }
    return workers;
}

/** bundle a vfs worker entry → one self-contained ESM string, ready to blob. */
export async function bundleWorkerEntry(fs: Filesystem, entryId: string, env: EnvValues): Promise<string> {
    ensureProcessShim(); // @rolldown/browser reads `process` in bindingifyInputOptions
    const bundle = await rolldown({
        input: { worker: entryId },
        plugins: [createVfsPlugin(fs, { env })],
        external: [/^node:/],
        platform: 'browser',
        onLog: (level, log, handler) => {
            if (log.code === 'INEFFECTIVE_DYNAMIC_IMPORT' || log.code === 'CIRCULAR_DEPENDENCY') return;
            handler(level, log);
        },
    });
    // one chunk: a Worker blob can't fetch sibling code-split chunks off a blob:
    // url, so inline any dynamic imports.
    const { output } = await bundle.generate({ format: 'es', inlineDynamicImports: true, minify: true });
    await bundle.close();
    const entry = output.find((o) => o.type === 'chunk' && o.isEntry);
    if (!entry || entry.type !== 'chunk') throw new Error(`[vfs-plugin] no worker entry chunk for ${entryId}`);
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
