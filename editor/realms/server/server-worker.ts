// editor/realms/server/server-worker.ts — the SERVER realm, in a web worker.
//
// The engine is vite-bundled (server-env, via worker.plugins) into this worker,
// but the user-code TRANSFORM is NOT here: this realm is a ModuleRunner that
// pulls transformed modules + HMR from the ONE host DevServer over a bundler
// MessagePort (createPortBridge). It evaluates the user code in ITS realm (own
// registry — per-realm eval), boots EngineServer, and owns the 60Hz sim loop
// OFF the main thread. The fs it holds is only for the server's own resource /
// scene reads (loadResource, scene seeding), kept fresh via `fs-change`.
//
// Client iframes connect through MessagePorts the main document brokers: a
// `client-join` message carries a transferred port + synthesized identity;
// the in-tab transport (transport-server.ts) pumps that port's frames.

import { createPortBridge } from '../../../build';
import { createBootTimer } from '../../boot-timing';
import { makeRunner } from '../../dev/runner';
import { exposeDevtools } from '../../devtools';
import type { Filesystem } from '../../fs';
import { openOpfsFilesystem } from '../../fs-opfs';
import { type EditorServer, startEditorServer } from './server';
import { type ClientMeta, createPortTransport, type PortTransport } from './transport-server';

const log = (msg: string) => self.postMessage({ type: 'log', msg });
const bt = createBootTimer('server');

let fs: Filesystem | null = null;
let server: EditorServer | null = null;
let transport: PortTransport | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

type HostMessage =
    | { type: 'init'; projectName: string; localAvatarUrl?: string }
    | { type: 'fs-change'; path: string }
    | { type: 'client-join'; connectionId: number; meta: ClientMeta }
    | { type: 'client-leave'; connectionId: number }
    | { type: 'dispose' };

async function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    transport?.close();
    transport = null;
    // server.stop() flushes dirty rooms AND awaits the OPFS writes landing, so
    // once this resolves disk is current — safe for the host to terminate us and
    // reload a fresh worker from the same project.
    await server?.stop();
    server = null;
}

self.onmessage = async (e: MessageEvent<HostMessage>) => {
    const msg = e.data;
    try {
        if (msg.type === 'init') {
            bt.mark('init received');
            // open the SAME OPFS project the main doc uses (same origin) — the
            // server reads scenes/resources from it directly, no snapshot.
            fs = await openOpfsFilesystem(msg.projectName);
            bt.mark('opfs open');
            // the bundler port rides on e.ports[0]; run the user entry through a
            // ModuleRunner bridged to the host DevServer (host does the
            // transform, this realm evaluates → populates the server registry).
            const bundlerPort = e.ports[0];
            if (!bundlerPort) throw new Error('init without a bundler port');
            const runner = makeRunner(createPortBridge(bundlerPort));
            // runtime env flags before user/engine eval (mirrors the realm boot entry);
            // env.editor gates the server-side EditorTrait attach on join.
            const { env } = await runner.import('bongle/env'); // first bundler fetch
            bt.mark('import bongle/env');
            env.client = false;
            env.server = true;
            env.editor = true;
            await runner.import('src/index.ts'); // full user + engine graph
            // the bake's generated barrel patches model/… handles with their
            // baked bin paths (mirrors the realm importing src/generated). Empty
            // until the first bake; HMR re-imports it when the pipeline writes it.
            await runner.import('src/generated/models.ts');
            // the engine the server drives comes from the SAME runner instance
            // (the one the user code registered into), NOT a native import.
            // engine-server wraps its api under `export * as EngineServer`.
            const { EngineServer } = await runner.import('bongle/engine-server');
            const { __bongle } = await runner.import('bongle/internal');
            bt.mark('import graph + engine barrels');

            server = await startEditorServer({ fs, log, EngineServer, __bongle, localAvatarUrl: msg.localAvatarUrl });
            bt.mark('startEditorServer');
            __bongle.flush(); // initial registry apply.

            // DevTools automation surface for the server realm: `bongle` in the
            // worker's console context (fs + the live EngineServer state / api).
            exposeDevtools('server', { fs, server: EngineServer, state: server.state, app: server.app, bongle: __bongle });

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

            bt.mark('sim loop started');
            bt.summary();
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
        } else if (msg.type === 'fs-change') {
            // OPFS is shared, so the change is already visible here — the server
            // re-reads scenes/resources on demand (source edits HMR via the
            // bundler port). Nothing to write. (Scene live-reapply: later.)
            // Except the edited avatar: a Blockbench save rewrites avatar.glb, so
            // live-swap it onto the local player (fresh model id → rig re-mounts).
            if (msg.path === 'avatar.glb') server?.reloadAvatar();
        } else if (msg.type === 'dispose') {
            // graceful: flush + drain to OPFS, THEN ack so the host waits for the
            // save to land before terminating us (a restart reloads from disk).
            await stop();
            self.postMessage({ type: 'disposed' });
        }
    } catch (err) {
        log(`worker error: ${(err as Error).message}`);
        // biome-ignore lint/suspicious/noConsole: worker-side diagnostics.
        console.error(err);
    }
};

// handshake (mirrors bundler-worker): announce we're live so the host posts init
// (with the transferred bundler port) only now — a blind init at spawn is dropped
// in vite's dep-optimize/reload window (this module may finish eval after it).
self.postMessage({ type: 'worker-ready' });
