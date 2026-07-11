/**
 * kit/runtime/pipeline-worker.mjs — the asset-pipeline worker_thread entry.
 *
 * Plain JS (not TS) so a bare `new Worker(path)` under Node loads it directly —
 * it depends only on `vite/module-runner` + node builtins and pulls in zero
 * bongle source itself; all engine/user code is fetched through the Vite
 * ModuleRunner over the transport, so it lands in THIS isolate's module graph
 * (own registry, own heap, own GC, own event loop). That isolation is the whole
 * point: the Dawn ProcessEvents pump + its allocation churn run here, never on
 * the editor's main thread.
 *
 * Two channels, deliberately separate:
 *   • parentPort      — the Vite ModuleRunner transport (fetchModule + HMR
 *                       HotPayloads). Owned entirely by Vite.
 *   • workerData.control — a MessagePort for app-level control: 'boot' to start,
 *                       'run' to force a pass; results/warm/gate/error flow back.
 * Keeping them apart means app messages never collide with Vite's protocol.
 *
 * Boot is explicit (main sends 'boot' after `server.listen()`, so the env is
 * initialized before the first `fetchModule`). On boot we import the pipeline
 * host through the runner and hand it the control port; from then on the host
 * self-drives off HMR (user-code edits re-eval in place here) and the control
 * port (asset/scene file changes relayed from main).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createNodeImportMeta, ESModulesEvaluator, ModuleRunner } from 'vite/module-runner';

const { control, bootId, projectDir, bongleDir } = workerData;

/** @type {import('vite/module-runner').ModuleRunnerTransport} */
const transport = {
    connect({ onMessage, onDisconnection }) {
        parentPort.on('message', onMessage);
        parentPort.on('close', onDisconnection);
    },
    send(data) {
        parentPort.postMessage(data);
    },
};

const runner = new ModuleRunner({ transport, hmr: true, createImportMeta: createNodeImportMeta }, new ESModulesEvaluator());

let booted = false;
control.on('message', async (msg) => {
    if (msg?.type !== 'boot' || booted) return;
    booted = true;
    try {
        const mod = await runner.import(bootId);
        await mod.boot({ control, projectDir, bongleDir });
    } catch (err) {
        control.postMessage({ type: 'error', error: String(err?.stack ?? err) });
        // open the editor gate anyway — a boot fault must not wedge startup.
        control.postMessage({ type: 'gate' });
    }
});

// Graceful shutdown. Before boot (or on a boot fault) there's no Dawn device
// yet, so exit immediately from this clean message-callback stack. Once booted,
// the pipeline host owns shutdown (`drainAndExit`) so it can drain the in-flight
// pass first — exiting with a pending GPUBuffer.mapAsync() FATALs Dawn.
control.on('message', (msg) => {
    if (msg?.type === 'shutdown' && !booted) process.exit(0);
});

// surface unexpected faults rather than dying silently.
process.on('unhandledRejection', (err) => {
    control.postMessage({ type: 'error', error: String(err?.stack ?? err) });
});

control.postMessage({ type: 'ready' });
