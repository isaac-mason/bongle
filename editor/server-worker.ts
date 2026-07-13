// editor/server-worker.ts — the SERVER realm, in a web worker.
//
// Self-contained: vite bundles the engine (server-env, via worker.plugins) +
// the bundler + startEditorServer into this worker. It gets a snapshot of the
// project fs from the host at init, evaluates the user code in ITS realm (own
// registry — per-realm eval, the multiplayer-design contract), boots
// EngineServer, and owns the 60Hz sim loop OFF the main thread.
//
// Client iframes connect through MessagePorts the main document brokers: a
// `client-join` message carries a transferred port + synthesized identity;
// the in-tab transport (transport-server.ts) pumps that port's frames. Source
// edits arrive as `fs-change` messages → the bundler's watcher HMRs them.

import * as bongle from '../src/index';
import * as bongleInternal from '../src/internal';
import * as bongleStarter from '../src/starter/index';
import { startBundler } from './bundler/bundler';
import type { Externals } from './bundler/runner';
import { createMemoryFilesystem, type Filesystem } from './fs';
import { type EditorServer, startEditorServer } from './server';
import { type ClientMeta, createPortTransport, type PortTransport } from './transport-server';

const { __kit } = bongleInternal;
const externals: Externals = new Map<string, unknown>([
    ['bongle', bongle],
    ['bongle/internal', bongleInternal],
    ['bongle/starter', bongleStarter],
]);

const log = (msg: string) => self.postMessage({ type: 'log', msg });

let fs: Filesystem | null = null;
let server: EditorServer | null = null;
let transport: PortTransport | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

type HostMessage =
    | { type: 'init'; files: Record<string, Uint8Array> }
    | { type: 'fs-change'; path: string; bytes: Uint8Array }
    | { type: 'client-join'; connectionId: number; meta: ClientMeta }
    | { type: 'client-leave'; connectionId: number }
    | { type: 'dispose' };

function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    transport?.close();
    transport = null;
    server?.stop();
    server = null;
}

self.onmessage = async (e: MessageEvent<HostMessage>) => {
    const msg = e.data;
    try {
        if (msg.type === 'init') {
            fs = createMemoryFilesystem(msg.files);
            await startBundler({ fs, externals, entry: 'src/index.ts' });
            server = await startEditorServer({ fs, log });
            __kit.flush(); // initial registry apply.

            transport = createPortTransport(server.app, server.state, server.resolveAvatar);

            // 60Hz: advance the sim, then flush per-client outboxes to their
            // ports. Owned here (not in server.ts) so timing + transport stay
            // together, matching game-room's frame loop.
            let last = performance.now();
            timer = setInterval(() => {
                const now = performance.now();
                const dt = (now - last) / 1000;
                last = now;
                try {
                    server?.app.update(server.state, dt);
                    transport?.flush();
                } catch (err) {
                    log(`tick error: ${(err as Error).message}`);
                }
            }, 1000 / 60);

            self.postMessage({ type: 'ready' });
        } else if (msg.type === 'client-join') {
            // the transferred port rides on e.ports[0].
            const port = e.ports[0];
            if (!port) throw new Error('client-join without a transferred port');
            transport?.acceptClient(msg.connectionId, port, msg.meta);
            log(`client ${msg.connectionId} joined`);
        } else if (msg.type === 'client-leave') {
            transport?.leaveClient(msg.connectionId);
            log(`client ${msg.connectionId} left`);
        } else if (msg.type === 'fs-change' && fs) {
            // host wrote a file (source edit or a synced baked output) → the
            // bundler's fs watcher picks source changes up and HMRs.
            await fs.write(msg.path, msg.bytes);
        } else if (msg.type === 'dispose') {
            stop();
        }
    } catch (err) {
        log(`worker error: ${(err as Error).message}`);
        // biome-ignore lint/suspicious/noConsole: worker-side diagnostics.
        console.error(err);
    }
};
