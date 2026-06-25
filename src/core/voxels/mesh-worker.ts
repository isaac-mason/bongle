// ── mesh worker entry ──────────────────────────────────────────────
//
// Web worker that meshes voxel chunks off the main thread. Worker holds:
//   - one decoded BlockRegistry (re-installed on registry rebuild)
//   - module-scope slab scratch via chunk-mesher.ts's _slab/_blockLightSlab
//     (each worker is a separate module instance, so each gets its own
//      private scratch — no contention with main or other workers)
//
// Per job: main transfers two ArrayBuffers (blocks + light slab bytes)
// plus chunk coords. Worker copies the bytes into module scratch via
// `installSlabsAndBuildMeshInput`, runs `meshChunk`, posts back the
// PassMesh results + recycled input buffers. Recycling lets main return
// the slab pair to its dispatcher pool with zero re-allocation.
//
// Protocol:
//   main → worker
//     { cmd: 'initRegistry', version: number, buf: ArrayBuffer }
//         [transfer: buf]
//     { cmd: 'mesh', chunkKey: string, gen: number,
//       cx, cy, cz: number,
//       blocksBuf, lightBuf: ArrayBuffer,
//       opaqueBuf, transparentBuf, translucentBuf: ArrayBuffer }
//         [transfer: all 5 buffers]
//   worker → main
//     { cmd: 'initRegistryAck', version: number }
//     { cmd: 'result', chunkKey, gen,
//       opaque, transparent, translucent: PassMesh | null,
//       aabb: { min, max } | null,
//       recycle: { blocksBuf, lightBuf,
//                  opaqueBuf, transparentBuf, translucentBuf } }
//         [transfer: all 5 recycle buffers — the PassMesh.quads views
//          point into recycle.{opaque,transparent,translucent}Buf, so
//          transferring the underlying ArrayBuffers carries them too]
//
// The worker never references DOM, Voxels, or any main-thread-only
// resource. It can be unit-tested by importing this module's `handleMessage`
// directly with a stub `post` function — see mesh-dispatcher.test.ts.

import type { BlockRegistry } from './block-registry';
import { type ChunkMeshResult, type MeshOutput, installSlabsAndBuildMeshInput, meshChunk } from './chunk-mesher';
import { deserializeBlockRegistryForWorker } from './block-registry-serde';

export type MeshWorkerInMsg =
    | { cmd: 'initRegistry'; version: number; buf: ArrayBuffer }
    | {
          cmd: 'mesh';
          chunkKey: string;
          gen: number;
          cx: number;
          cy: number;
          cz: number;
          blocksBuf: ArrayBuffer;
          lightBuf: ArrayBuffer;
          opaqueBuf: ArrayBuffer;
          transparentBuf: ArrayBuffer;
          translucentBuf: ArrayBuffer;
      };

export type MeshWorkerOutMsg =
    | { cmd: 'initRegistryAck'; version: number }
    | (ChunkMeshResult & {
          cmd: 'result';
          chunkKey: string;
          gen: number;
          recycle: {
              blocksBuf: ArrayBuffer;
              lightBuf: ArrayBuffer;
              opaqueBuf: ArrayBuffer;
              transparentBuf: ArrayBuffer;
              translucentBuf: ArrayBuffer;
          };
      });

/** state held by one worker instance. Module-scope so the worker entry
 *  can call into it after `self.onmessage` dispatches a message. Tests
 *  call `handleMessage` directly with a private `WorkerState`. */
export type WorkerState = {
    registry: BlockRegistry | null;
    registryVersion: number;
};

export function createWorkerState(): WorkerState {
    return { registry: null, registryVersion: -1 };
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
        // pattern at chunk-mesher.ts:1484 is the contract — unset fields
        // (physics, handles) are never accessed.
        state.registry = decoded as unknown as BlockRegistry;
        state.registryVersion = msg.version;
        return { cmd: 'initRegistryAck', version: msg.version };
    }
    if (msg.cmd === 'mesh') {
        const recycle = {
            blocksBuf: msg.blocksBuf,
            lightBuf: msg.lightBuf,
            opaqueBuf: msg.opaqueBuf,
            transparentBuf: msg.transparentBuf,
            translucentBuf: msg.translucentBuf,
        };
        if (state.registry === null) {
            // Drop the job and recycle the buffers. The dispatcher should
            // never send 'mesh' before an ack, but if it does we still
            // want the buffers back so the pool doesn't leak.
            return {
                cmd: 'result',
                chunkKey: msg.chunkKey,
                gen: msg.gen,
                opaque: null,
                transparent: null,
                translucent: null,
                aabb: null,
                recycle,
            };
        }
        const blocksU32 = new Uint32Array(msg.blocksBuf);
        const lightU16 = new Uint16Array(msg.lightBuf);
        const out: MeshOutput = {
            opaque: new Uint32Array(msg.opaqueBuf),
            transparent: new Uint32Array(msg.transparentBuf),
            translucent: new Uint32Array(msg.translucentBuf),
        };
        const input = installSlabsAndBuildMeshInput(msg.cx, msg.cy, msg.cz, blocksU32, lightU16);
        const result = meshChunk(out, input, state.registry);
        return {
            cmd: 'result',
            chunkKey: msg.chunkKey,
            gen: msg.gen,
            opaque: result ? result.opaque : null,
            transparent: result ? result.transparent : null,
            translucent: result ? result.translucent : null,
            aabb: result ? result.aabb : null,
            recycle,
        };
    }
    return null;
}
