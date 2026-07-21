// ── mesh worker entry ──────────────────────────────────────────────
//
// Web worker that meshes voxel chunks off the main thread. Worker holds:
//   - one decoded BlockRegistry (re-installed on registry rebuild)
//   - module-scope slab scratch via chunk-mesher.ts's _slab/_blockLightSlab
//     (each worker is a separate module instance, so each gets its own
//      private scratch, no contention with main or other workers)
//
// Per batch: main transfers ONE packcat MeshTasks buffer (the batch's set/delete
// mirror deltas + K task chunks) plus K output quad triples (opaque/transparent/
// translucent). The worker applies the deltas to its chunk cache, then for each
// task rebuilds the neighbourhood from the cache and runs `buildSlabs` +
// `meshChunk` — so the strided 18³ slab build happens here, off the main thread —
// and posts back K PassMesh results + recycled buffers in one message. Batching
// collapses K chunks' postMessage cost to a single round-trip; recycling lets
// main return the buffers to its dispatcher pools with zero re-allocation.
//
// Protocol:
//   main → worker
//     { cmd: 'initRegistry', version: number, buf: ArrayBuffer }
//         [transfer: buf]
//     { cmd: 'meshTasks', packetBuf: ArrayBuffer, outBufs: ArrayBuffer[] }
//         [transfer: packetBuf + every outBufs entry]
//         (outBufs[i*3 + {0,1,2}] = opaque/transparent/translucent for task i)
//   worker → main
//     { cmd: 'initRegistryAck', version: number }
//     { cmd: 'result', results: MeshWorkerResult[], workUs,
//       recycle: { packetBuf, outBufs } }
//         [transfer: packetBuf + every outBufs entry; each result's PassMesh.quads
//          views point into its outBufs triple, so transferring the underlying
//          ArrayBuffers carries them too]
//
// The worker never references DOM, Voxels, or any main-thread-only
// resource. It can be unit-tested by importing this module's `handleMessage`
// directly with a stub `post` function, see mesh-dispatcher.test.ts.

import type { Blocks } from './block-registry';
import { deserializeBlockRegistryForWorker } from './block-registry-serde';
import { buildMeshInput, type ChunkMeshResult, type MeshOutput, meshChunk } from './chunk-mesher';
import { unpackMeshTasks } from './mesh-tasks';
import { chunkKey, createVoxels, loadChunk, removeChunk, type Voxels } from './voxels';

export type MeshWorkerInMsg =
    | { cmd: 'initRegistry'; version: number; buf: ArrayBuffer }
    | {
          cmd: 'meshTasks';
          // packcat MeshTasks: the batch's set/delete + K tasks, one buffer
          packetBuf: ArrayBuffer;
          // output quad buffers, flat: outBufs[i*3 + {0:opaque,1:transparent,2:translucent}]
          // for tasks[i]. length === 3 × task count.
          outBufs: ArrayBuffer[];
      };

/** one meshed chunk in a result batch. */
export type MeshWorkerResult = ChunkMeshResult & { chunkKey: string; gen: number };

export type MeshWorkerOutMsg =
    | { cmd: 'initRegistryAck'; version: number }
    | {
          cmd: 'result';
          /** one entry per task in the batch, in the same order. */
          results: MeshWorkerResult[];
          /** worker-side wall time for the whole batch (slab build + mesh), µs. */
          workUs: number;
          recycle: { packetBuf: ArrayBuffer; outBufs: ArrayBuffer[] };
      };

/** state held by one worker instance. Module-scope so the worker entry
 *  can call into it after `self.onmessage` dispatches a message. Tests
 *  call `handleMessage` directly with a private `WorkerState`. */
export type WorkerState = {
    registry: Blocks | null;
    registryVersion: number;
    /** persistent chunk mirror the mesher reads — a real `Voxels`, kept current by
     *  packet set/delete (`loadChunk`/`removeChunk`). null until the first
     *  `initRegistry` (createVoxels needs the registry). main tracks a matching
     *  per-worker mirror. */
    voxels: Voxels | null;
};

export function createWorkerState(): WorkerState {
    return { registry: null, registryVersion: -1, voxels: null };
}

/** main worker message handler. Returns the outbound message (or null
 *  for fire-and-forget). The real worker entry (`mesh-worker.entry.ts`)
 *  wraps this with `self.onmessage` + postMessage; tests call it
 *  directly with a stub `WorkerState`. */
export function handleMessage(state: WorkerState, msg: MeshWorkerInMsg): MeshWorkerOutMsg | null {
    if (msg.cmd === 'initRegistry') {
        const decoded = deserializeBlockRegistryForWorker(msg.buf);
        // Cast: decoded is a Partial<BlockRegistry> populated with every
        // table meshChunk reads. The mesher's destructure-then-read
        // pattern at chunk-mesher.ts:1484 is the contract, unset fields
        // (physics, handles) are never accessed.
        state.registry = decoded as unknown as Blocks;
        state.registryVersion = msg.version;
        // the mirror is a real Voxels; createVoxels needs the registry, so it's
        // built here on first init (kept across rebuilds so the cache survives).
        if (state.voxels === null) state.voxels = createVoxels(state.registry);
        return { cmd: 'initRegistryAck', version: msg.version };
    }
    if (msg.cmd === 'meshTasks') {
        const recycle = { packetBuf: msg.packetBuf, outBufs: msg.outBufs };
        const mt = unpackMeshTasks(new Uint8Array(msg.packetBuf));
        const voxels = state.voxels;
        // apply the mirror deltas FIRST — always, even on the drop path below — so
        // the worker mirror never diverges from main's per-worker mirror. loadChunk
        // links new chunks / updates existing in place; removeChunk unlinks.
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
                // build the 18³ slab from the worker's mirror (off the main
                // thread) — the neighbourhood is already loaded.
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
        return { cmd: 'result', results, workUs: (performance.now() - t0) * 1000, recycle };
    }
    return null;
}
