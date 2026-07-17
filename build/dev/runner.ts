// build/runner.ts — the host-neutral realm RUNNER: a Vite ModuleRunner wired to
// the dev server, which EVALUATES the transformed module graph the server serves
// (engine + user source — World C; only real npm deps + node: builtins stay
// external). The host-specific bits — import.meta base, the evaluator's external
// policy, an optional pre-eval hook — are INJECTED via RunnerHost (mirrors
// createTransformModule): the browser editor wires the /@project SW URL + a
// node-builtin-rejecting evaluator + a process shim (editor/bundler/runner.ts);
// `bongle dev`'s node realms use the node-neutral defaults here.

import { ESModulesEvaluator, ModuleRunner, type ModuleRunnerOptions, type ModuleRunnerTransport } from 'vite/module-runner';

/** the runner's link to the dev server — the realm side of the BundlerFrame
 *  protocol (createPortBridge builds one over a transport). */
export type RunnerBridge = {
    /** request/response for fetchModule (+ getBuiltins). */
    invoke: (data: unknown) => Promise<{ result: unknown } | { error: unknown }>;
    /** register to receive server→runner HMR pushes. */
    onMessage: (cb: (payload: unknown) => void) => void;
    /** runner→server messages (hot.invalidate() bounces vite:invalidate here). */
    send: (payload: unknown) => void;
};

/** host-specific bits of a realm runner; each host injects its variants. Defaults
 *  are node-neutral (file:// import.meta, a plain evaluator, no pre-eval hook). */
export type RunnerHost = {
    /** run before eval (browser: ensureProcessShim; node: omit). */
    prepare?: () => void;
    /** a module's import.meta. Browser: its project-fs SW URL; node: a file://
     *  base, which the fs-backed loader reads by pathname. */
    createImportMeta?: (modulePath: string) => Promise<{ url: string; filename: string }>;
    /** the evaluator. Browser: rejects node: (a composition leak); node: the plain
     *  ESModulesEvaluator (native-imports node: + deps). */
    evaluator?: ESModulesEvaluator;
};

export function makeRunner(bridge: RunnerBridge, host: RunnerHost = {}): ModuleRunner {
    host.prepare?.();

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
        // import.meta.url must be a VALID absolute URL, stable + unique across
        // re-evals (the __kit capture keys module snapshots by it). The default
        // file:// base suits node realms (the fs loader reads asset refs by
        // pathname); the browser editor overrides it with the /@project SW URL.
        createImportMeta: (host.createImportMeta ??
            (async (modulePath: string) => ({
                url: `file:///${modulePath.replace(/^\/+/, '')}`,
                filename: modulePath,
                // biome-ignore lint/suspicious/noExplicitAny: import.meta shape is loose.
            }))) as any,
    };

    return new ModuleRunner(options, host.evaluator ?? new ESModulesEvaluator());
}
