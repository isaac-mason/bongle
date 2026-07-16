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

import { applyEdit, fetchModule, handleRunnerMessage, initDevServer, registerPusher } from '../../build';
import type { Filesystem, FsChange } from '../fs';
import { projectUrl } from '../project-url';
import type { BundlerFrame } from './port-bridge';
import { transformModule } from './transform';
import { createBundleWorker } from './worker-bundle';

export type BundlerHost = {
    /** attach a realm reached over a MessagePort (pipeline runner / server worker
     *  / client iframe). The remote side builds its runner with
     *  createPortBridge(port). */
    connectRealm(env: string, port: MessagePort): void;
    /** batched fs edits → recompute + push HMR to every realm holding the file. */
    onFsChange(changes: FsChange[]): void;
};

/** format an unknown throw for the build log. */
function describe(err: unknown): string {
    if (err instanceof Error) return err.stack ?? err.message;
    return String(err);
}

export function createBundlerHost(fs: Filesystem, reportError?: (msg: string) => void): BundlerHost {
    const devServer = initDevServer(fs, {
        transform: transformModule,
        bundleWorker: createBundleWorker(fs),
        // `?url` asset imports → the project-fs SW URL (public/sw.js serves OPFS).
        assetUrl: (path) => projectUrl(path),
    });

    // the module-runner request handler (fetchModule / getBuiltins), shared by
    // local + port-connected realms.
    const invoke = async (env: string, payload: unknown): Promise<unknown> => {
        const call = (payload as { data?: { name?: string; data?: unknown[] } }).data;
        if (call?.name === 'fetchModule') {
            const [id, importer, options] = call.data ?? [];
            return fetchModule(
                devServer,
                env,
                id as string,
                importer as string | undefined,
                (options as { cached?: boolean }) ?? {},
            );
        }
        if (call?.name === 'getBuiltins') return [];
        return undefined;
    };

    return {
        connectRealm(env, port) {
            registerPusher(devServer, env, (p) => port.postMessage({ __bundler: 'push', payload: p } satisfies BundlerFrame));
            port.onmessage = (e: MessageEvent<BundlerFrame>) => {
                const msg = e.data;
                if (msg.__bundler === 'invoke') {
                    void invoke(env, msg.payload).then(
                        (result) => port.postMessage({ __bundler: 'result', id: msg.id, result } satisfies BundlerFrame),
                        (err: unknown) => {
                            // a transform / resolution failure — surface it to the build
                            // window, and hand the realm an error so its load rejects
                            // (rather than hanging) at the import site.
                            reportError?.(describe(err));
                            const error = { message: err instanceof Error ? err.message : String(err) };
                            port.postMessage({ __bundler: 'result', id: msg.id, error } satisfies BundlerFrame);
                        },
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
                void applyEdit(devServer, c.path).catch((err: unknown) => reportError?.(describe(err)));
            }
        },
    };
}
