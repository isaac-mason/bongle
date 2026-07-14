// editor/bundler/runner.ts — a Vite ModuleRunner wired to the in-browser dev
// server, with an externals map that resolves engine (`bongle*`) imports to the
// host's ONE engine instance (so user code + pipeline share the registry).
//
// The runner evaluates ONLY user project modules (served by the dev server);
// every bare specifier externalizes and is resolved here from `externals`.

import { ESModulesEvaluator, ModuleRunner, type ModuleRunnerOptions, type ModuleRunnerTransport } from 'vite/module-runner';

/** the runner's link to the dev server. */
export type RunnerBridge = {
    /** request/response for fetchModule (+ getBuiltins). */
    invoke: (data: unknown) => Promise<{ result: unknown } | { error: unknown }>;
    /** register to receive server→runner HMR pushes. */
    onMessage: (cb: (payload: unknown) => void) => void;
    /** runner→server messages (hot.invalidate() bounces vite:invalidate here). */
    send: (payload: unknown) => void;
};

/** ESModulesEvaluator for the browser realms. The engine (`bongle*`) is NOT
 *  external — it's bundled from the vfs dist through the graph, so per-env
 *  envPlugin applies to it. Only node builtins (stubbed — the engine's node-only
 *  paths are DCE'd/unused in browser realms) and real npm deps (native import in
 *  the realm's own context) stay external. */
class BrowserEvaluator extends ESModulesEvaluator {
    async runExternalModule(filepath: string): Promise<unknown> {
        // Browser realms must carry NO Node builtins: node-only server bits live
        // in bongle/engine-server-node, which the editor never imports. A node:
        // import reaching here is a composition leak — fail loudly rather than
        // stub it (which would mask the leak).
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
 *  plus a few runtime probes (emit/cpuUsage/memoryUsage). The browser realm has
 *  no `process`, so install a minimal shim before any engine chunk evaluates. */
function ensureProcessShim(): void {
    // biome-ignore lint/suspicious/noExplicitAny: patching the realm global.
    const g = globalThis as any;
    g.process ??= {
        env: { NODE_ENV: 'production' },
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
    ensureProcessShim();

    // biome-ignore lint/suspicious/noExplicitAny: transport onMessage payload is loosely typed.
    let onMessageCb: ((p: any) => void) | undefined;
    bridge.onMessage((p) => onMessageCb?.(p));

    const transport: ModuleRunnerTransport = {
        async connect(handlers) {
            onMessageCb = handlers.onMessage;
            // announce connected so the HMR client is ready.
            handlers.onMessage({ type: 'connected' });
        },
        // biome-ignore lint/suspicious/noExplicitAny: transport invoke is loosely typed.
        invoke: (data: any) => bridge.invoke(data) as any,
        // biome-ignore lint/suspicious/noExplicitAny: transport send is loosely typed.
        send: (data: any) => bridge.send(data),
    };

    const options: ModuleRunnerOptions = {
        transport,
        hmr: true,
        sourcemapInterceptor: false,
        // We own import.meta. url must be a VALID absolute URL — bundled engine
        // chunks do `new URL(x, import.meta.url)` (worker/wasm loaders), which
        // throws on a bare-path base. A `file://` href off the clean module id
        // keeps it stable + unique across re-evals (the __kit capture keys module
        // snapshots by it) while being a legal base. The runner injects
        // import.meta.hot itself.
        createImportMeta: async (modulePath: string) =>
            ({
                url: `file:///${modulePath.replace(/^\/+/, '')}`,
                filename: modulePath,
                // biome-ignore lint/suspicious/noExplicitAny: import.meta shape is loose.
            }) as any,
    };

    return new ModuleRunner(options, new BrowserEvaluator());
}
