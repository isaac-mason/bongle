// editor/build/build-worker.ts — runs the prod build OFF the main thread.
//
// @rolldown/browser's threaded wasm calls Atomics.wait, which is illegal on the
// main thread — so the build (like the dev-server) must run in a Worker. Opens
// the same OPFS project by name (same origin), bundles, and returns the zip
// bytes; the main thread does the download / platform hand-off (needs the DOM +
// the platform bridge). Spawned per build + terminated, so its multi-GB wasm
// arena doesn't linger.

import { rolldown } from '@rolldown/browser';
import { type Bundler, buildBundle } from '../../build';
import { ensureProcessShim } from '../dev/runner';
import { openOpfsFilesystem } from '../fs-opfs';

// @rolldown/browser's WASI runtime spawns a nested pool worker and, on a worker
// fault, calls `window.dispatchEvent(new CustomEvent('napi-rs-worker-error'))`.
// `window` is undefined in a Worker, so that fault path throws into the void and
// the bundle promise hangs forever with no error. Shim `window` → the worker
// global (which has dispatchEvent/CustomEvent) so the fault actually surfaces,
// and forward the event so a failed pool worker becomes a build error, not a hang.
const workerGlobal = globalThis as unknown as {
    window?: unknown;
    addEventListener(type: string, cb: (e: Event) => void): void;
};
workerGlobal.window ??= globalThis;

// @rolldown/browser's `rolldown` has the same runtime API as node `rolldown` (the
// type the build core injects), but a nominally-distinct declared type — cast at
// this boundary. This is the one thing that makes the build browser- vs node-run.
const browserBundler: Bundler = { rolldown: rolldown as unknown as Bundler['rolldown'], prepare: ensureProcessShim };

export type BuildRequest = { projectName: string; maxPlayers: number };
export type BuildResponse =
    | { type: 'ready' }
    | { type: 'progress'; label: string }
    | { type: 'done'; zip: Uint8Array }
    | { type: 'error'; message: string };

// `self` types as Window here (no webworker lib) — cast for the worker
// postMessage(message, transfer) overload (mirrors mesh-worker.entry.ts).
const workerSelf = self as unknown as { postMessage: (msg: unknown, transfer?: Transferable[]) => void };

self.onmessage = async (e: MessageEvent<BuildRequest>) => {
    const { projectName, maxPlayers } = e.data;
    const post = (msg: BuildResponse, transfer?: Transferable[]) => workerSelf.postMessage(msg, transfer);
    try {
        post({ type: 'progress', label: 'Opening project' });
        const fs = await openOpfsFilesystem(projectName);
        // a WASI pool-worker fault would otherwise hang the bundle silently — race
        // the build against it so the fault becomes a real, reported error.
        const poolFault = new Promise<never>((_, reject) => {
            workerGlobal.addEventListener('napi-rs-worker-error', (e) => {
                const detail = (e as CustomEvent).detail;
                reject(new Error(`@rolldown/browser WASI pool worker failed: ${JSON.stringify(detail)}`));
            });
        });
        const zip = await Promise.race([
            buildBundle(fs, browserBundler, { maxPlayers, onProgress: (label) => post({ type: 'progress', label }) }),
            poolFault,
        ]);
        post({ type: 'done', zip }, [zip.buffer]);
    } catch (err) {
        console.error('[build-worker] failed', err);
        post({ type: 'error', message: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    }
};

// announce live so the main doc sends the request in RESPONSE — a request posted
// before this worker's (heavy @rolldown) module is live gets lost in vite's dep-
// optimize/reload window (same handshake as bundler-worker.ts).
workerSelf.postMessage({ type: 'ready' } satisfies BuildResponse);
