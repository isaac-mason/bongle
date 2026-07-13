// editor/client/client-main.ts — the CLIENT realm, one per <iframe> window.
//
// A separate origin + document from the main editor (see client/vite.config.ts
// for why). It's env.client here: vite compiles the engine client-env, so the
// GPU/DOM render path survives and the node-only server code is stripped.
//
// Boot handshake (parent = the main editor document):
//   1. post `client-ready` to the parent so it knows to send us a session.
//   2. receive `client-init` { files, entry } + a transferred MessagePort — the
//      frame pipe to the server worker (brokered by the parent).
//   3. rebuild a memory fs from the files, run the client bundler over the user
//      code (populating THIS realm's registry), boot EngineClient in edit mode,
//      mount the in-world edit UI, and pump the port <-> engine net each frame.
//
// Source + baked-resource edits arrive as `fs-change` messages; the bundler's
// watcher HMRs source, and resource writes trigger the matching engine refresh.

import type { ClientDriver } from '../../interface/index';
import * as EngineClient from '../../src/client/engine-client';
import * as EngineEditor from '../../src/engine-editor';
import * as bongle from '../../src/index';
import * as bongleInternal from '../../src/internal';
import * as bongleStarter from '../../src/starter/index';
import { startBundler } from '../bundler/bundler';
import type { Externals } from '../bundler/runner';
import { createMemoryFilesystem, type Filesystem } from '../fs';

const { __kit } = bongleInternal;
const externals: Externals = new Map<string, unknown>([
    ['bongle', bongle],
    ['bongle/internal', bongleInternal],
    ['bongle/starter', bongleStarter],
]);

// no host portal in the editor: matchmake is a no-op, platform verbs inert.
const driver: ClientDriver = {
    matchmake() {},
    platform: { commercialBreak: async () => {}, rewardedBreak: async () => false },
};

type InitMessage = { type: 'client-init'; files: Record<string, Uint8Array>; entry?: string };
type FsChangeMessage = { type: 'fs-change'; path: string; bytes: Uint8Array };

let booted = false;

/** Load bytes from the project fs. Baked client resources live under
 *  resources/client/<rel> (mirrors the deployed bundle layout); runtime-source
 *  avatar urls are absolute http(s) and fetched verbatim. No decodeImage — the
 *  client uses the DOM image path. */
function clientResourceLoader(fs: Filesystem) {
    return {
        loadBytes: async (url: string): Promise<Uint8Array> => {
            if (url.startsWith('http:') || url.startsWith('https:')) {
                const r = await fetch(url);
                if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
                return new Uint8Array(await r.arrayBuffer());
            }
            return fs.read(`resources/client/${url.replace(/^\//, '')}`);
        },
    };
}

async function boot(msg: InitMessage, port: MessagePort): Promise<void> {
    const fs = createMemoryFilesystem(msg.files);

    // evaluate the user code in this realm — populates the client registry
    // (blocks/models/client scripts) the renderer reads.
    await startBundler({ fs, externals, entry: msg.entry ?? 'src/index.ts' });

    const state = EngineClient.init({
        mode: 'edit',
        driver,
        resourceLoader: clientResourceLoader(fs),
        domElement: document.body,
    });

    // registers the EditorScript + commands and mounts the in-world edit UI —
    // must run before load()'s clearPendingChanges sweep.
    await EngineEditor.setup(state);
    await EngineClient.load(state);

    __kit.registerFlush(() => EngineClient.applyRegistryChanges(state));
    __kit.flush();

    // transport: inbound frames from the server worker → engine inbox.
    port.onmessage = (e: MessageEvent) => {
        const data = e.data;
        state.net.inbox.push(data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array));
    };

    // frame loop: advance, then drain the outbox onto the port.
    let last = performance.now();
    const frame = (now: number) => {
        const dt = (now - last) / 1000;
        last = now;
        EngineClient.update(state, dt);
        for (const bytes of state.net.outbox) port.postMessage(bytes);
        state.net.outbox.length = 0;
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    // incremental fs updates from the parent: HMR source, refresh baked assets.
    self.addEventListener('message', (e: MessageEvent) => {
        const m = e.data as FsChangeMessage;
        if (m?.type !== 'fs-change') return;
        void fs.write(m.path, m.bytes).then(() => {
            if (!m.path.startsWith('resources/client/')) return;
            // a baked-asset write carries no registry change, so the flush
            // path won't propagate it — refresh the matching resource directly.
            if (m.path.includes('sprite')) EngineClient.refreshSpriteResources(state).catch(console.error);
            else if (m.path.includes('audio')) EngineClient.refreshAudioResources(state).catch(console.error);
            else EngineClient.refreshBlockResources(state).catch(console.error);
        });
    });
}

self.addEventListener('message', (e: MessageEvent) => {
    const msg = e.data as InitMessage;
    if (msg?.type !== 'client-init' || booted) return;
    booted = true;
    const port = e.ports[0];
    if (!port) throw new Error('client-init without a transferred port');
    void boot(msg, port).catch((err) => {
        // surface boot failures to the parent for the client window's log.
        window.parent.postMessage({ type: 'client-error', message: (err as Error).message }, '*');
        console.error(err);
    });
});

// tell the parent we're ready to receive a session.
window.parent.postMessage({ type: 'client-ready' }, '*');
