// editor/pipeline-host.ts — main-thread handle to the pipeline worker.
//
// Spawns editor/pipeline-worker.ts, connects its bundler conduit to the bundler
// worker (env 'pipeline'), and surfaces bake results: 'baked' signals a completed
// bake (optional callback), 'fs-changed' relays the worker's bake writes, 'log' →
// the build log stream. Mirrors server-host.ts; the main doc only brokers + relays.

import type { FsChange } from '../fs';

export type PipelineHost = {
    /** resolves once the worker has run its first bake. */
    ready: Promise<void>;
    dispose(): void;
};

export type SpawnPipelineWorkerOptions = {
    /** connect a realm's bundler conduit to the bundler worker (transfers the port). */
    connectRealm: (env: string, port: MessagePort) => void;
    /** OPFS project the worker opens directly (same origin as the main doc). */
    projectName: string;
    log?: (msg: string) => void;
    /** a bake completed (atlas written to the shared OPFS for the client renderer). */
    onBaked?: (atlasChanged: boolean) => void;
    /** the worker's bake writes (OPFS has no cross-context events) — the main doc
     *  HMRs the generated barrel + refreshes baked resources in the other realms. */
    onFsChanged?: (changes: FsChange[]) => void;
};

export function spawnPipelineWorker(opts: SpawnPipelineWorkerOptions): PipelineHost {
    const { connectRealm, projectName, log = () => {}, onBaked, onFsChanged } = opts;

    const worker = new Worker(new URL('./pipeline-worker.ts', import.meta.url), { type: 'module' });

    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => {
        resolveReady = r;
    });

    worker.onmessage = (e: MessageEvent) => {
        const msg = e.data as { type: string; msg?: string; atlasChanged?: boolean; changes?: FsChange[] };
        if (msg.type === 'log') log(msg.msg ?? '');
        else if (msg.type === 'baked') onBaked?.(!!msg.atlasChanged);
        else if (msg.type === 'fs-changed') onFsChanged?.(msg.changes ?? []);
        else if (msg.type === 'ready') resolveReady();
    };
    worker.onerror = (e) => log(`pipeline worker crashed: ${e.message}`);

    // bundler conduit: the worker's ModuleRunner ↔ the bundler worker DevServer
    // (env 'pipeline'). One port to the bundler worker, the other to this worker.
    const bundler = new MessageChannel();
    connectRealm('pipeline', bundler.port1);
    worker.postMessage({ type: 'init', projectName }, [bundler.port2]);

    return {
        ready,
        dispose() {
            worker.postMessage({ type: 'dispose' });
            worker.terminate();
        },
    };
}
