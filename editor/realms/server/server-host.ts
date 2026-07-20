// editor/realms/server/server-host.ts — main-thread handle to the server worker.
//
// Spawns server-worker.ts, tells it which OPFS project to open (shared,
// same origin — no fs snapshot), relays its log stream, and brokers client
// connections: joinClient transfers a MessagePort (the other end goes to a
// client iframe) so the worker's transport pumps that client. The main document
// owns connection identity (connectionId); the worker maps it to an engine
// `Client`.

import type { ClientMeta } from './transport-server';

export type ServerHost = {
    /** resolves once the worker has booted the sim (post-`ready`). Join calls
     *  before this are safe — they queue on the worker's message port. */
    ready: Promise<void>;
    joinClient(connectionId: number, port: MessagePort, meta: ClientMeta): void;
    leaveClient(connectionId: number): void;
    /** signal a changed path — the worker re-reads the shared OPFS (no bytes). */
    relayFsChange(path: string): void;
    /** graceful teardown: ask the worker to flush + drain its saves to OPFS,
     *  wait for its `disposed` ack (or a timeout), THEN terminate it. Awaiting
     *  this before respawning guarantees the fresh worker reads current bytes. */
    dispose(): Promise<void>;
};

/** cap on how long we wait for the worker's `disposed` ack before terminating
 *  anyway — a hung/crashed worker must not wedge a restart. Saves are small and
 *  incremental, so a clean flush lands in well under this. */
const DISPOSE_ACK_TIMEOUT_MS = 5000;

export type SpawnServerWorkerOptions = {
    /** connect the worker's bundler conduit to the bundler worker (env 'server');
     *  transfers the port. Its user-code transform + HMR flow over it. */
    connectRealm: (env: string, port: MessagePort) => void;
    /** OPFS project the worker opens directly (same origin as the main doc). */
    projectName: string;
    log?: (msg: string) => void;
    /** a specific avatar for the local player (platform intent) — see startEditorServer. */
    localAvatarUrl?: string;
};

export function spawnServerWorker(opts: SpawnServerWorkerOptions): ServerHost {
    const { connectRealm, projectName, log = () => {}, localAvatarUrl } = opts;

    const worker = new Worker(new URL('./server-worker.ts', import.meta.url), { type: 'module' });

    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => {
        resolveReady = r;
    });

    let resolveDisposed!: () => void;
    const disposed = new Promise<void>((r) => {
        resolveDisposed = r;
    });

    worker.onmessage = (e: MessageEvent) => {
        const msg = e.data as { type: string; msg?: string };
        if (msg.type === 'worker-ready') {
            // worker is live — NOW wire the bundler conduit + post init (transferred
            // port). A blind init at spawn is dropped in vite's dep-optimize window.
            console.log('[boot] server: worker-ready → connecting bundler conduit + posting init');
            const bundler = new MessageChannel();
            connectRealm('server', bundler.port1);
            worker.postMessage({ type: 'init', projectName, localAvatarUrl }, [bundler.port2]);
        } else if (msg.type === 'log') log(msg.msg ?? '');
        else if (msg.type === 'ready') {
            console.log('[boot] server: worker reported ready');
            resolveReady();
        } else if (msg.type === 'disposed') {
            // the worker finished flushing + draining its saves to OPFS.
            resolveDisposed();
        }
    };
    worker.onerror = (e) => log(`worker crashed: ${e.message}`);
    console.log('[boot] server: worker spawned, awaiting worker-ready');

    return {
        ready,
        joinClient(connectionId, port, meta) {
            worker.postMessage({ type: 'client-join', connectionId, meta }, [port]);
        },
        leaveClient(connectionId) {
            worker.postMessage({ type: 'client-leave', connectionId });
        },
        relayFsChange(path) {
            worker.postMessage({ type: 'fs-change', path });
        },
        async dispose() {
            worker.postMessage({ type: 'dispose' });
            // wait for the worker's flush+drain ack so saved bytes land before we
            // kill it; a timeout guards against a hung/crashed worker wedging us.
            const timeout = new Promise<void>((r) => setTimeout(r, DISPOSE_ACK_TIMEOUT_MS));
            await Promise.race([disposed, timeout]);
            worker.terminate();
        },
    };
}
