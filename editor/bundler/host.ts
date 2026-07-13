// editor/bundler/host.ts — the ONE dev server, shared across realms.
//
// Transform is centralized here (per the multiplayer-design contract); each
// realm only EVALUATES. The host owns a single DevServer (one transform cache);
// realms attach as ModuleRunners:
//   - the pipeline realm lives in this document → an in-process runner
//     (createLocalRunner), zero serialization.
//   - the server worker + client iframes live in other realms → a MessagePort
//     conduit (connectRealm here ↔ createPortBridge there); the module-runner
//     protocol (fetchModule invoke + HMR push + vite:invalidate) tunnels over it.
//
// Each realm gets its own `env` graph key so its HMR boundaries + module
// instances are independent; the transform cache is shared, so a given user
// module is transformed once no matter how many realms load it. An fs edit runs
// applyEdit once, which fans HMR to every realm that had loaded the file.

import type { Filesystem, FsChange } from '../fs';
import { applyEdit, fetchModule, handleRunnerMessage, initDevServer, registerPusher } from './dev-server';
import type { BundlerFrame } from './port-bridge';
import { makeRunner, type RunnerBridge } from './runner';

type Runner = ReturnType<typeof makeRunner>;

const isBare = (spec: string) => !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('\0');

// external iff a bare specifier that ISN'T the engine: node builtins (stubbed by
// the runner's evaluator) + real npm deps (native import in the realm). `bongle*`
// is NOT external — it resolves to the prebundled dist in the vfs and is bundled
// through the graph (so the per-env envPlugin applies to it).
const isExternal = (spec: string) => isBare(spec) && !(spec === 'bongle' || spec.startsWith('bongle/'));

export type BundlerHost = {
    /** attach a realm that lives in THIS document (the pipeline). */
    createLocalRunner(env: string): Runner;
    /** attach a realm reached over a MessagePort (server worker / client iframe).
     *  The remote side builds its runner with createPortBridge(port). */
    connectRealm(env: string, port: MessagePort): void;
    /** batched fs edits → recompute + push HMR to every realm holding the file. */
    onFsChange(changes: FsChange[]): void;
};

export function createBundlerHost(fs: Filesystem): BundlerHost {
    const devServer = initDevServer(fs, isExternal);

    // the module-runner request handler (fetchModule / getBuiltins), shared by
    // local + port-connected realms.
    const invoke = async (env: string, payload: unknown): Promise<unknown> => {
        const call = (payload as { data?: { name?: string; data?: unknown[] } }).data;
        if (call?.name === 'fetchModule') {
            const [id, importer, options] = call.data ?? [];
            return fetchModule(devServer, env, id as string, importer as string | undefined, (options as { cached?: boolean }) ?? {});
        }
        if (call?.name === 'getBuiltins') return [];
        return undefined;
    };

    return {
        createLocalRunner(env) {
            let pushToRunner: ((p: unknown) => void) | undefined;
            const bridge: RunnerBridge = {
                invoke: async (payload) => ({ result: await invoke(env, payload) }),
                onMessage: (cb) => {
                    pushToRunner = cb;
                },
                send: (payload) => handleRunnerMessage(devServer, env, payload),
            };
            registerPusher(devServer, env, (p) => pushToRunner?.(p));
            return makeRunner(bridge);
        },

        connectRealm(env, port) {
            registerPusher(devServer, env, (p) => port.postMessage({ __bundler: 'push', payload: p } satisfies BundlerFrame));
            port.onmessage = (e: MessageEvent<BundlerFrame>) => {
                const msg = e.data;
                if (msg.__bundler === 'invoke') {
                    void invoke(env, msg.payload).then((result) =>
                        port.postMessage({ __bundler: 'result', id: msg.id, result } satisfies BundlerFrame),
                    );
                } else if (msg.__bundler === 'send') {
                    handleRunnerMessage(devServer, env, msg.payload);
                }
            };
        },

        onFsChange(changes) {
            for (const c of changes) {
                if (c.type === 'deleted') continue;
                if (!/^src\/.*\.tsx?$/.test(c.path)) continue;
                void applyEdit(devServer, c.path);
            }
        },
    };
}
