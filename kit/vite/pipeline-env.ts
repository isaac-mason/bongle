/**
 * kit/vite/pipeline-env.ts — the `pipeline` environment: a Vite DevEnvironment
 * whose ModuleRunner runs in a Node worker_thread.
 *
 * Why a worker: the asset pipeline boots a Dawn (WebGPU) device whose background
 * ProcessEvents pump allocates every event-loop turn for the device's lifetime.
 * In-process that churn lands on the editor's heap and forces ~700ms mark-compact
 * hitches. A worker_thread is its own V8 isolate — own heap, own GC, own event
 * loop — so the pump and its churn are quarantined; the editor tick never sees it.
 *
 * The bridge (the documented Environment-API worker recipe):
 *   • main → worker  : `worker.postMessage(hotPayload)` (this channel's `send`)
 *   • worker → main  : `worker.on('message', …)` dispatched to the `on(event)`
 *                      listeners, which transparently routes Vite's `vite:invoke`
 *                      (fetchModule) and HMR custom events.
 *   • A SEPARATE `MessagePort` (workerData.control) carries app-level control
 *     (boot / run triggers / results) so it never collides with Vite's protocol.
 *
 * This module owns only the transport + worker lifecycle and exposes a handle.
 * Forwarding results to the browser + the editor-load gate live in the
 * `bongle:pipeline` plugin (it has `server`); the boot trigger fires from
 * `dev/start.ts` after `server.listen()` so the env is initialized first.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageChannel, type MessagePort, Worker } from 'node:worker_threads';
import { DevEnvironment, type HotChannel, type HotChannelClient, type HotPayload, type ResolvedConfig } from 'vite';
import type { PipelineWorkerInbound, PipelineWorkerOutbound } from '../runtime/pipeline-host';

// bongle package root, derived from this file (`<root>/kit/vite/pipeline-env.ts`).
const BONGLE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKER_PATH = path.join(BONGLE_ROOT, 'kit', 'runtime', 'pipeline-worker.mjs');
const BOOT_ID = 'virtual:bongle/pipeline-host';

// Settle the first-run gate after this long even if the worker never reports —
// a wedged first pass must not hang the CLI banner or the editor's ready poll.
const FIRST_RUN_TIMEOUT_MS = 60_000;

// If the worker doesn't exit on its own this long after a shutdown request,
// hard-terminate it — a wedged worker must not hang the CLI's exit. Generous
// enough for the host to drain an in-flight render pass first (draining avoids a
// Dawn FATAL on a pending mapAsync); it exits as soon as the pass settles, so
// this only bites a genuinely wedged pass.
const SHUTDOWN_TIMEOUT_MS = 15_000;

export type PipelineWorkerHandle = {
    worker: Worker;
    /** Resolves once the worker's first pipeline pass has settled (`warm`) or
     *  faulted/timed out (`gate`/timeout). One-shot, never rejects — a wedged
     *  first run must not hang startup. The CLI awaits this for its banner. */
    firstRun: Promise<void>;
    /** Has the first pass settled? Drives the `/__bongle/ready` editor gate. */
    readonly ready: boolean;
    /** Status label while the first pass is in flight; null once settled. */
    readonly status: string | null;
    /** Send the explicit boot signal (after `server.listen()`). */
    sendBoot(): void;
    /** Force a pipeline pass (asset/scene file change relayed from main). */
    triggerRun(forceAll: boolean): void;
    /** Respawn the worker on an engine-source change: clean-shutdown the current
     *  worker (its Dawn instance dies with the isolate — no GC segfault, no
     *  clearCache) and boot a fresh one that fetches the new engine code. */
    reboot(): Promise<void>;
    /** Subscribe to control messages the worker posts back. `result` is the
     *  browser-forwarding signal; lifecycle (`warm`/`gate`/`error`) is handled
     *  internally and drives the first-run gate. */
    onControl(cb: (msg: PipelineWorkerOutbound) => void): void;
    /** Ask the worker to exit cleanly (it self-`process.exit`s from a clean JS
     *  stack so Dawn's pump can't napi-FATAL on teardown) and resolve once it
     *  has, or after a hard-terminate fallback. Idempotent. */
    close(): Promise<void>;
};

// Module-level singleton: createEnvironment runs during createServer, the
// plugin + start.ts reach the handle afterwards. One pipeline env per process.
let handle: PipelineWorkerHandle | null = null;

export function getPipelineWorkerHandle(): PipelineWorkerHandle | null {
    return handle;
}

export type CreatePipelineEnvironmentDeps = {
    projectDir: string;
    bongleDir: string;
};

export function createPipelineEnvironment(
    name: string,
    config: ResolvedConfig,
    deps: CreatePipelineEnvironmentDeps,
): DevEnvironment {
    // Worker V8 flags. Default to `[]` (NOT inheriting the parent's execArgv)
    // so the worker never echoes the main process's `--trace-gc` — that keeps a
    // main-thread GC trace clean, which is the whole point of moving the Dawn
    // churn here. Opt in to tracing the WORKER's own heap with
    // BONGLE_PIPELINE_GC_TRACE=1 (it's the isolate where the churn now lives).
    // BONGLE_PIPELINE_SEMI_SPACE_MB tunes the worker's nursery so medium-lived
    // garbage dies young and even the worker avoids a big mark-compact.
    const workerExecArgv: string[] = [];
    if (process.env.BONGLE_PIPELINE_GC_TRACE) workerExecArgv.push('--trace-gc');
    const semiSpaceMb = process.env.BONGLE_PIPELINE_SEMI_SPACE_MB;
    if (semiSpaceMb) workerExecArgv.push(`--max-semi-space-size=${semiSpaceMb}`);

    // ── Vite transport (HotChannel) bridging to the CURRENT worker via postMessage ──
    // Env-durable state survives a worker respawn: the `worker`/`controlPort`
    // refs swap, but the DevEnvironment (and its transport + listeners + gate)
    // are created once. `spawnWorker()` re-applies these listeners to each new
    // worker so Vite's fetchModule/HMR keep flowing after a reboot.
    type ChannelListener = (data: unknown, client: HotChannelClient) => void;
    // message listeners keyed by the Vite-supplied handler (must survive respawn).
    const hotListeners = new Map<ChannelListener, (value: HotPayload) => void>();
    // vite:client:disconnect handlers (fire on worker exit) — detached before a
    // reboot's shutdown so the old worker's exit isn't read as a real disconnect.
    const disconnectListeners = new Map<ChannelListener, () => void>();

    let worker!: Worker;
    let controlPort!: MessagePort;

    const client: HotChannelClient = { send: (payload) => worker.postMessage(payload) };

    function spawnWorker(): void {
        const { port1, port2 } = new MessageChannel();
        controlPort = port1;
        worker = new Worker(WORKER_PATH, {
            workerData: {
                control: port2,
                bootId: BOOT_ID,
                projectDir: deps.projectDir,
                bongleDir: deps.bongleDir,
            },
            transferList: [port2],
            execArgv: workerExecArgv,
        });
        worker.on('error', (err) => console.error('[bongle:pipeline] worker error:', err));
        // re-attach the HotChannel + control wiring to the fresh worker.
        for (const listener of hotListeners.values()) worker.on('message', listener);
        for (const listener of disconnectListeners.values()) worker.on('exit', listener);
        controlPort.on('message', (msg: PipelineWorkerOutbound) => {
            switch (msg.type) {
                case 'warm':
                    settleFirstRun({ ms: msg.ms, timings: msg.timings });
                    break;
                case 'gate':
                    settleFirstRun();
                    break;
                case 'error':
                    console.error('[bongle:pipeline] worker:', msg.error);
                    break;
            }
            for (const cb of controlListeners) cb(msg);
        });
    }

    const workerHotChannel = {
        // worker_thread messages aren't network-exposed → skip the fs access check.
        skipFsCheck: true,
        send: (payload: HotPayload) => {
            worker.postMessage(payload);
        },
        on: (event: string, fn: ChannelListener) => {
            // the worker runner is always connected; ignore the connect event.
            if (event === 'vite:client:connect') return;
            if (event === 'vite:client:disconnect') {
                const listener = () => fn(undefined, client);
                disconnectListeners.set(fn, listener);
                worker.on('exit', listener);
                return;
            }
            const listener = (value: HotPayload) => {
                if (value?.type === 'custom' && value.event === event) fn(value.data, client);
            };
            hotListeners.set(fn, listener);
            worker.on('message', listener);
        },
        off: (event: string, fn: ChannelListener) => {
            if (event === 'vite:client:disconnect') {
                const listener = disconnectListeners.get(fn);
                if (listener) worker.off('exit', listener);
                disconnectListeners.delete(fn);
                return;
            }
            const listener = hotListeners.get(fn);
            if (listener) worker.off('message', listener);
            hotListeners.delete(fn);
        },
    };

    // shut down a worker cleanly (self-exit from a clean JS stack so Dawn's pump
    // can't napi-FATAL), hard-terminating only if it wedges past the timeout.
    const shutdownWorker = (w: Worker, p: MessagePort): Promise<void> =>
        new Promise((resolve) => {
            let killTimer: ReturnType<typeof setTimeout>;
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(killTimer);
                try {
                    p.close();
                } catch {
                    // already closed
                }
                resolve();
            };
            w.once('exit', finish);
            try {
                const msg: PipelineWorkerInbound = { type: 'shutdown' };
                p.postMessage(msg);
            } catch {
                void w.terminate(); // port already gone — fall straight to terminate.
            }
            killTimer = setTimeout(() => void w.terminate(), SHUTDOWN_TIMEOUT_MS);
        });

    // ── first-pipeline-run gate (declared before spawnWorker, whose control
    // handler settles it) ──
    // The worker reports its first settled pass via 'warm' (success, with
    // timings) or 'gate' (fault/empty). Resolve `firstRun` exactly once on
    // either — or on the timeout guard — so a wedged first pass can't hang the
    // CLI banner or the editor's /__bongle/ready poll. Never rejects. A reboot's
    // passes report 'warm'/'gate' too, but settleFirstRun is idempotent so they
    // never re-gate.
    let firstRunSettled = false;
    let firstRunStatus: string | null = 'Starting…';
    let resolveFirstRun!: () => void;
    const firstRun = new Promise<void>((resolve) => {
        resolveFirstRun = resolve;
    });
    let firstRunTimer: ReturnType<typeof setTimeout>;
    const settleFirstRun = (warm?: { ms: number; timings: Record<string, number> }) => {
        if (firstRunSettled) return;
        firstRunSettled = true;
        firstRunStatus = null;
        clearTimeout(firstRunTimer);
        if (warm) {
            console.log(`[bongle] pipeline warm in ${warm.ms.toFixed(0)}ms`);
            const breakdown = Object.entries(warm.timings)
                .sort((a, b) => b[1] - a[1])
                .map(([label, ms]) => `${label} ${ms.toFixed(0)}ms`)
                .join(', ');
            if (breakdown) console.log(`[bongle]   assets: ${breakdown}`);
        }
        resolveFirstRun();
    };
    firstRunTimer = setTimeout(() => {
        console.error(
            `[bongle:pipeline] first run did not settle within ${FIRST_RUN_TIMEOUT_MS / 1000}s — ` +
                'opening the editor anyway (icons may be missing).',
        );
        settleFirstRun();
    }, FIRST_RUN_TIMEOUT_MS);

    // 'result' (browser forwarding) goes to subscribers via onControl; lifecycle
    // ('warm'/'gate'/'error') is owned in spawnWorker's control handler.
    const controlListeners = new Set<(msg: PipelineWorkerOutbound) => void>();

    spawnWorker();

    const environment = new DevEnvironment(name, config, {
        hot: true,
        transport: workerHotChannel as HotChannel,
    });

    handle = {
        get worker() {
            return worker;
        },
        firstRun,
        get ready() {
            return firstRunSettled;
        },
        get status() {
            return firstRunStatus;
        },
        sendBoot: () => controlPort.postMessage({ type: 'boot' }),
        triggerRun: (forceAll: boolean) => {
            const msg: PipelineWorkerInbound = { type: 'run', forceAll };
            controlPort.postMessage(msg);
        },
        onControl: (cb) => {
            controlListeners.add(cb);
        },
        reboot: async () => {
            // detach listeners from the outgoing worker so its shutdown exit
            // isn't read as a real disconnect; clean-exit it, then spawn a fresh
            // worker (spawnWorker re-attaches the listeners) and re-boot it.
            const old = worker;
            const oldPort = controlPort;
            for (const listener of disconnectListeners.values()) old.off('exit', listener);
            for (const listener of hotListeners.values()) old.off('message', listener);
            await shutdownWorker(old, oldPort);
            spawnWorker();
            controlPort.postMessage({ type: 'boot' });
        },
        close: async () => {
            clearTimeout(firstRunTimer);
            await shutdownWorker(worker, controlPort);
            handle = null;
        },
    };

    return environment;
}

// re-export the outbound type so the plugin's control subscriber doesn't reach
// into runtime/* for it. (`PipelineWorkerInbound` stays internal — only this
// module posts to the worker.)
export type { PipelineWorkerOutbound };
