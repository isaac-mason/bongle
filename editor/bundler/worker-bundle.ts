// editor/bundler/worker-bundle.ts — the browser impl of the dev server's
// `bundleWorker` capability (lib/build injects it): bundle a `?worker` entry's
// graph into a self-contained WorkerWrapper module source.
//
// Kept out of the host-neutral dev server because it reaches into rolldown. Lazy-
// loads @rolldown/browser (its multi-GB wasm arena only when a worker is first
// hit) and caches per entry — the seed is immutable, so entry id alone keys it.

import type { Bundler, BundleWorker } from '../../build';
import type { Filesystem } from '../fs';
import { ensureProcessShim } from './runner';

export function createBundleWorker(fs: Filesystem): BundleWorker {
    const cache = new Map<string, string>();
    return async (entryId) => {
        const hit = cache.get(entryId);
        if (hit !== undefined) return hit;
        // lazy: @rolldown/browser's wasm loads only when a ?worker is actually hit.
        const [{ bundleWorkerEntry, workerWrapperModule }, { rolldown }] = await Promise.all([
            import('../../build/bongle-plugin'),
            import('@rolldown/browser'),
        ]);
        // the worker runs in the client render pipeline (CPU compute, no DOM).
        const bundled = await bundleWorkerEntry(
            fs,
            entryId,
            { client: true, server: false, editor: true },
            { rolldown: rolldown as unknown as Bundler['rolldown'], prepare: ensureProcessShim },
        );
        const wrapper = workerWrapperModule(bundled);
        cache.set(entryId, wrapper);
        return wrapper;
    };
}
