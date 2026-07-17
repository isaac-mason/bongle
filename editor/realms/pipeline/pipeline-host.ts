// editor/realms/pipeline/pipeline-host.ts — main-thread handle to the pipeline worker.
//
// Spawns pipeline-worker.ts, connects its bundler conduit to the bundler
// worker (env 'pipeline'), and surfaces bake results: 'baked' signals a completed
// bake (optional callback), 'fs-changed' relays the worker's bake writes, 'log' →
// the build log stream. Mirrors server-host.ts; the main doc only brokers + relays.

import type { FsChange } from '../../fs';

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
    /** the realm's current matchmaking.maxPlayers, reported after each bake — the
     *  prod build reads it (it can't evaluate user code to see the registry). */
    onMatchmaking?: (maxPlayers: number) => void;
    /** the worker's bake writes (OPFS has no cross-context events) — the main doc
     *  HMRs the generated barrel + refreshes baked resources in the other realms. */
    onFsChanged?: (changes: FsChange[]) => void;
};

export function spawnPipelineWorker(opts: SpawnPipelineWorkerOptions): PipelineHost {
    const { connectRealm, projectName, log = () => {}, onBaked, onMatchmaking, onFsChanged } = opts;

    const worker = new Worker(new URL('./pipeline-worker.ts', import.meta.url), { type: 'module' });

    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => {
        resolveReady = r;
    });

    worker.onmessage = (e: MessageEvent) => {
        const msg = e.data as { type: string; msg?: string; atlasChanged?: boolean; maxPlayers?: number; changes?: FsChange[] };
        if (msg.type === 'worker-ready') {
            // the worker is live — NOW wire its bundler conduit + post init (with the
            // transferred port). Posting at spawn drops it in vite's dep-optimize
            // window, since the worker's module often finishes eval after it.
            console.log('[boot] pipeline: worker-ready → connecting bundler conduit + posting init');
            const bundler = new MessageChannel();
            connectRealm('pipeline', bundler.port1);
            worker.postMessage({ type: 'init', projectName }, [bundler.port2]);
        } else if (msg.type === 'log') log(msg.msg ?? '');
        else if (msg.type === 'baked') {
            onBaked?.(!!msg.atlasChanged);
            if (typeof msg.maxPlayers === 'number') onMatchmaking?.(msg.maxPlayers);
        } else if (msg.type === 'fs-changed') onFsChanged?.(msg.changes ?? []);
        else if (msg.type === 'ready') {
            console.log('[boot] pipeline: worker reported ready (first bake done)');
            resolveReady();
        }
    };
    worker.onerror = (e) => console.error('[boot] pipeline worker crashed:', e.message);

    console.log('[boot] pipeline: worker spawned, awaiting worker-ready');

    return {
        ready,
        dispose() {
            worker.postMessage({ type: 'dispose' });
            worker.terminate();
        },
    };
}
