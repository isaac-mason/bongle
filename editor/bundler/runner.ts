// editor/bundler/runner.ts — a Vite ModuleRunner wired to the in-browser dev
// server, with an externals map that resolves engine (`bongle*`) imports to the
// host's ONE engine instance (so user code + pipeline share the registry).
//
// The runner evaluates ONLY user project modules (served by the dev server);
// every bare specifier externalizes and is resolved here from `externals`.

import { ESModulesEvaluator, ModuleRunner, type ModuleRunnerOptions, type ModuleRunnerTransport } from 'vite/module-runner';

/** engine module map: specifier (e.g. 'bongle', 'bongle/internal') → the
 *  already-loaded module namespace. In dev this is the workspace engine the
 *  host imported; in prod, the pinned engine dist. */
export type Externals = Map<string, unknown>;

/** the runner's link to the dev server. */
export type RunnerBridge = {
    /** request/response for fetchModule (+ getBuiltins). */
    invoke: (data: unknown) => Promise<{ result: unknown } | { error: unknown }>;
    /** register to receive server→runner HMR pushes. */
    onMessage: (cb: (payload: unknown) => void) => void;
    /** runner→server messages (hot.invalidate() bounces vite:invalidate here). */
    send: (payload: unknown) => void;
};

/** ESModulesEvaluator that resolves externalized specifiers from a map first,
 *  falling back to native import for anything not provided. */
class ExternalsEvaluator extends ESModulesEvaluator {
    constructor(private externals: Externals) {
        super();
    }
    async runExternalModule(filepath: string): Promise<unknown> {
        const hit = this.externals.get(filepath);
        if (hit !== undefined) return hit;
        return super.runExternalModule(filepath);
    }
}

export function makeRunner(bridge: RunnerBridge, externals: Externals): ModuleRunner {
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

    return new ModuleRunner(options, new ExternalsEvaluator(externals));
}
