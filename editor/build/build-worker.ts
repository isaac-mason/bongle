// editor/build/build-worker.ts — runs the prod build OFF the main thread.
//
// @rolldown/browser's threaded wasm calls Atomics.wait, which is illegal on the
// main thread — so the build (like the dev-server) must run in a Worker. Opens
// the same OPFS project by name (same origin), bundles, and returns the zip
// bytes; the main thread does the download / platform hand-off (needs the DOM +
// the platform bridge). Spawned per build + terminated, so its multi-GB wasm
// arena doesn't linger.

import { openOpfsFilesystem } from '../fs-opfs';
import { buildBundle } from './build';

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
        const zip = await buildBundle(fs, { maxPlayers, onProgress: (label) => post({ type: 'progress', label }) });
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
