// Worker spawn helper, isolated so the `?worker&inline` query never
// shows up in the static import graph that Bun's TS loader walks during
// the kit asset pipeline. `voxel-resources.init()` loads this lazily via
// `await import('./mesh-worker-spawn')`; Vite resolves the inline query
// at bundle time, Bun never has to.
//
// `?worker&inline` tells Vite to inline the worker shim as a base64 blob
// in the main client bundle, no separate chunk, no cross-origin Worker
// construction (the deployed client iframe runs at origin='null', so it
// can't OOTB load a CDN-hosted worker script directly).

import type { WorkerLike } from './mesh-dispatcher';
import MeshWorker from './mesh-worker.entry?worker&inline';

export function spawnMeshWorker(): WorkerLike {
    return new MeshWorker() as WorkerLike;
}
