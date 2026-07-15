// editor/bundler/worker-bundle.ts — bundle a `?worker` entry into a
// self-contained ESM string, the way vite's `?worker&inline` does.
//
// A Worker can't run the editor's per-module ModuleRunner (that needs a live
// bridge to the host dev-server), and — like vite — we don't hot-patch a running
// worker anyway. So we bundle the worker's whole graph ONCE into one blob and
// `new Worker(blobURL)`. This runs @rolldown/browser over the vfs (same bundler
// as the publish build), resolving through resolve.ts (World C) and baking env
// (the worker is a self-contained artifact — no runtime `env` object to mutate).

import { type Plugin, rolldown } from '@rolldown/browser';
import type { Filesystem } from '../fs';
import { type EnvValues, replaceEnv } from '../../plugin';
import { dirOf, posixJoin, resolveFile, resolveModule } from './resolve';
import { ensureProcessShim } from './runner';

// The worker runs in the client render pipeline (CPU meshing, no DOM). Bake
// client env; the worker never sets a runtime `env`, so literals must be baked.
const WORKER_ENV: EnvValues = { client: true, server: false, editor: true };

/** rolldown plugin: resolve + load the worker's graph from the vfs, bake env. */
function vfsWorkerPlugin(fs: Filesystem, entryId: string): Plugin {
    return {
        name: 'bongle:worker-vfs',
        async resolveId(source, importer) {
            if (source === entryId) return entryId;
            if (source.startsWith('node:')) return { id: source, external: true };
            if (!importer) return entryId;
            const clean = source.replace(/[?#].*$/, '');
            if (clean.startsWith('.')) return resolveFile(fs, posixJoin(dirOf(importer), clean));
            return resolveModule(fs, clean, importer);
        },
        async load(id) {
            const code = await fs.readText(id);
            // the worker graph is bongle .ts SOURCE — tell rolldown to strip types
            // (don't rely on extension inference through the vfs plugin).
            const ext = id.slice(id.lastIndexOf('.') + 1);
            const moduleType = ext === 'tsx' ? 'tsx' : ext === 'ts' ? 'ts' : ext === 'jsx' ? 'jsx' : 'js';
            return { code, moduleType };
        },
        transform(code) {
            const out = replaceEnv(code, WORKER_ENV);
            return out === code ? null : out;
        },
    };
}

/** bundle a vfs worker entry (e.g. a mesh-worker.entry.ts) → one self-contained
 *  ESM string, ready to wrap in a Blob + `new Worker`. */
export async function bundleWorkerEntry(fs: Filesystem, entryId: string): Promise<string> {
    ensureProcessShim(); // @rolldown/browser reads `process` in bindingifyInputOptions
    const bundle = await rolldown({
        input: { worker: entryId },
        plugins: [vfsWorkerPlugin(fs, entryId)],
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
    if (!entry || entry.type !== 'chunk') throw new Error(`[worker-bundle] no entry chunk for ${entryId}`);
    return entry.code;
}

/** the module the `?worker` import evaluates to: a `WorkerWrapper` that blobs the
 *  bundled code + `new Worker`s it (mirrors vite's `?worker&inline` output, incl.
 *  the `data:` fallback). `new WorkerWrapper()` returns the Worker. */
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
