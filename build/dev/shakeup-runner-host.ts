// build/dev/shakeup-runner-host.ts — the browser host bits for a shakeup realm runner.
//
// Ports makecat's runner.ts host onto shakeup's RunnerOptions shape (ModuleEvaluator, prepare,
// createImportMeta) instead of vite's ESModulesEvaluator/RunnerHost. A browser realm carries NO
// node builtins, needs a `process` shim for engine deps, and its import.meta.url is the module's
// project-fs SW URL.

import { defaultEvaluator, type ImportMetaInit, type ModuleEvaluator } from 'shakeup';

/**
 * Browser evaluator: the default (AsyncFunction body + dynamic-import externals), but a `node:`
 * builtin reaching `runExternalModule` is a composition leak in a browser realm — fail loudly
 * rather than stub it (node-only server bits live behind bongle/engine-server-node).
 */
export const browserEvaluator: ModuleEvaluator = {
    ...defaultEvaluator,
    async runExternalModule(spec: string): Promise<unknown> {
        if (spec.startsWith('node:')) {
            throw new Error(
                `[editor] node builtin '${spec}' entered a browser realm — it belongs behind a node-only entry (see bongle/engine-server-node)`,
            );
        }
        return defaultEvaluator.runExternalModule(spec);
    },
};

/**
 * Install a minimal `process` shim before the first module evaluates. Engine deps bundled into the
 * dist read `process.env.NODE_ENV` + a few runtime probes; the browser has no `process`. `??=` so a
 * real `process` (node) is never clobbered. Wire as RunnerOptions.prepare.
 */
export function ensureProcessShim(): void {
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

/**
 * Build a `createImportMeta` for a realm: a module's import.meta.url is its project-fs SW URL, so
 * `new URL('./x.png', import.meta.url)` — the engine's asset-ref pattern — resolves to a real,
 * SW-served sibling. `urlOf` is injected by the editor (its `projectUrl`).
 */
export function makeImportMeta(urlOf: (modulePath: string) => string): (modulePath: string) => ImportMetaInit {
    return (modulePath) => ({ url: urlOf(modulePath), filename: modulePath });
}
