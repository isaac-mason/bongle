/// <reference types="vite/client" />
/**
 * kit/runtime/pipeline-host.ts — boot module for the `pipeline` Vite env.
 *
 * Invoked through `virtual:bongle/pipeline-host` (served by
 * `kit/vite/virtual-entries.ts`), imported by `pipeline-worker.mjs` through the
 * worker's ModuleRunner and handed the control port via `boot(ctx)` → `start()`.
 *
 * This is the whole asset pipeline, relocated off the editor's main thread. It
 * runs in the worker's runner graph — its own registry, populated by running the
 * real user code (`virtual:bongle/user-src`) and kept fresh in place by HMR,
 * exactly like the server env does. So there's no registry serialization: the
 * bake builders + icon render read the same live registry the user authored.
 *
 * Flow (symmetric with runtime/edit-server.ts):
 *  1. Set env flags BEFORE awaiting user-entry (top-level user declarations may
 *     branch on env). Mirrors the server env: client=false, server=true,
 *     editor=true.
 *  2. Await `userEntry()` so registries populate before AssetPipeline reads them.
 *  3. `AssetPipeline.init` (captures registry refs; no GPU yet).
 *  4. Register the `__kit` flush handler — every settled HMR cascade in this
 *     worker drives one pipeline pass. Plus a control-port 'run' trigger for
 *     asset/scene file changes the main process detects and relays.
 *  5. Report each pass back over the control port: `result` (RunResult +
 *     refreshed asset sources), `warm` (first-run banner), `gate` (release the
 *     editor-load gate even on fault). The main process forwards these to the
 *     browser and opens its ready gate.
 */

import type { MessagePort } from 'node:worker_threads';
import { env } from 'bongle';
import { AssetPipeline } from 'bongle/engine-asset-pipeline';
import { __kit } from 'bongle/internal';

type RunResult = Awaited<ReturnType<typeof AssetPipeline.run>>;

/** App-level messages the host posts back to the main process. */
export type PipelineWorkerOutbound =
    | { type: 'result'; result: RunResult; assetSources: string[] }
    | { type: 'warm'; ms: number; timings: Record<string, number> }
    | { type: 'gate' }
    | { type: 'error'; error: string };

/** App-level messages the host receives from the main process. `shutdown` is
 *  handled in pipeline-worker.mjs (process-level), not here. */
export type PipelineWorkerInbound = { type: 'run'; forceAll?: boolean } | { type: 'shutdown' };

export type StartOptions = {
    control: MessagePort;
    projectDir: string;
    bongleDir: string;
    /** dynamic import of `virtual:bongle/user-src` — awaited after env is set. */
    userEntry: () => Promise<unknown>;
};

export async function start(opts: StartOptions): Promise<void> {
    const { control, projectDir, userEntry } = opts;

    env.client = false;
    env.server = true;
    env.editor = true;

    await userEntry();

    const pipeline = AssetPipeline.init({ projectDir, mode: 'edit', cache: true, renderIcons: true });

    // One coalescing driver (moved verbatim in spirit from the old in-process
    // bongle:pipeline plugin): collapse concurrent triggers into a run plus at
    // most one tail run. Pure gating lives inside AssetPipeline.run; this owns
    // the lock and reports each settled pass back to the main process.
    let busy = false;
    let queued = false;
    let queuedForceAll = false;
    let firstRunComplete = false;
    // set on 'shutdown' so no new pass starts; the in-flight pass drains first so
    // the isolate never exits with a pending GPUBuffer.mapAsync() (Dawn FATALs on
    // an unresolved map at teardown — the crash a mid-render worker respawn hit).
    let shuttingDown = false;
    const idleWaiters: Array<() => void> = [];
    const run = async (forceAll = false): Promise<void> => {
        if (shuttingDown) return;
        if (forceAll) queuedForceAll = true;
        if (busy) {
            queued = true;
            return;
        }
        busy = true;
        const passStart = performance.now();
        try {
            do {
                queued = false;
                const passForceAll = queuedForceAll;
                queuedForceAll = false;
                let result: RunResult;
                try {
                    result = await AssetPipeline.run(pipeline, { forceAll: passForceAll });
                } catch (err) {
                    control.postMessage({ type: 'error', error: String((err as Error)?.stack ?? err) });
                    continue;
                }
                // New declarations are now in scope; removed ones drop out.
                const assetSources = [...AssetPipeline.assetSources(pipeline)];
                control.postMessage({ type: 'result', result, assetSources });
                if (!firstRunComplete) {
                    firstRunComplete = true;
                    control.postMessage({ type: 'warm', ms: performance.now() - passStart, timings: result.timings });
                }
            } while (queued && !shuttingDown);
        } finally {
            busy = false;
            // release the editor gate even on a faulted first pass.
            control.postMessage({ type: 'gate' });
            for (const wake of idleWaiters.splice(0)) wake();
        }
    };

    // drain the in-flight pass (so mapAsync readbacks settle), then exit from
    // this clean JS stack. Replaces pipeline-worker.mjs's immediate exit once
    // booted; a wedged pass falls back to the main-side shutdown timeout.
    const drainAndExit = async (): Promise<void> => {
        shuttingDown = true;
        if (busy) await new Promise<void>((resolve) => idleWaiters.push(resolve));
        process.exit(0);
    };

    // asset/scene file changes are detected by the main process (it owns the
    // Vite watcher) and relayed here as a control 'run'; 'shutdown' drains first.
    control.on('message', (msg: PipelineWorkerInbound) => {
        if (msg?.type === 'run') void run(!!msg.forceAll);
        else if (msg?.type === 'shutdown') void drainAndExit();
    });

    // every settled HMR cascade in this worker → one pass. This is the
    // per-edit re-run; it fires entirely in-worker (user-code edits re-eval in
    // this isolate via HMR, the user-src self-accept calls __kit.flush()).
    __kit.registerFlush(() => {
        void run();
    });

    // kick the cold-start pass (the worker boots after the server is listening,
    // so the first flush from user-src may have already fired before this
    // handler registered — drive one explicitly to be sure).
    void run();
}
