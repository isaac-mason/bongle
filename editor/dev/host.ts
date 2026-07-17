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

import { applyEdit, attachRealm, type BundlerFrame, describeError, initDevServer } from '../../build';
import type { Filesystem, FsChange } from '../fs';
import { projectUrl } from '../project-url';
import { depParser, transformModule } from './transform';
import { createBundleWorker } from './worker-bundle';

export type BundlerHost = {
    /** attach a realm reached over a MessagePort (pipeline runner / server worker
     *  / client iframe). The remote side builds its runner with
     *  createPortBridge(port). */
    connectRealm(env: string, port: MessagePort): void;
    /** batched fs edits → recompute + push HMR to every realm holding the file. */
    onFsChange(changes: FsChange[]): void;
};

export function createBundlerHost(fs: Filesystem, reportError?: (msg: string) => void): BundlerHost {
    const devServer = initDevServer(fs, {
        transform: transformModule,
        parse: depParser,
        bundleWorker: createBundleWorker(fs),
        // NO bundleDep: the editor's deps are seeded as ESM (build-deps prebundles
        // the CJS ones), so nothing needs on-demand CJS→ESM bundling — and calling
        // @rolldown/browser for it from THIS worker (which already runs it for the
        // transform) would deadlock on Atomics.wait. On-demand bundleDep is a node-
        // CLI concern (raw pnpm node_modules); see cli/dev + build/dev bundleDep.
        // `?url` asset imports → the project-fs SW URL (public/sw.js serves OPFS).
        assetUrl: (path) => projectUrl(path),
    });

    return {
        // the realm-protocol logic lives in lib/build (attachRealm); this only wires
        // it to the browser transport (a MessagePort per remote realm).
        connectRealm(env, port) {
            const { handleFrame } = attachRealm(devServer, env, {
                post: (frame) => port.postMessage(frame),
                reportError,
            });
            port.onmessage = (e: MessageEvent<BundlerFrame>) => handleFrame(e.data);
        },

        onFsChange(changes) {
            for (const c of changes) {
                if (c.type === 'deleted') continue;
                if (!/^src\/.*\.tsx?$/.test(c.path)) continue;
                void applyEdit(devServer, c.path).catch((err: unknown) => reportError?.(describeError(err)));
            }
        },
    };
}
