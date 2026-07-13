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
        if (filepath.startsWith('node:')) return {};
        return super.runExternalModule(filepath);
    }
}

export function makeRunner(bridge: RunnerBridge): ModuleRunner {
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
        // We own import.meta: url = the clean module id, STABLE across re-evals
        // (the __kit capture keys module snapshots by it). The runner injects
        // import.meta.hot itself.
        createImportMeta: async (modulePath: string) =>
            ({
                url: modulePath,
                filename: modulePath,
                // biome-ignore lint/suspicious/noExplicitAny: import.meta shape is loose.
            }) as any,
    };

    return new ModuleRunner(options, new BrowserEvaluator());
}
