import type { Blocks } from './block-registry';
import { deserializeBlockRegistryForWorker } from './block-registry-serde';
import { buildMeshInput, type ChunkMeshResult, type MeshOutput, meshChunk } from './chunk-mesher';
import { unpackMeshTasks } from './mesh-tasks';
import { chunkKey, createVoxels, loadChunk, removeChunk, type Voxels } from './voxels';

export type MeshWorkerInMsg =
    | { cmd: 'initRegistry'; version: number; buf: ArrayBuffer }
    | {
          cmd: 'meshTasks';
          /** main's world epoch when the batch was posted; echoed on the result. */
          epoch: number;
          packetBuf: ArrayBuffer;
          /** flat outBufs[i*3 + {0:opaque,1:transparent,2:translucent}] for tasks[i]; length === 3 * task count. */
          outBufs: ArrayBuffer[];
      }
    // active-room swap: drop the chunk cache so the next batch reloads from scratch. fire-and-forget.
    | { cmd: 'clearCache' };

/** one meshed chunk in a result batch. */
export type MeshWorkerResult = ChunkMeshResult & { chunkKey: string; gen: number };

export type MeshWorkerOutMsg =
    | { cmd: 'initRegistryAck'; version: number }
    | {
          cmd: 'result';
          /** the `meshTasks` epoch this batch was posted under. */
          epoch: number;
          /** one entry per task in the batch, in the same order. */
          results: MeshWorkerResult[];
          /** worker-side wall time for the whole batch (slab build + mesh), in microseconds. */
          workUs: number;
          recycle: { packetBuf: ArrayBuffer; outBufs: ArrayBuffer[] };
      };

/** state held by one worker instance; tests call `handleMessage` directly with a private `WorkerState`. */
export type WorkerState = {
    registry: Blocks | null;
    registryVersion: number;
    /** chunk cache kept current by packet set/delete; null until the first `initRegistry`, rebuilt empty on `clearCache`. */
    voxels: Voxels | null;
};

export function createWorkerState(): WorkerState {
    return { registry: null, registryVersion: -1, voxels: null };
}

/** worker message handler; returns the outbound message or null for fire-and-forget. `mesh-worker.entry.ts` wraps this with postMessage. */
export function handleMessage(state: WorkerState, msg: MeshWorkerInMsg): MeshWorkerOutMsg | null {
    if (msg.cmd === 'initRegistry') {
        const decoded = deserializeBlockRegistryForWorker(msg.buf);
        // decoded is a Partial<BlockRegistry> with every field meshChunk reads; unset fields (physics, handles) are never accessed.
        state.registry = decoded as unknown as Blocks;
        state.registryVersion = msg.version;
        // built on first init since createVoxels needs the registry; kept across rebuilds.
        if (state.voxels === null) state.voxels = createVoxels(state.registry);
        return { cmd: 'initRegistryAck', version: msg.version };
    }
    if (msg.cmd === 'clearCache') {
        // rebuild empty so a chunk the old world had doesn't linger as a phantom neighbour and corrupt boundary meshing.
        if (state.registry !== null) state.voxels = createVoxels(state.registry);
        return null;
    }
    if (msg.cmd === 'meshTasks') {
        const recycle = { packetBuf: msg.packetBuf, outBufs: msg.outBufs };
        const mt = unpackMeshTasks(new Uint8Array(msg.packetBuf));
        const voxels = state.voxels;
        // deltas apply before meshing, even on the drop path below, so the cache never diverges from main's model.
        if (voxels !== null) {
            for (const s of mt.set) loadChunk(voxels, s.cx, s.cy, s.cz, s.version, s.data, s.light, s.palette);
            for (const d of mt.delete) removeChunk(voxels, d.cx, d.cy, d.cz);
        }
        const t0 = performance.now();
        const results: MeshWorkerResult[] = [];
        for (let i = 0; i < mt.tasks.length; i++) {
            const task = mt.tasks[i]!;
            const key = chunkKey(task.cx, task.cy, task.cz);
            // dispatcher should never send before ack, but if it does, drop
            // (null result) so the buffers still round-trip and the pool holds.
            let result: ChunkMeshResult | null = null;
            if (state.registry !== null && voxels !== null) {
                const out: MeshOutput = {
                    opaque: new Uint32Array(msg.outBufs[i * 3]!),
                    transparent: new Uint32Array(msg.outBufs[i * 3 + 1]!),
                    translucent: new Uint32Array(msg.outBufs[i * 3 + 2]!),
                };
                // builds the 18^3 slab from the worker's cache; the neighbourhood is already loaded.
                const input = buildMeshInput(voxels, task.cx, task.cy, task.cz);
                result = meshChunk(out, input, state.registry);
            }
            results.push({
                chunkKey: key,
                gen: task.gen,
                opaque: result ? result.opaque : null,
                transparent: result ? result.transparent : null,
                translucent: result ? result.translucent : null,
                aabb: result ? result.aabb : null,
            });
        }
        return { cmd: 'result', epoch: msg.epoch, results, workUs: (performance.now() - t0) * 1000, recycle };
    }
    return null;
}
