// editor/dev/bundler-manager.ts — a stable handle to the bundler (dev-server)
// worker that can be KILLED and RESPAWNED under its consumers.
//
// The bundler is the ROOT of the module graph: every realm (pipeline, server,
// each client iframe) pulls its transformed modules + HMR over a MessagePort
// this worker brokers. So its `connectRealm` is captured by value at boot by the
// pipeline/server hosts and the client connector. Handing them a new function on
// restart would strand them on the dead worker — so, like server-manager, this
// wraps the worker in a facade whose identity never changes: `connectRealm` /
// `relayFsChange` delegate to the CURRENT worker, and `restart()` swaps it out.
//
// A bundler restart alone leaves every downstream realm bridged to a dead worker,
// so the realm-stack orchestration (stores/build.ts restartAll) restarts the
// pipeline + server + clients AFTER this, each re-handshaking a fresh conduit to
// the new worker.

/** the bundler's handshake: `worker-ready` → post init → `host-ready` (accept
 *  realm connections). `connectRealm` queues ports until host-ready, then flushes
 *  them — a connect posted into vite's dep-optimize/reload window is dropped. */
type BundlerWorkerHandle = {
    ready: Promise<void>;
    connectRealm(env: string, port: MessagePort): void;
    relayFsChange(changes: unknown[]): void;
    dispose(): void;
};

function spawnBundlerWorker(projectName: string, log: (msg: string) => void): BundlerWorkerHandle {
    const worker = new Worker(new URL('./bundler-worker.ts', import.meta.url), { type: 'module' });

    let hostReady = false;
    const pendingConnects: Array<{ env: string; port: MessagePort }> = [];

    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    // restartAll awaits `ready` lazily, so a rejection could land unobserved —
    // sink it to avoid an unhandledrejection.
    ready.catch(() => {});

    worker.onerror = (e) => {
        console.error('[bundler-worker] load error', e.message);
        log(`[bundler] worker crashed: ${e.message} — restart the compiler.`);
        rejectReady(new Error(e.message));
    };
    worker.onmessage = (e: MessageEvent) => {
        const d = e.data as { __buildlog?: string; type?: string; message?: string };
        if (d?.type === 'worker-ready') {
            // the ~10MB @rolldown WASM compile starts on init and is the dominant boot
            // cost — log it as in-progress so the terminal isn't silent during the wait.
            log('starting code compiler…');
            worker.postMessage({ type: 'init', projectName });
        } else if (d?.type === 'host-ready') {
            log('code compiler ready');
            hostReady = true;
            for (const { env, port } of pendingConnects) worker.postMessage({ type: 'connect-realm', env }, [port]);
            pendingConnects.length = 0;
            resolveReady();
        } else if (d?.type === 'boot-error') {
            rejectReady(new Error(d.message ?? 'bundler boot failed'));
        } else if (d?.__buildlog) {
            log(d.__buildlog);
        }
    };

    return {
        ready,
        connectRealm(env, port) {
            if (hostReady) worker.postMessage({ type: 'connect-realm', env }, [port]);
            else pendingConnects.push({ env, port });
        },
        relayFsChange(changes) {
            worker.postMessage({ type: 'fs-change', changes });
        },
        dispose() {
            worker.terminate();
        },
    };
}

export type BundlerManager = {
    /** resolves once the CURRENT worker is host-ready (a getter, so it re-reads
     *  after a restart). Rejects if the worker's boot fails. */
    readonly ready: Promise<void>;
    /** wire a realm's bundler conduit to the current worker (transfers the port);
     *  queues until host-ready. Stable across restarts. */
    connectRealm(env: string, port: MessagePort): void;
    /** signal changed paths to the current worker (re-transform + HMR). */
    relayFsChange(changes: unknown[]): void;
    /** kill the current worker + respawn it, and await the fresh worker's `ready`.
     *  Every downstream realm must re-`connectRealm` afterwards (their conduits
     *  died with the old worker) — the stack orchestration handles that. */
    restart(): Promise<void>;
    /** terminate the current worker (no respawn). */
    dispose(): void;
};

export function createBundlerManager(projectName: string, log: (msg: string) => void): BundlerManager {
    let active = spawnBundlerWorker(projectName, log);
    return {
        get ready() {
            return active.ready;
        },
        connectRealm: (env, port) => active.connectRealm(env, port),
        relayFsChange: (changes) => active.relayFsChange(changes),
        async restart() {
            active.dispose();
            active = spawnBundlerWorker(projectName, log);
            await active.ready;
        },
        dispose: () => active.dispose(),
    };
}
