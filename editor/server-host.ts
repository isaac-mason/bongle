// editor/server-host.ts — main-thread handle to the server worker.
//
// Spawns editor/server-worker.ts, ships it the initial project fs, relays its
// log stream, and brokers client connections: joinClient transfers a
// MessagePort (the other end goes to a client iframe) so the worker's transport
// pumps that client. The main document owns connection identity (connectionId);
// the worker maps it to an engine `Client`.

import type { BundlerHost } from './bundler/host';
import type { Filesystem } from './fs';
import { snapshotFiles } from './session-files';
import type { ClientMeta } from './transport-server';

export type ServerHost = {
    /** resolves once the worker has booted the sim (post-`ready`). Join calls
     *  before this are safe — they queue on the worker's message port. */
    ready: Promise<void>;
    joinClient(connectionId: number, port: MessagePort, meta: ClientMeta): void;
    leaveClient(connectionId: number): void;
    relayFsChange(path: string, bytes: Uint8Array): void;
    dispose(): void;
};

export type SpawnServerWorkerOptions = {
    fs: Filesystem;
    /** the shared dev server — the worker's user-code transform + HMR come from
     *  here over a dedicated bundler port (env 'server'). */
    host: BundlerHost;
    log?: (msg: string) => void;
};

export function spawnServerWorker(opts: SpawnServerWorkerOptions): ServerHost {
    const { fs, host, log = () => {} } = opts;

    const worker = new Worker(new URL('./server-worker.ts', import.meta.url), { type: 'module' });

    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => {
        resolveReady = r;
    });

    worker.onmessage = (e: MessageEvent) => {
        const msg = e.data as { type: string; msg?: string };
        if (msg.type === 'log') log(msg.msg ?? '');
        else if (msg.type === 'ready') resolveReady();
    };
    worker.onerror = (e) => log(`worker crashed: ${e.message}`);

    // dedicated bundler conduit: the worker's ModuleRunner ↔ the host DevServer
    // (env 'server'). Its port rides on the init message's transfer list.
    const bundler = new MessageChannel();
    host.connectRealm('server', bundler.port1);

    void (async () => {
        const files = await snapshotFiles(fs);
        worker.postMessage({ type: 'init', files }, [bundler.port2]);
    })();

    return {
        ready,
        joinClient(connectionId, port, meta) {
            worker.postMessage({ type: 'client-join', connectionId, meta }, [port]);
        },
        leaveClient(connectionId) {
            worker.postMessage({ type: 'client-leave', connectionId });
        },
        relayFsChange(path, bytes) {
            worker.postMessage({ type: 'fs-change', path, bytes });
        },
        dispose() {
            worker.postMessage({ type: 'dispose' });
            worker.terminate();
        },
    };
}
