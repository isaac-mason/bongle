// editor/bundler/bundler.ts — wires the in-browser dev server to a ModuleRunner
// and evaluates the user project. init()+State+fns.
//
// One env for now ('user'): evaluates the project entry so its declarations
// populate the engine registry (the pipeline then bakes off that registry).
// The client/server realms are added later, each its own env + runner.
//
// Engine (`bongle*`) imports externalize to `externals` (the host's one engine
// instance). Bake-on-edit is NOT wired here — the host registers a
// `__kit.registerFlush` handler; user modules self-accept and call flush, which
// runs that handler.

import type { Filesystem, FsChange } from '../fs';
import { applyEdit, fetchModule, handleRunnerMessage, initDevServer, registerPusher } from './dev-server';
import { type Externals, makeRunner, type RunnerBridge } from './runner';

const ENV = 'user';

export type BundlerState = {
    devServer: ReturnType<typeof initDevServer>;
    /** the ModuleRunner evaluating user code. */
    runner: ReturnType<typeof makeRunner>;
    /** fs-change subscription; closed on dispose. */
    watch: { close(): void };
};

export type StartBundlerOptions = {
    fs: Filesystem;
    /** engine module map for externalized `bongle*` imports. */
    externals: Externals;
    /** project entry to evaluate (e.g. 'src/index.ts'). */
    entry: string;
};

/** Start the bundler: evaluate the project entry, then re-evaluate changed
 *  user modules on fs edits (HMR). Returns after the entry has evaluated once
 *  (registries populated). */
export async function startBundler(opts: StartBundlerOptions): Promise<BundlerState> {
    const { fs, externals, entry } = opts;
    // a specifier externalizes iff it's an engine import (bongle*) or otherwise
    // in the externals map — NOT a leading-char guess (so `src/index.ts` reads
    // as a user module).
    const isExternal = (spec: string) => spec === 'bongle' || spec.startsWith('bongle/') || externals.has(spec);
    const devServer = initDevServer(fs, isExternal);

    // runner ← dev server bridge. `invoke` dispatches the module-runner RPC
    // (fetchModule/getBuiltins); pushes flow the other way via the pusher.
    let pushToRunner: ((p: unknown) => void) | undefined;
    const bridge: RunnerBridge = {
        async invoke(payload) {
            const call = (payload as { data?: { name?: string; data?: unknown[] } }).data;
            if (call?.name === 'fetchModule') {
                const [id, importer, options] = call.data ?? [];
                const result = await fetchModule(
                    devServer,
                    ENV,
                    id as string,
                    importer as string | undefined,
                    (options as { cached?: boolean }) ?? {},
                );
                return { result };
            }
            if (call?.name === 'getBuiltins') return { result: [] };
            return { result: undefined };
        },
        onMessage(cb) {
            pushToRunner = cb;
        },
        send(payload) {
            handleRunnerMessage(devServer, ENV, payload);
        },
    };
    registerPusher(devServer, ENV, (p) => pushToRunner?.(p));

    const runner = makeRunner(bridge, externals);

    // evaluate the entry — its declarations populate the registry.
    await runner.import(entry);

    // re-evaluate changed user source on edit (HMR). Only .ts/.tsx under src/
    // trigger a re-eval; pipeline-written outputs (resources/, generated
    // barrels are handled by writeIfChanged's no-op guard) don't loop here.
    const watch = fs.watch((changes: FsChange[]) => {
        for (const c of changes) {
            if (c.type === 'deleted') continue;
            if (!/^src\/.*\.tsx?$/.test(c.path)) continue;
            void applyEdit(devServer, c.path);
        }
    });

    return { devServer, runner, watch };
}

export function disposeBundler(state: BundlerState): void {
    state.watch.close();
}
