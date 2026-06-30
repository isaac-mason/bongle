// ── mesh dispatcher ────────────────────────────────────────────────
//
// Owns the worker pool that runs `meshChunk` off the main thread. Each
// worker holds its own deserialized BlockRegistry; main thread keeps a
// canonical serialized buffer and reslices it per worker on rebuild.
//
// Scheduling model:
//   - N workers, each with a FIFO queue of depth QUEUE_DEPTH. Main can
//     post up to N*QUEUE_DEPTH jobs simultaneously. Worker drains its
//     own queue with no postMessage round-trip between jobs.
//   - inFlightByChunk dedups: a chunk in flight at any slot cannot be
//     re-enqueued (the caller waits for the result before retrying).
//   - Per-job buffer sets (blocks/light slab + 3 pre-allocated quad
//     output bufs) come from a pre-allocated `jobBufferPool` sized to
//     N*QUEUE_DEPTH. Borrow on enqueue, transfer to worker, echoed
//     back in the `recycle` field of the result.
//   - Generation guard: caller passes chunk.meshGen into enqueue. Worker
//     echoes it. Caller decides whether the result is fresh (handler
//     gets the gen and matches against current chunk.meshGen).
//
// Registry rebuild handshake:
//   - setRegistry serializes once, slices N times, posts initRegistry
//     to each slot, marks pendingRegistryVersion.
//   - Slot is dispatch-eligible only when ack lands
//     (registryVersion === dispatcher.registryVersion).
//   - In-flight old-version jobs complete normally; caller's gen guard
//     handles whether to apply them.

import type { BlockRegistry } from '../../core/voxels/block-registry';
import { serializeBlockRegistryForWorker } from '../../core/voxels/block-registry-serde';
import {
    buildSlabsIntoBuffers,
    type ChunkMeshResult,
    MAX_QUADS_PER_PASS,
    QUAD_STRIDE_U32S,
    SLAB_BLOCKS_BYTES,
    SLAB_LIGHT_BYTES,
} from '../../core/voxels/chunk-mesher';
import type { MeshWorkerInMsg, MeshWorkerOutMsg } from '../../core/voxels/mesh-worker';
import type { Chunk, Voxels } from '../../core/voxels/voxels';
import { chunkKey } from '../../core/voxels/voxels';

/** minimal Worker surface the dispatcher needs. Both real `Worker` and
 *  `MessagePort` (used by the in-process test) satisfy this shape.
 *  `onerror` / `onmessageerror` are optional, only real `Worker`s emit
 *  them; the in-process test stubs them out. */
export interface WorkerLike {
    postMessage(msg: MeshWorkerInMsg, transfer?: Transferable[]): void;
    onmessage: ((e: MessageEvent<MeshWorkerOutMsg>) => void) | null;
    onerror?: ((ev: unknown) => void) | null;
    onmessageerror?: ((ev: unknown) => void) | null;
    terminate?(): void;
}

/** spawnMeshWorker lives in `mesh-worker-spawn.ts` so the `?worker&inline`
 *  query stays out of mesh-dispatcher's static import graph, Bun's TS
 *  loader doesn't strip Vite query suffixes, and the kit asset pipeline
 *  imports this file via the `bongle` graph. voxel-resources reaches the
 *  spawn helper through a dynamic import that only resolves under Vite. */

/** result handed back through `onResult` when a worker finishes a job.
 *  `ChunkMeshResult` carries the three PassMesh payloads + AABB (same
 *  shape the sync `meshChunk` path returns); `chunkKey` + `gen` let the
 *  caller match it back to the right chunk and discard stale results.
 *  Buffer views (`PassMesh.quads`) are backed by transferred ArrayBuffers,
 * see mesh-worker.ts protocol notes. */
export type MeshDispatcherResult = ChunkMeshResult & {
    chunkKey: string;
    gen: number;
};

/** the buffer set transferred between main and worker for one in-flight
 *  job. `blocksBuf` + `lightBuf` carry the input slab; `opaqueBuf` /
 *  `transparentBuf` / `translucentBuf` are pre-allocated output buffers
 *  the worker writes the final quad stream into. All 5 round-trip with
 *  the result so the pool reclaims them with no fresh allocation. */
type MeshJobBuffers = {
    blocksBuf: ArrayBuffer;
    lightBuf: ArrayBuffer;
    opaqueBuf: ArrayBuffer;
    transparentBuf: ArrayBuffer;
    translucentBuf: ArrayBuffer;
};

const PASS_BUF_BYTES = MAX_QUADS_PER_PASS * QUAD_STRIDE_U32S * 4;

type WorkerSlot = {
    worker: WorkerLike;
    /** FIFO of in-flight job keys at this slot, entries are spliced
     *  out by chunkKey when the matching result lands. Length bounded
     *  by `queueDepth`. */
    inFlight: Array<{ chunkKey: string; gen: number }>;
    /** version this slot has acked. Slot is ineligible for dispatch
     *  until this equals `MeshDispatcher.registryVersion`. */
    registryVersion: number;
    /** version most recently posted to this slot. Used to detect
     *  "init pending but not yet acked". */
    pendingRegistryVersion: number;
};

export type MeshDispatcher = {
    slots: WorkerSlot[];
    queueDepth: number;
    /** chunk key → which slot owns it. Used both for dedup ("don't
     *  enqueue twice") and reverse lookup on result. */
    inFlightByChunk: Map<string, { slot: number; gen: number }>;
    /** free per-job buffer sets. Borrowed on enqueue, recycled on result. */
    jobBufferPool: MeshJobBuffers[];
    registryVersion: number;
    /** canonical serialized registry, kept so newly spawned workers
     *  (post-crash respawn) can be re-inited without re-encoding. */
    registryBuf: ArrayBuffer | null;
    onResult: (result: MeshDispatcherResult) => void;
    /** called once per in-flight chunk lost when a worker crashes,
     *  caller is expected to re-mark the chunk dirty so it gets
     *  re-dispatched on a subsequent frame. null if the caller doesn't
     *  care (offline paths). */
    onLost: ((chunkKey: string) => void) | null;
    /** kept for crash recovery, respawn calls this to get a fresh
     *  worker for the same slot index. */
    workerFactory: () => WorkerLike;
};

export type MeshDispatcherOpts = {
    /** factory called once per worker slot at construction. */
    workerFactory: () => WorkerLike;
    workerCount: number;
    queueDepth: number;
    /** called when a result lands (fresh or stale, caller's gen guard
     *  decides what to do with it). */
    onResult: (result: MeshDispatcherResult) => void;
    /** optional, called once per in-flight chunk lost to a worker crash
     *  (worker `error` / `messageerror` event). The dispatcher respawns
     *  the worker and replenishes the buffer pool; the caller is
     *  responsible for putting the chunk back on the dirty list. */
    onLost?: (chunkKey: string) => void;
};

export function createMeshDispatcher(opts: MeshDispatcherOpts): MeshDispatcher {
    const slots: WorkerSlot[] = [];
    const d: MeshDispatcher = {
        slots,
        queueDepth: opts.queueDepth,
        inFlightByChunk: new Map(),
        jobBufferPool: [],
        registryVersion: -1,
        registryBuf: null,
        onResult: opts.onResult,
        onLost: opts.onLost ?? null,
        workerFactory: opts.workerFactory,
    };

    // Pre-allocate the job buffer pool. Sized to cover every slot at
    // full queue depth, every job borrows one set and transfers it; the
    // result echoes it back to the pool.
    const poolSize = opts.workerCount * opts.queueDepth;
    for (let i = 0; i < poolSize; i++) {
        d.jobBufferPool.push(allocateJobBuffers());
    }

    for (let i = 0; i < opts.workerCount; i++) {
        const worker = opts.workerFactory();
        const slot: WorkerSlot = {
            worker,
            inFlight: [],
            registryVersion: -1,
            pendingRegistryVersion: -1,
        };
        wireWorker(d, i, worker);
        slots.push(slot);
    }

    return d;
}

function allocateJobBuffers(): MeshJobBuffers {
    return {
        blocksBuf: new ArrayBuffer(SLAB_BLOCKS_BYTES),
        lightBuf: new ArrayBuffer(SLAB_LIGHT_BYTES),
        opaqueBuf: new ArrayBuffer(PASS_BUF_BYTES),
        transparentBuf: new ArrayBuffer(PASS_BUF_BYTES),
        translucentBuf: new ArrayBuffer(PASS_BUF_BYTES),
    };
}

/** Wire onmessage + crash handlers for a (possibly newly respawned)
 *  worker. Both `error` (worker-script exception) and `messageerror`
 *  (postMessage failed to deserialise) terminate the slot's worker and
 *  respawn, see `handleWorkerCrash`. */
function wireWorker(d: MeshDispatcher, slotIndex: number, worker: WorkerLike): void {
    worker.onmessage = (e) => handleWorkerMessage(d, slotIndex, e.data);
    worker.onerror = (ev) => handleWorkerCrash(d, slotIndex, 'error', ev);
    worker.onmessageerror = (ev) => handleWorkerCrash(d, slotIndex, 'messageerror', ev);
}

/** Respawn a crashed worker slot. The crash detaches every buffer
 *  currently in flight at the slot, they're gone, can't be returned
 *  to the pool. We replenish with freshly-allocated sets to keep the
 *  pool at its original capacity. In-flight chunks are surfaced
 *  through `onLost` so the caller can re-mark them dirty. */
function handleWorkerCrash(d: MeshDispatcher, slotIndex: number, kind: 'error' | 'messageerror', ev: unknown): void {
    const slot = d.slots[slotIndex];
    if (!slot) return;
    console.warn(`[mesh-dispatcher] worker slot ${slotIndex} crashed (${kind}); respawning`, ev);

    // Surface lost chunks to the caller (re-dirty), drop dedup entries.
    for (const entry of slot.inFlight) {
        const tracked = d.inFlightByChunk.get(entry.chunkKey);
        if (tracked && tracked.slot === slotIndex && tracked.gen === entry.gen) {
            d.inFlightByChunk.delete(entry.chunkKey);
        }
        d.onLost?.(entry.chunkKey);
    }

    // Replenish pool, the in-flight buffer sets are gone with the crash.
    for (let i = 0; i < slot.inFlight.length; i++) {
        d.jobBufferPool.push(allocateJobBuffers());
    }
    slot.inFlight.length = 0;

    // Tear down the crashed worker and spawn a fresh one. Re-init with
    // the canonical registry buffer if we have one; until ack lands the
    // slot is dispatch-ineligible (same as boot).
    slot.worker.onmessage = null;
    slot.worker.terminate?.();
    const fresh = d.workerFactory();
    slot.worker = fresh;
    slot.registryVersion = -1;
    slot.pendingRegistryVersion = -1;
    wireWorker(d, slotIndex, fresh);

    if (d.registryBuf !== null) {
        const buf = d.registryBuf.slice(0);
        slot.pendingRegistryVersion = d.registryVersion;
        fresh.postMessage({ cmd: 'initRegistry', version: d.registryVersion, buf }, [buf]);
    }
}

export function setMeshRegistry(d: MeshDispatcher, reg: BlockRegistry): void {
    d.registryVersion += 1;
    const version = d.registryVersion;
    d.registryBuf = serializeBlockRegistryForWorker(reg, version);

    // Per-slot copy, postMessage transfer detaches the buffer, can't
    // ship one buffer to N workers. `.slice()` is a flat memcpy of
    // ~MB-scale buffers, ~ms one-shot; fine for boot/rebuild.
    for (let i = 0; i < d.slots.length; i++) {
        const slot = d.slots[i]!;
        const buf = d.registryBuf.slice(0);
        slot.pendingRegistryVersion = version;
        slot.worker.postMessage({ cmd: 'initRegistry', version, buf }, [buf]);
    }
}

/** caller asks "is this chunk already being meshed?". The voxel-visuals
 *  loop uses this to skip enqueueing chunks that have a stale or fresh
 *  job in flight. */
export function isInFlight(d: MeshDispatcher, key: string): boolean {
    return d.inFlightByChunk.has(key);
}

/** try to dispatch a mesh job for `chunk`. Returns true on success;
 *  false if no eligible slot has queue capacity, or the job buffer pool
 *  is exhausted, or the chunk is already in flight. */
export function enqueueMesh(d: MeshDispatcher, voxels: Voxels, chunk: Chunk, gen: number): boolean {
    const key = chunkKey(chunk.cx, chunk.cy, chunk.cz);
    if (d.inFlightByChunk.has(key)) return false;

    // Find a dispatch-eligible slot with the shortest queue (load
    // balance). Eligible = acked at current registry version AND queue
    // not full.
    let chosen = -1;
    let chosenLen = d.queueDepth;
    for (let i = 0; i < d.slots.length; i++) {
        const s = d.slots[i]!;
        if (s.registryVersion !== d.registryVersion) continue;
        if (s.pendingRegistryVersion !== d.registryVersion) continue;
        if (s.inFlight.length < chosenLen) {
            chosen = i;
            chosenLen = s.inFlight.length;
        }
    }
    if (chosen === -1) return false;

    const set = d.jobBufferPool.pop();
    if (set === undefined) return false;

    buildSlabsIntoBuffers(voxels, chunk, set.blocksBuf, set.lightBuf);

    const slot = d.slots[chosen]!;
    slot.inFlight.push({ chunkKey: key, gen });
    d.inFlightByChunk.set(key, { slot: chosen, gen });

    const msg: MeshWorkerInMsg = {
        cmd: 'mesh',
        chunkKey: key,
        gen,
        cx: chunk.cx,
        cy: chunk.cy,
        cz: chunk.cz,
        blocksBuf: set.blocksBuf,
        lightBuf: set.lightBuf,
        opaqueBuf: set.opaqueBuf,
        transparentBuf: set.transparentBuf,
        translucentBuf: set.translucentBuf,
    };
    slot.worker.postMessage(msg, [set.blocksBuf, set.lightBuf, set.opaqueBuf, set.transparentBuf, set.translucentBuf]);
    return true;
}

function handleWorkerMessage(d: MeshDispatcher, slotIndex: number, msg: MeshWorkerOutMsg): void {
    const slot = d.slots[slotIndex]!;
    if (msg.cmd === 'initRegistryAck') {
        slot.registryVersion = msg.version;
        return;
    }
    if (msg.cmd === 'result') {
        // Find and remove the matching in-flight entry. Workers process
        // FIFO so usually it's at index 0, but a stale-result scenario
        // could surface it elsewhere, splice by chunkKey, not by
        // position.
        const idx = slot.inFlight.findIndex((e) => e.chunkKey === msg.chunkKey && e.gen === msg.gen);
        if (idx >= 0) slot.inFlight.splice(idx, 1);

        // Clear the global dedup entry only if it matches the gen we
        // just got. (In practice nothing else writes to this map
        // concurrently, we're single-threaded on main, so this is
        // belt-and-braces.)
        const tracked = d.inFlightByChunk.get(msg.chunkKey);
        if (tracked && tracked.gen === msg.gen) d.inFlightByChunk.delete(msg.chunkKey);

        // Recycle the full buffer set back to the pool unconditionally.
        d.jobBufferPool.push(msg.recycle);

        // Forward the result. Caller's gen guard handles staleness;
        // dispatcher is just the transport.
        d.onResult({
            chunkKey: msg.chunkKey,
            gen: msg.gen,
            opaque: msg.opaque,
            transparent: msg.transparent,
            translucent: msg.translucent,
            aabb: msg.aabb,
        });
        return;
    }
}

export function disposeMeshDispatcher(d: MeshDispatcher): void {
    for (const slot of d.slots) {
        slot.worker.onmessage = null;
        slot.worker.terminate?.();
    }
    d.slots.length = 0;
    d.jobBufferPool.length = 0;
    d.inFlightByChunk.clear();
    d.registryBuf = null;
}

/** test-only inspection helpers, kept on the public surface because
 *  they're how the dispatcher test verifies invariants (slot queue
 *  depth, pool size). Cheap O(slots) reads, no internal state changes. */
export function dispatcherStats(d: MeshDispatcher): {
    poolSize: number;
    inFlightTotal: number;
    perSlot: Array<{ inFlight: number; registryVersion: number; pendingRegistryVersion: number }>;
} {
    return {
        poolSize: d.jobBufferPool.length,
        inFlightTotal: d.inFlightByChunk.size,
        perSlot: d.slots.map((s) => ({
            inFlight: s.inFlight.length,
            registryVersion: s.registryVersion,
            pendingRegistryVersion: s.pendingRegistryVersion,
        })),
    };
}
