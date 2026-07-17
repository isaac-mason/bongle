// editor/bundler-worker.ts — the ONE dev server, off the main thread.
//
// @rolldown/browser's WASM transform (TS-strip + module-runner rewrite) has a
// linear-memory arena that only grows — under load it reaches multiple GB, so
// running it here keeps that off the UI thread. Realms (the pipeline runner in
// the main doc, the server worker, the client iframes) connect over transferred
// MessagePorts; this worker owns the single DevServer + transform cache, they
// only evaluate.
//
// It opens the SAME OPFS project (same origin) to read source. The seed writes
// complete in the main doc before this worker is asked to serve anything.

import { createBootTimer } from '../boot-timing';
import type { FsChange } from '../fs';
import { openOpfsFilesystem } from '../fs-opfs';
import { type BundlerHost, createBundlerHost } from './host';

const bt = createBootTimer('bundler');

type InitMsg = { type: 'init'; projectName: string };
type ConnectMsg = { type: 'connect-realm'; env: string };
type FsChangeMsg = { type: 'fs-change'; changes: FsChange[] };

let host: BundlerHost | undefined;
let resolveReady!: () => void;
const ready = new Promise<void>((r) => {
    resolveReady = r;
});

self.addEventListener('message', async (e: MessageEvent) => {
    const msg = e.data as InitMsg | ConnectMsg | FsChangeMsg;
    if (msg.type === 'init') {
        bt.mark('init received');
        const fs = await openOpfsFilesystem(msg.projectName);
        bt.mark('opfs open');
        // build errors surface to the main doc's build log window.
        host = createBundlerHost(fs, (buildlog) => self.postMessage({ __buildlog: buildlog }));
        bt.mark('host created');
        resolveReady();
        // now safe to accept realm connections — the main doc flushes its queued
        // connect-realm ports on this.
        self.postMessage({ type: 'host-ready' });
    } else if (msg.type === 'connect-realm') {
        console.log(`[boot] bundler-worker: connect-realm ${msg.env}`);
        await ready;
        // e.ports[0] = this realm's bundler conduit (its ModuleRunner ↔ us).
        host?.connectRealm(msg.env, e.ports[0]);
    } else if (msg.type === 'fs-change') {
        await ready;
        host?.onFsChange(msg.changes);
    }
});

// announce once this (heavy @rolldown) module is live — the main doc posts init
// in response. Buffering a postMessage across vite's dep-optimize/reload window
// is unreliable, so we handshake rather than fire init blindly at spawn time.
console.log('[boot] bundler-worker: module eval complete, posting worker-ready');
self.postMessage({ type: 'worker-ready' });
