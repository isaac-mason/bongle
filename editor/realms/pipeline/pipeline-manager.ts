// editor/realms/pipeline/pipeline-manager.ts — a stable handle to the pipeline
// (asset bake) worker that can be RESTARTED to re-bake.
//
// Mirrors server-manager: the raw PipelineHost is a one-worker handle, so this
// wraps it in a facade whose identity never changes and `restart()` swaps the
// worker underneath. A restart re-runs the first bake against the CURRENT bundler
// (a fresh conduit is wired on the new worker's handshake), so it doubles as
// "re-bake assets" — useful after a bundler restart, or to force a clean bake.

import { type PipelineHost, type SpawnPipelineWorkerOptions, spawnPipelineWorker } from './pipeline-host';

export type PipelineManager = PipelineHost & {
    /** kill the current worker, respawn it against the same project, and await its
     *  first bake (`ready`). Its bundler conduit re-handshakes to the current worker. */
    restart(): Promise<void>;
};

export function createPipelineManager(opts: SpawnPipelineWorkerOptions): PipelineManager {
    let active = spawnPipelineWorker(opts);
    return {
        // `ready` reflects the CURRENT worker (a getter, re-read after a restart).
        get ready() {
            return active.ready;
        },
        dispose: () => active.dispose(),
        async restart() {
            active.dispose();
            active = spawnPipelineWorker(opts);
            await active.ready;
        },
    };
}
