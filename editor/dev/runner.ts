// editor/bundler/runner.ts — the BROWSER wiring of the host-neutral realm runner
// (build/runner.ts). The ModuleRunner core lives in build; this injects the
// browser bits: import.meta as the module's project-fs SW URL, an evaluator that
// rejects `node:` builtins (a composition leak in a browser realm), and a
// `process` shim for engine deps that read `process.env`.

import { ESModulesEvaluator, type ModuleRunner } from 'vite/module-runner';
import { makeRunner as makeRealmRunner, type RunnerBridge } from '../../build';
import { projectUrl } from '../project-url';

export type { RunnerBridge };

/** Browser realms must carry NO Node builtins: node-only server bits live in
 *  bongle/engine-server-node, which the editor never imports. A `node:` import
 *  reaching here is a composition leak — fail loudly rather than stub it (which
 *  would mask the leak). (The engine bundle itself is NOT external — it's served +
 *  evaluated through the graph; only real npm deps native-import here.) */
class BrowserEvaluator extends ESModulesEvaluator {
    async runExternalModule(filepath: string): Promise<unknown> {
        if (filepath.startsWith('node:')) {
            throw new Error(
                `[editor] node builtin '${filepath}' entered a browser realm — it belongs behind a node-only entry (see bongle/engine-server-node)`,
            );
        }
        return super.runExternalModule(filepath);
    }
}

/** npm deps bundled into the engine dist reference `process` — mostly
 *  `process.env.NODE_ENV` (the prebundle also build-defines this to a literal),
 *  plus a few runtime probes (emit/cpuUsage/memoryUsage). @rolldown/browser's
 *  bundler (main-thread prod build) also reads `process` in bindingifyInputOptions.
 *  The browser has no `process`, so install a minimal shim before either runs. */
export function ensureProcessShim(): void {
    // biome-ignore lint/suspicious/noExplicitAny: patching the realm global.
    const g = globalThis as any;
    g.process ??= {
        env: { NODE_ENV: 'production' },
        cwd: () => '/',
        emit: () => false,
        cpuUsage: () => ({ user: 0, system: 0 }),
        memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
        platform: 'browser',
        argv: [],
        version: '',
        versions: {},
        nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
    };
}

export function makeRunner(bridge: RunnerBridge): ModuleRunner {
    return makeRealmRunner(bridge, {
        prepare: ensureProcessShim,
        evaluator: new BrowserEvaluator(),
        // import.meta.url is the module's own project-fs SW URL
        // (`<origin><base>@project/<path>`), so `new URL('./x.png', import.meta.url)`
        // — the engine's asset-ref pattern — resolves to a real, SW-served sibling
        // (src/** + seeded node_modules/** alike). Valid absolute base, stable +
        // unique across re-evals (the __bongle capture keys module snapshots by it).
        createImportMeta: async (modulePath) => ({
            url: new URL(projectUrl(modulePath), location.origin).href,
            filename: modulePath,
        }),
    });
}
