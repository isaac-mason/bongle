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
import { MessageChannel, Worker } from 'node:worker_threads';
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
// hard-terminate it — a wedged worker must not hang the CLI's exit.
const SHUTDOWN_TIMEOUT_MS = 2_000;

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

    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(WORKER_PATH, {
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

    // ── Vite transport (HotChannel) bridging to the worker via postMessage ──
    type ChannelListener = (data: unknown, client: HotChannelClient) => void;
    const handlerToWorkerListener = new WeakMap<ChannelListener, (value: HotPayload) => void>();
    const client: HotChannelClient = { send: (payload) => worker.postMessage(payload) };

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
                handlerToWorkerListener.set(fn, listener as unknown as (value: HotPayload) => void);
                worker.on('exit', listener);
                return;
            }
            const listener = (value: HotPayload) => {
                if (value?.type === 'custom' && value.event === event) fn(value.data, client);
            };
            handlerToWorkerListener.set(fn, listener);
            worker.on('message', listener);
        },
        off: (event: string, fn: ChannelListener) => {
            const listener = handlerToWorkerListener.get(fn);
            if (!listener) return;
            if (event === 'vite:client:disconnect') worker.off('exit', listener);
            else worker.off('message', listener);
            handlerToWorkerListener.delete(fn);
        },
    };

    const environment = new DevEnvironment(name, config, {
        hot: true,
        transport: workerHotChannel as HotChannel,
    });

    // ── first-pipeline-run gate ──
    // The worker reports its first settled pass via 'warm' (success, with
    // timings) or 'gate' (fault/empty). Resolve `firstRun` exactly once on
    // either — or on the timeout guard — so a wedged first pass can't hang the
    // CLI banner or the editor's /__bongle/ready poll. Never rejects.
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

    // ── app-level control port ──
    // Lifecycle ('warm'/'gate'/'error') is owned here and drives the gate;
    // 'result' (browser forwarding) is left to subscribers via onControl.
    const controlListeners = new Set<(msg: PipelineWorkerOutbound) => void>();
    port1.on('message', (msg: PipelineWorkerOutbound) => {
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

    handle = {
        worker,
        firstRun,
        get ready() {
            return firstRunSettled;
        },
        get status() {
            return firstRunStatus;
        },
        sendBoot: () => port1.postMessage({ type: 'boot' }),
        triggerRun: (forceAll: boolean) => {
            const msg: PipelineWorkerInbound = { type: 'run', forceAll };
            port1.postMessage(msg);
        },
        onControl: (cb) => {
            controlListeners.add(cb);
        },
        close: () =>
            new Promise<void>((resolve) => {
                clearTimeout(firstRunTimer);
                let killTimer: ReturnType<typeof setTimeout>;
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(killTimer);
                    try {
                        port1.close();
                    } catch {
                        // already closed
                    }
                    handle = null;
                    resolve();
                };
                worker.once('exit', finish);
                // Ask the worker to exit from its own clean JS stack. Terminating
                // it from here while Dawn's ProcessEvents pump is mid-callback
                // aborts the process with a napi FATAL — see pipeline-worker.mjs.
                try {
                    const msg: PipelineWorkerInbound = { type: 'shutdown' };
                    port1.postMessage(msg);
                } catch {
                    void worker.terminate(); // port already gone — fall straight to terminate.
                }
                killTimer = setTimeout(() => void worker.terminate(), SHUTDOWN_TIMEOUT_MS);
            }),
    };

    return environment;
}

// re-export the outbound type so the plugin's control subscriber doesn't reach
// into runtime/* for it. (`PipelineWorkerInbound` stays internal — only this
// module posts to the worker.)
export type { PipelineWorkerOutbound };
