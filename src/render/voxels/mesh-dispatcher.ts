// ── mesh dispatcher ────────────────────────────────────────────────
//
// Owns the worker pool that runs `meshChunk` off the main thread. Each
// worker holds its own deserialized BlockRegistry; main thread keeps a
// canonical serialized buffer and reslices it per worker on rebuild.
//
// Scheduling model:
//   - N workers. queueMesh accumulates chunks into per-slot `pending`; a
//     frame-end flush drains each slot's pending into ONE batched packet, so a
//     worker meshing K chunks costs a single postMessage, not K.
//   - Two priority tiers: `pendingUrgent` (near-camera / just-edited) drains
//     before `pending` and leads the packet, and urgent enqueue bypasses the
//     queueDepth gate — an edit-in-front-of-you never waits behind streaming
//     backlog. This replaces the old main-thread sync-remesh fast-path.
//   - Affinity routing: a chunk's jobs always go to `hash(region) % N`, so its
//     neighbourhood accumulates in that worker's cache and re-meshes hit it.
//   - Each worker keeps a versioned chunk mirror; main tracks a matching
//     per-worker mirror (`slot.mirror`) and dispatches only DELTAS: a packet
//     carries `set` (chunks the worker lacks at the current version) + `delete`
//     + `tasks` (the batch). Unchanged chunks are never re-sent. See
//     mesh-tasks.ts and llm/plan-mesh-worker-chunk-cache.md.
//   - inFlightByChunk dedups: a chunk pending or in flight cannot be re-enqueued.
//   - Buffers come from two pools: `packetPool` (one packet buffer per batch)
//     and `outputPool` (one 3-buffer quad set per task). Borrowed at flush,
//     transferred to the worker, echoed back in the result `recycle`.
//   - Generation guard: caller passes chunk.meshGen into enqueue. Worker
//     echoes it. Caller decides whether the result is fresh.
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
import { type ChunkMeshResult, MAX_QUADS_PER_PASS, QUAD_STRIDE_U32S } from '../../core/voxels/chunk-mesher';
import { MESH_TASKS_SCRATCH_BYTES, type MeshTaskSet, packMeshTasks } from '../../core/voxels/mesh-tasks';
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

/** one chunk's output quad buffers (one per pass). Borrowed per task from the
 *  output pool, transferred to the worker, echoed back for recycling. */
type MeshOutputSet = {
    opaqueBuf: ArrayBuffer;
    transparentBuf: ArrayBuffer;
    translucentBuf: ArrayBuffer;
};

const PASS_BUF_BYTES = MAX_QUADS_PER_PASS * QUAD_STRIDE_U32S * 4;

type WorkerSlot = {
    worker: WorkerLike;
    /** high-priority chunks (near the camera / just edited). Drained before
     *  `pending` and placed at the front of the batch packet so the worker meshes
     *  them first. Urgent enqueue bypasses the queueDepth gate — the whole point
     *  is that an edit-in-front-of-you never waits behind streaming backlog. */
    pendingUrgent: Array<{ chunk: Chunk; gen: number }>;
    /** normal-priority chunks routed here this/last frame, accumulated by
     *  queueMesh and drained into batch packets by flushMeshQueue. */
    pending: Array<{ chunk: Chunk; gen: number }>;
    /** in-flight job keys at this slot (across all in-flight batches), spliced
     *  out by chunkKey when the matching result lands. Bounded by `queueDepth`. */
    inFlight: Array<{ chunkKey: string; gen: number }>;
    /** in-flight batches (packets posted, results pending) — packet buffers to
     *  replenish on crash. */
    inFlightBatches: number;
    /** version this slot has acked. Slot is ineligible for dispatch
     *  until this equals `MeshDispatcher.registryVersion`. */
    registryVersion: number;
    /** version most recently posted to this slot. Used to detect
     *  "init pending but not yet acked". */
    pendingRegistryVersion: number;
    /** authoritative mirror of this worker's chunk cache: chunkKey → chunk
     *  `version`. main diffs each dispatch against it to emit set/delete deltas.
     *  cleared on crash (the worker's cache is gone with it). */
    mirror: Map<string, number>;
};

export type MeshDispatcher = {
    slots: WorkerSlot[];
    queueDepth: number;
    /** chunk key → which slot owns it. Tracks a chunk from enqueue (pending)
     *  through in-flight, for dedup and reverse lookup on result. */
    inFlightByChunk: Map<string, { slot: number; gen: number }>;
    /** free packet buffers (one per in-flight batch). */
    packetPool: ArrayBuffer[];
    /** free output-buffer sets (one per in-flight task). */
    outputPool: MeshOutputSet[];
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
    /** per-worker chunk-cache budget: main evicts LRU mirror entries beyond it. */
    cacheMaxChunks: number;
    /** per-frame instrumentation, summed as jobs flow, drained by
     *  `readMeshPerf`. `buildMs`/`postMs` are main-thread slab-pack and
     *  postMessage cost; `workUs` is worker-reported job time; counts let
     *  you see posts-per-frame. See readMeshPerf. */
    perf: MeshPerf;
};

export type MeshPerf = {
    /** main-thread ms spent packing the MeshTasks packet (packInto) */
    buildMs: number;
    /** main-thread ms spent in postMessage (envelope + transfer) */
    postMs: number;
    /** worker-reported µs of mesh work (parallel, not main-thread) */
    workUs: number;
    /** main→worker posts (one per batch — the metric batching drives down) */
    enqueues: number;
    /** worker→main result messages drained (one per batch) */
    results: number;
};

export type MeshDispatcherOpts = {
    /** factory called once per worker slot at construction. */
    workerFactory: () => WorkerLike;
    workerCount: number;
    queueDepth: number;
    /** per-worker chunk-cache budget (chunks). ~16 KB each. defaults to 256 (~4 MB). */
    cacheMaxChunks?: number;
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
        packetPool: [],
        outputPool: [],
        registryVersion: -1,
        registryBuf: null,
        onResult: opts.onResult,
        onLost: opts.onLost ?? null,
        workerFactory: opts.workerFactory,
        cacheMaxChunks: opts.cacheMaxChunks ?? 256,
        perf: { buildMs: 0, postMs: 0, workUs: 0, enqueues: 0, results: 0 },
    };

    // output sets: one per in-flight task. Sized workerCount × queueDepth for the
    // normal tier, plus URGENT_RESERVE_PER_WORKER of headroom per worker so an
    // urgent chunk (which bypasses the queueDepth gate) can always claim a buffer.
    // packet buffers: one per in-flight batch; 2 per worker allows a batch to be
    // recycling while the next flushes. Urgent rides the same batch as normal, so
    // it needs no extra packet buffers.
    for (let i = 0; i < opts.workerCount * (opts.queueDepth + URGENT_RESERVE_PER_WORKER); i++)
        d.outputPool.push(allocateOutputSet());
    for (let i = 0; i < opts.workerCount * 2; i++) d.packetPool.push(new ArrayBuffer(MESH_TASKS_SCRATCH_BYTES));

    for (let i = 0; i < opts.workerCount; i++) {
        const worker = opts.workerFactory();
        const slot: WorkerSlot = {
            worker,
            pendingUrgent: [],
            pending: [],
            inFlight: [],
            inFlightBatches: 0,
            registryVersion: -1,
            pendingRegistryVersion: -1,
            mirror: new Map(),
        };
        wireWorker(d, i, worker);
        slots.push(slot);
    }

    return d;
}

function allocateOutputSet(): MeshOutputSet {
    return {
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

    // Replenish pools, the in-flight buffers are gone with the crash: one
    // packet buffer per in-flight batch, one output set per in-flight task.
    for (let i = 0; i < slot.inFlightBatches; i++) d.packetPool.push(new ArrayBuffer(MESH_TASKS_SCRATCH_BYTES));
    for (let i = 0; i < slot.inFlight.length; i++) d.outputPool.push(allocateOutputSet());
    slot.inFlight.length = 0;
    slot.inFlightBatches = 0;

    // The respawned worker starts with an empty cache, so drop the mirror —
    // subsequent dispatches re-`set` the neighbourhood from scratch.
    slot.mirror.clear();

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

// worker affinity: a chunk's tasks always route to the same worker (by region
// hash), so its neighbourhood accumulates in that worker's cache and re-meshes
// hit it. deterministic + stable across respawns (slot index is fixed).
const MESH_REGION_BITS = 3; // region = 8 chunks per axis

function affinityWorker(cx: number, cy: number, cz: number, n: number): number {
    const rx = cx >> MESH_REGION_BITS;
    const ry = cy >> MESH_REGION_BITS;
    const rz = cz >> MESH_REGION_BITS;
    const h = (Math.imul(rx, 73856093) ^ Math.imul(ry, 19349663) ^ Math.imul(rz, 83492791)) | 0;
    return ((h % n) + n) % n;
}

/** max tasks per batch packet. bounds message size and keeps a cold batch's
 *  set-union under the packet scratch. (In-flight is already ≤ queueDepth/slot.) */
const MESH_BATCH_MAX = 8;

/** extra output-buffer sets reserved per worker beyond queueDepth, so urgent
 *  chunks (which bypass the queueDepth gate) always find a free buffer at flush. */
const URGENT_RESERVE_PER_WORKER = 2;

/** the batch being assembled this flush, urgent entries first then normal. reused
 *  scratch so composing a batch allocates nothing. */
const _batch: Array<{ chunk: Chunk; gen: number }> = [];

// reused packcat value scratch (avoids allocating it each flush). the set/delete
// key arrays parallel the entries so the mirror commit can be deferred until
// packInto succeeds.
const _setEntries: MeshTaskSet[] = [];
const _setKeys: string[] = [];
const _delEntries: Array<{ cx: number; cy: number; cz: number }> = [];
const _delKeys: string[] = [];
const _tasks: Array<{ cx: number; cy: number; cz: number; gen: number }> = [];
const _packetValue = { set: _setEntries, delete: _delEntries, tasks: _tasks };
const _neighborhoodKeys = new Set<string>();

function slotAcceptable(d: MeshDispatcher, slot: WorkerSlot): boolean {
    return (
        slot.registryVersion === d.registryVersion &&
        slot.pendingRegistryVersion === d.registryVersion &&
        slot.pending.length + slot.inFlight.length < d.queueDepth
    );
}

/** accept `chunk` for meshing. Routes to its affinity worker (warm cache) and
 *  accumulates into that worker's pending list; `flushMeshQueue` builds and
 *  posts the batch. Returns false if no worker can take it or the chunk is already
 *  claimed. Options:
 *   - `urgent`: high priority (near-camera / just-edited). Bypasses the queueDepth
 *     gate and joins `pendingUrgent`, drained first — it never waits behind
 *     streaming backlog. Still requires the affinity worker to be registry-acked.
 *   - `allowSpill`: normal-tier only. If the affinity worker is full, offload to
 *     the least-committed ready worker (used when the chunk has been starving). */
export function queueMesh(
    d: MeshDispatcher,
    _voxels: Voxels,
    chunk: Chunk,
    gen: number,
    opts: { urgent?: boolean; allowSpill?: boolean } = {},
): boolean {
    const key = chunkKey(chunk.cx, chunk.cy, chunk.cz);
    if (d.inFlightByChunk.has(key)) return false;

    let chosen = affinityWorker(chunk.cx, chunk.cy, chunk.cz, d.slots.length);
    let slot = d.slots[chosen]!;

    if (opts.urgent) {
        // urgent bypasses the queueDepth gate but still needs a registry-acked
        // slot (can't mesh without the registry). If the affinity worker isn't
        // acked yet (boot / post-crash respawn), leave it dirty to retry.
        if (slot.registryVersion !== d.registryVersion || slot.pendingRegistryVersion !== d.registryVersion) return false;
        slot.pendingUrgent.push({ chunk, gen });
        d.inFlightByChunk.set(key, { slot: chosen, gen });
        return true;
    }

    if (!slotAcceptable(d, slot)) {
        if (!opts.allowSpill) return false;
        chosen = -1;
        let best = d.queueDepth;
        for (let i = 0; i < d.slots.length; i++) {
            const s = d.slots[i]!;
            const claimed = s.pending.length + s.inFlight.length;
            if (slotAcceptable(d, s) && claimed < best) {
                chosen = i;
                best = claimed;
            }
        }
        if (chosen === -1) return false;
        slot = d.slots[chosen]!;
    }

    slot.pending.push({ chunk, gen });
    d.inFlightByChunk.set(key, { slot: chosen, gen });
    return true;
}

/** diff the union of the first `batchN` chunks in `_batch` (urgent-first) against
 *  `slot.mirror` → set/delete deltas (into scratch), + LRU eviction, then packInto
 *  `packetBuf`. Does NOT commit the mirror (deferred to `commitBatch` on success).
 *  Returns packcat's {ok, size}. */
function buildBatchPacket(d: MeshDispatcher, slot: WorkerSlot, voxels: Voxels, batchN: number, packetBuf: ArrayBuffer): boolean {
    _setEntries.length = 0;
    _setKeys.length = 0;
    _delEntries.length = 0;
    _delKeys.length = 0;
    _tasks.length = 0;
    _neighborhoodKeys.clear();
    const mirror = slot.mirror;
    let newSets = 0;
    for (let t = 0; t < batchN; t++) {
        const { chunk, gen } = _batch[t]!;
        _tasks.push({ cx: chunk.cx, cy: chunk.cy, cz: chunk.cz, gen });
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const ncx = chunk.cx + dx;
                    const ncy = chunk.cy + dy;
                    const ncz = chunk.cz + dz;
                    const nk = chunkKey(ncx, ncy, ncz);
                    if (_neighborhoodKeys.has(nk)) continue; // union dedup across the batch
                    _neighborhoodKeys.add(nk);
                    const nc = voxels.chunks.get(nk);
                    if (nc !== undefined) {
                        const mv = mirror.get(nk);
                        if (mv !== nc.version) {
                            _setEntries.push({
                                cx: nc.cx,
                                cy: nc.cy,
                                cz: nc.cz,
                                version: nc.version,
                                data: nc.data,
                                light: nc.light,
                                palette: nc.palette,
                            });
                            _setKeys.push(nk);
                            if (mv === undefined) newSets++;
                        }
                    } else if (mirror.has(nk)) {
                        _delEntries.push({ cx: ncx, cy: ncy, cz: ncz });
                        _delKeys.push(nk);
                    }
                }
            }
        }
    }

    // bound the mirror to the budget: evict oldest entries not in this batch's
    // neighbourhood; evictions ride the delete list.
    let evict = mirror.size + newSets - _delKeys.length - d.cacheMaxChunks;
    if (evict > 0) {
        for (const k of mirror.keys()) {
            if (evict <= 0) break;
            if (_neighborhoodKeys.has(k)) continue;
            const c1 = k.indexOf(',');
            const c2 = k.indexOf(',', c1 + 1);
            _delEntries.push({ cx: +k.slice(0, c1), cy: +k.slice(c1 + 1, c2), cz: +k.slice(c2 + 1) });
            _delKeys.push(k);
            evict--;
        }
    }

    return packMeshTasks(_packetValue, new Uint8Array(packetBuf), 0).ok;
}

/** commit the scratch deltas from the last successful `buildBatchPacket` to the
 *  mirror. deletes first, then sets re-inserted at the Map tail for LRU recency. */
function commitBatch(slot: WorkerSlot): void {
    const mirror = slot.mirror;
    for (let i = 0; i < _delKeys.length; i++) mirror.delete(_delKeys[i]!);
    for (let i = 0; i < _setKeys.length; i++) {
        const k = _setKeys[i]!;
        mirror.delete(k);
        mirror.set(k, _setEntries[i]!.version);
    }
}

/** build + post one batch for `slot` from its pending queues (urgent first), if it
 *  has pending work and a packet + output buffers are free. */
function flushSlot(d: MeshDispatcher, slotIndex: number, voxels: Voxels): void {
    const slot = d.slots[slotIndex]!;
    const total = slot.pendingUrgent.length + slot.pending.length;
    if (total === 0) return;
    if (slot.registryVersion !== d.registryVersion || slot.pendingRegistryVersion !== d.registryVersion) return;
    if (d.packetPool.length === 0 || d.outputPool.length === 0) return;

    let batchN = Math.min(total, d.outputPool.length, MESH_BATCH_MAX);
    // compose the batch urgent-first so those chunks lead the packet (the worker
    // meshes tasks in array order) and survive the overflow-halving below.
    _batch.length = 0;
    for (let i = 0; i < slot.pendingUrgent.length && _batch.length < batchN; i++) _batch.push(slot.pendingUrgent[i]!);
    for (let i = 0; i < slot.pending.length && _batch.length < batchN; i++) _batch.push(slot.pending[i]!);

    const packetBuf = d.packetPool[d.packetPool.length - 1]!;

    const tBuild = performance.now();
    // pack, halving the batch on overflow (a single task always fits: ≤27 chunks).
    while (!buildBatchPacket(d, slot, voxels, batchN, packetBuf) && batchN > 1) batchN = batchN >> 1;
    // (batchN === 1 is guaranteed to fit, so the loop leaves us with a valid pack)

    d.packetPool.pop();
    commitBatch(slot);

    const outBufs: ArrayBuffer[] = [];
    for (let i = 0; i < batchN; i++) {
        const out = d.outputPool.pop()!;
        outBufs.push(out.opaqueBuf, out.transparentBuf, out.translucentBuf);
        const p = _batch[i]!;
        slot.inFlight.push({ chunkKey: chunkKey(p.chunk.cx, p.chunk.cy, p.chunk.cz), gen: p.gen });
    }
    // remove the consumed entries: urgent are at the front of `_batch`, so the
    // first min(pendingUrgent, batchN) come off pendingUrgent, the rest off pending.
    const urgentTaken = Math.min(slot.pendingUrgent.length, batchN);
    slot.pendingUrgent.splice(0, urgentTaken);
    slot.pending.splice(0, batchN - urgentTaken);
    slot.inFlightBatches++;

    const tPost = performance.now();
    slot.worker.postMessage({ cmd: 'meshTasks', packetBuf, outBufs }, [packetBuf, ...outBufs]);
    const tEnd = performance.now();
    d.perf.buildMs += tPost - tBuild;
    d.perf.postMs += tEnd - tPost;
    d.perf.enqueues++;
}

/** build + post batches for every worker with pending work. Called once per
 *  frame after the enqueue loop — and, crucially, after the caller has drained
 *  the previous frame's results, so buffers recycled on result are safe to
 *  reuse here (the pending result that referenced them is already copied out). */
export function flushMeshQueue(d: MeshDispatcher, voxels: Voxels): void {
    for (let i = 0; i < d.slots.length; i++) flushSlot(d, i, voxels);
}

function handleWorkerMessage(d: MeshDispatcher, slotIndex: number, msg: MeshWorkerOutMsg): void {
    const slot = d.slots[slotIndex]!;
    if (msg.cmd === 'initRegistryAck') {
        slot.registryVersion = msg.version;
        return;
    }
    if (msg.cmd === 'result') {
        d.perf.workUs += msg.workUs;
        d.perf.results++;
        slot.inFlightBatches--;

        // recycle the packet buffer + every task's output set.
        d.packetPool.push(msg.recycle.packetBuf);
        const outBufs = msg.recycle.outBufs;
        for (let i = 0; i < outBufs.length; i += 3) {
            d.outputPool.push({ opaqueBuf: outBufs[i]!, transparentBuf: outBufs[i + 1]!, translucentBuf: outBufs[i + 2]! });
        }

        for (const r of msg.results) {
            // remove the matching in-flight entry + dedup record (splice by key,
            // FIFO usually puts it at 0 but a stale-gen result could differ).
            const idx = slot.inFlight.findIndex((e) => e.chunkKey === r.chunkKey && e.gen === r.gen);
            if (idx >= 0) slot.inFlight.splice(idx, 1);
            const tracked = d.inFlightByChunk.get(r.chunkKey);
            if (tracked && tracked.gen === r.gen) d.inFlightByChunk.delete(r.chunkKey);

            // forward the result; caller's gen guard handles staleness.
            d.onResult({
                chunkKey: r.chunkKey,
                gen: r.gen,
                opaque: r.opaque,
                transparent: r.transparent,
                translucent: r.translucent,
                aabb: r.aabb,
            });
        }

        // NB: do NOT refill the slot here. The output buffers were just recycled
        // to the pool, but the results referencing them sit in the caller's queue
        // until it drains them next `update()`. Refilling now would transfer those
        // buffers back to the worker mid-flight and detach them out from under the
        // pending result. The next `flushMeshQueue` refills safely — it runs
        // after the caller has drained (copied out of) this frame's results.
        return;
    }
}

/** read the accumulated per-frame mesh perf counters and reset them. call
 *  once per frame (e.g. from voxel-visuals.update) to get the main-thread
 *  slab-pack vs postMessage split, worker time, and posts-per-frame:
 *
 *    const p = readMeshPerf(dispatcher);
 *    // p.buildMs + p.postMs = main-thread enqueue cost this frame
 *    // p.enqueues = posts main→worker, p.results = posts worker→main
 *    // p.workUs = parallel worker time (not main-thread)
 */
export function readMeshPerf(d: MeshDispatcher): MeshPerf {
    const p = d.perf;
    d.perf = { buildMs: 0, postMs: 0, workUs: 0, enqueues: 0, results: 0 };
    return p;
}

export function disposeMeshDispatcher(d: MeshDispatcher): void {
    for (const slot of d.slots) {
        slot.worker.onmessage = null;
        slot.worker.terminate?.();
    }
    d.slots.length = 0;
    d.packetPool.length = 0;
    d.outputPool.length = 0;
    d.inFlightByChunk.clear();
    d.registryBuf = null;
}

/** test-only inspection helpers, kept on the public surface because
 *  they're how the dispatcher test verifies invariants (slot queue
 *  depth, pool size). Cheap O(slots) reads, no internal state changes. */
export function meshQueueStats(d: MeshDispatcher): {
    poolSize: number;
    inFlightTotal: number;
    perSlot: Array<{
        pendingUrgent: number;
        pending: number;
        inFlight: number;
        registryVersion: number;
        pendingRegistryVersion: number;
        mirrorSize: number;
    }>;
} {
    return {
        poolSize: d.outputPool.length,
        inFlightTotal: d.inFlightByChunk.size,
        perSlot: d.slots.map((s) => ({
            pendingUrgent: s.pendingUrgent.length,
            pending: s.pending.length,
            inFlight: s.inFlight.length,
            registryVersion: s.registryVersion,
            pendingRegistryVersion: s.pendingRegistryVersion,
            mirrorSize: s.mirror.size,
        })),
    };
}
