// ── mesher ─────────────────────────────────────────────────────────
//
// A worker pool that meshes voxel chunks off the main thread, plus the loader
// for the worker bundle itself (`loadMeshWorker` / the `?worker&inline` import).
// It is a pure data primitive: you `queueMesh` chunks and `flushMeshQueue` once
// per frame, then drain the `results` and `lost` queues it fills. No callbacks —
// the caller pulls, the caller decides.
//
// One world at a time. Caches key on bare chunk coordinate, so a room swap must
// `resetMeshCaches` before the next world reuses the old world's coordinates.
//
// How work flows:
//   - Affinity: a chunk always routes to `hash(region) % N`, so its
//     neighbourhood warms one worker's cache and re-meshes hit it.
//   - Batching: per-slot `pending` accumulates across a frame; one flush posts
//     the whole slot as a single packet (K chunks, one postMessage).
//   - Priority: `pendingUrgent` (near-camera / just-edited) drains first, leads
//     the packet, and skips the queueDepth gate — an edit never waits behind
//     streaming backlog.
//   - Deltas: each worker holds a versioned chunk cache; `cachedVersions` is
//     main's model of it. A packet ships only the diff — `set` (chunks the
//     worker lacks) + `delete` + the `tasks` batch. See mesh-tasks.ts and
//     llm/plan-mesh-worker-chunk-cache.md.
//   - Dedup: `inFlightByChunk` blocks re-enqueue of a pending/in-flight chunk.
//   - Buffers: `packetPool` (one per batch) + `outputPool` (one quad set per
//     task) are borrowed at flush, transferred out, echoed back to recycle.
//   - Generation: the caller's `chunk.meshGen` rides the job and comes back on
//     the result, so the caller can drop stale meshes.
//
// Registry handshake: `setMeshRegistry` serializes once, posts a per-slot copy,
// and bumps `pendingRegistryVersion`. A slot dispatches only once its ack lands
// (`registryVersion === dispatcher.registryVersion`); in-flight old-version jobs
// still complete and the gen guard sorts them out.

import type { Blocks } from '../../core/voxels/block-registry';
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
export type WorkerLike = {
    postMessage(msg: MeshWorkerInMsg, transfer?: Transferable[]): void;
    onmessage: ((e: MessageEvent<MeshWorkerOutMsg>) => void) | null;
    onerror?: ((ev: unknown) => void) | null;
    onmessageerror?: ((ev: unknown) => void) | null;
    terminate?(): void;
};

/**
 * The mesh worker constructor, loaded from the `?worker&inline` bundle. The import is DYNAMIC so the
 * Vite query never enters this module's STATIC import graph: the bongle asset pipeline walks `mesher.ts`
 * (its runtime can't strip Vite query suffixes) but always sets workerCount=0, so it never calls
 * loadMeshWorker() and the query is never resolved. Under Vite the query inlines the worker as a base64
 * blob — no separate chunk, no cross-origin Worker construction (the deployed client iframe runs at
 * origin='null'). Cached after the first load so boot + crash-respawn construct synchronously.
 */
let MeshWorkerCtor: (new () => WorkerLike) | null = null;

/** Load the mesh worker bundle. Await once (from `voxel-resources.load`) before creating a worker-backed
 *  dispatcher; a no-op after the first call. */
export async function loadMeshWorker(): Promise<void> {
    if (MeshWorkerCtor === null) {
        const mod = await import('./mesher.worker?worker&inline');
        MeshWorkerCtor = mod.default as unknown as new () => WorkerLike;
    }
}

/** Default worker spawn: construct one from the loaded bundle. `MeshDispatcherOpts.workerFactory`
 *  overrides it (the unit test injects a MessageChannel-backed fake). */
function spawnMeshWorker(): WorkerLike {
    if (MeshWorkerCtor === null) {
        throw new Error('[mesher] await loadMeshWorker() before creating a worker-backed dispatcher');
    }
    return new MeshWorkerCtor();
}

/** a finished job, pushed onto `dispatcher.results`. The `ChunkMeshResult`
 *  payload (three PassMesh + AABB) matches the sync `meshChunk` path; `chunkKey`
 *  + `gen` let the caller match it to a chunk and drop stale meshes. PassMesh
 *  buffers are backed by transferred ArrayBuffers, see mesh-worker.ts. */
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
    /** priority chunks: drained first and lead the packet, skip the queueDepth gate. */
    pendingUrgent: Array<{ chunk: Chunk; gen: number }>;
    /** normal chunks accumulating for the next flush. */
    pending: Array<{ chunk: Chunk; gen: number }>;
    /** job keys posted but not yet resulted, spliced by chunkKey on result. Bounded by queueDepth. */
    inFlight: Array<{ chunkKey: string; gen: number }>;
    /** posted-but-unresulted packet count; how many packet buffers to replenish on crash. */
    inFlightBatches: number;
    /** registry version this slot has acked; dispatch-eligible only when it equals the dispatcher's. */
    registryVersion: number;
    /** registry version last posted here; a gap vs `registryVersion` means an init is pending. */
    pendingRegistryVersion: number;
    /** main's model of the worker's cache (chunkKey -> version) to diff dispatches into set/delete
     *  deltas. Cleared on crash and on `resetMeshCaches`, whenever the worker's real cache is gone. */
    cachedVersions: Map<string, number>;
};

export type MeshDispatcher = {
    slots: WorkerSlot[];
    queueDepth: number;
    /** chunk key -> owning slot, from enqueue through in-flight; for dedup and result lookup. */
    inFlightByChunk: Map<string, { slot: number; gen: number }>;
    /** finished meshes awaiting the caller. The caller drains this each frame and clears it. */
    results: MeshDispatcherResult[];
    /** chunk keys lost to a worker crash, awaiting the caller. Drain each frame to re-dirty them,
     *  then clear; the dispatcher has already respawned the worker and replenished the pools. */
    lost: string[];
    /** free packet buffers (one per in-flight batch). */
    packetPool: ArrayBuffer[];
    /** free output-buffer sets (one per in-flight task). */
    outputPool: MeshOutputSet[];
    registryVersion: number;
    /** canonical serialized registry, kept so a respawned worker re-inits without re-encoding. */
    registryBuf: ArrayBuffer | null;
    /** spawns a worker for a slot; called at boot and on crash respawn. */
    spawn: () => WorkerLike;
    /** per-worker chunk-cache budget; LRU entries beyond it are evicted. */
    cacheMaxChunks: number;
    /** per-frame instrumentation, drained by `readMeshPerf`. */
    perf: MeshPerf;
};

export type MeshPerf = {
    /** main-thread ms spent packing the MeshTasks packet (packInto) */
    buildMs: number;
    /** main-thread ms spent in postMessage (envelope + transfer) */
    postMs: number;
    /** worker-reported µs of mesh work (parallel, not main-thread) */
    workUs: number;
    /** main->worker posts (one per batch — the metric batching drives down) */
    enqueues: number;
    /** worker->main result messages drained (one per batch) */
    results: number;
};

export type MeshDispatcherOpts = {
    /** override the worker spawn (the unit test injects a fake). Defaults to constructing the
     *  `?worker&inline` bundle loaded by {@link loadMeshWorker}. */
    workerFactory?: () => WorkerLike;
    workerCount: number;
    queueDepth: number;
    /** per-worker chunk-cache budget (chunks). ~16 KB each. defaults to 256 (~4 MB). */
    cacheMaxChunks?: number;
};

export function createMeshDispatcher(opts: MeshDispatcherOpts): MeshDispatcher {
    const slots: WorkerSlot[] = [];
    const spawn = opts.workerFactory ?? spawnMeshWorker;
    const d: MeshDispatcher = {
        slots,
        queueDepth: opts.queueDepth,
        inFlightByChunk: new Map(),
        results: [],
        lost: [],
        packetPool: [],
        outputPool: [],
        registryVersion: -1,
        registryBuf: null,
        spawn,
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
        const worker = spawn();
        const slot: WorkerSlot = {
            worker,
            pendingUrgent: [],
            pending: [],
            inFlight: [],
            inFlightBatches: 0,
            registryVersion: -1,
            pendingRegistryVersion: -1,
            cachedVersions: new Map(),
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
    console.warn(`[mesher] worker slot ${slotIndex} crashed (${kind}); respawning`, ev);

    // Queue lost chunks for the caller to re-dirty; drop their dedup entries.
    for (const entry of slot.inFlight) {
        const tracked = d.inFlightByChunk.get(entry.chunkKey);
        if (tracked && tracked.slot === slotIndex && tracked.gen === entry.gen) {
            d.inFlightByChunk.delete(entry.chunkKey);
        }
        d.lost.push(entry.chunkKey);
    }

    // Replenish pools, the in-flight buffers are gone with the crash: one
    // packet buffer per in-flight batch, one output set per in-flight task.
    for (let i = 0; i < slot.inFlightBatches; i++) d.packetPool.push(new ArrayBuffer(MESH_TASKS_SCRATCH_BYTES));
    for (let i = 0; i < slot.inFlight.length; i++) d.outputPool.push(allocateOutputSet());
    slot.inFlight.length = 0;
    slot.inFlightBatches = 0;

    // The respawned worker starts with an empty cache, so drop our model of it —
    // subsequent dispatches re-`set` the neighbourhood from scratch.
    slot.cachedVersions.clear();

    // Tear down the crashed worker and spawn a fresh one. Re-init with
    // the canonical registry buffer if we have one; until ack lands the
    // slot is dispatch-ineligible (same as boot).
    slot.worker.onmessage = null;
    slot.worker.terminate?.();
    const fresh = d.spawn();
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

export function setMeshRegistry(d: MeshDispatcher, reg: Blocks): void {
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

/** Invalidate every per-worker chunk cache and drop all queued / in-flight
 *  tracking. Call on an active-room swap: the dispatcher + worker caches are
 *  keyed by bare chunk coordinate, so a cached entry from the room being left
 *  would be reused to mesh the newly-active room's chunk at the same coordinate
 *  (their per-chunk `version` counters collide). Posts `clearCache` to each
 *  worker — ordered after any in-flight `meshTasks` and before subsequent ones —
 *  and clears the main-side model + pending queues so the next flush re-sends the
 *  new world's neighbourhoods from scratch. Batches already in flight still land
 *  and recycle their buffers (`inFlightBatches` left intact); the cleared
 *  `inFlightByChunk` + the caller's gen guard drop their now-stale results. */
export function resetMeshCaches(d: MeshDispatcher): void {
    for (const slot of d.slots) {
        slot.pendingUrgent.length = 0;
        slot.pending.length = 0;
        slot.inFlight.length = 0;
        slot.cachedVersions.clear();
        slot.worker.postMessage({ cmd: 'clearCache' });
    }
    d.inFlightByChunk.clear();
    d.results.length = 0;
    d.lost.length = 0;
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
// key arrays parallel the entries so the cache commit can be deferred until
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
 *  `slot.cachedVersions` -> set/delete deltas (into scratch), + LRU eviction, then
 *  packInto `packetBuf`. Does NOT commit (deferred to `commitBatch` on success).
 *  Returns packcat's {ok, size}. */
function buildBatchPacket(d: MeshDispatcher, slot: WorkerSlot, voxels: Voxels, batchN: number, packetBuf: ArrayBuffer): boolean {
    _setEntries.length = 0;
    _setKeys.length = 0;
    _delEntries.length = 0;
    _delKeys.length = 0;
    _tasks.length = 0;
    _neighborhoodKeys.clear();
    const cachedVersions = slot.cachedVersions;
    let newSets = 0;
    for (let t = 0; t < batchN; t++) {
        const { chunk, gen } = _batch[t]!;
        _tasks.push({ cx: chunk.cx, cy: chunk.cy, cz: chunk.cz, gen });
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const neighborCx = chunk.cx + dx;
                    const neighborCy = chunk.cy + dy;
                    const neighborCz = chunk.cz + dz;
                    const neighborKey = chunkKey(neighborCx, neighborCy, neighborCz);
                    if (_neighborhoodKeys.has(neighborKey)) continue; // union dedup across the batch
                    _neighborhoodKeys.add(neighborKey);
                    const neighbor = voxels.chunks.get(neighborKey);
                    if (neighbor !== undefined) {
                        const cachedVersion = cachedVersions.get(neighborKey);
                        if (cachedVersion !== neighbor.version) {
                            _setEntries.push({
                                cx: neighbor.cx,
                                cy: neighbor.cy,
                                cz: neighbor.cz,
                                version: neighbor.version,
                                data: neighbor.data,
                                light: neighbor.light,
                                palette: neighbor.palette,
                            });
                            _setKeys.push(neighborKey);
                            if (cachedVersion === undefined) newSets++;
                        }
                    } else if (cachedVersions.has(neighborKey)) {
                        _delEntries.push({ cx: neighborCx, cy: neighborCy, cz: neighborCz });
                        _delKeys.push(neighborKey);
                    }
                }
            }
        }
    }

    // bound the cache to the budget: evict oldest entries not in this batch's
    // neighbourhood; evictions ride the delete list.
    let evictBudget = cachedVersions.size + newSets - _delKeys.length - d.cacheMaxChunks;
    if (evictBudget > 0) {
        for (const key of cachedVersions.keys()) {
            if (evictBudget <= 0) break;
            if (_neighborhoodKeys.has(key)) continue;
            const firstComma = key.indexOf(',');
            const secondComma = key.indexOf(',', firstComma + 1);
            _delEntries.push({
                cx: +key.slice(0, firstComma),
                cy: +key.slice(firstComma + 1, secondComma),
                cz: +key.slice(secondComma + 1),
            });
            _delKeys.push(key);
            evictBudget--;
        }
    }

    return packMeshTasks(_packetValue, new Uint8Array(packetBuf), 0).ok;
}

/** commit the scratch deltas from the last successful `buildBatchPacket` to our
 *  model of the worker cache. deletes first, then sets re-inserted at the Map tail
 *  for LRU recency. */
function commitBatch(slot: WorkerSlot): void {
    const cachedVersions = slot.cachedVersions;
    for (let i = 0; i < _delKeys.length; i++) cachedVersions.delete(_delKeys[i]!);
    for (let i = 0; i < _setKeys.length; i++) {
        const key = _setKeys[i]!;
        cachedVersions.delete(key);
        cachedVersions.set(key, _setEntries[i]!.version);
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

        for (const result of msg.results) {
            // remove the matching in-flight entry + dedup record (splice by key,
            // FIFO usually puts it at 0 but a stale-gen result could differ).
            const inFlightIndex = slot.inFlight.findIndex((e) => e.chunkKey === result.chunkKey && e.gen === result.gen);
            if (inFlightIndex >= 0) slot.inFlight.splice(inFlightIndex, 1);
            const tracked = d.inFlightByChunk.get(result.chunkKey);
            if (tracked && tracked.gen === result.gen) d.inFlightByChunk.delete(result.chunkKey);

            // queue the result; the caller drains it and its gen guard handles staleness.
            d.results.push({
                chunkKey: result.chunkKey,
                gen: result.gen,
                opaque: result.opaque,
                transparent: result.transparent,
                translucent: result.translucent,
                aabb: result.aabb,
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
 *    // p.enqueues = posts main->worker, p.results = posts worker->main
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
    d.results.length = 0;
    d.lost.length = 0;
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
        cachedVersionsSize: number;
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
            cachedVersionsSize: s.cachedVersions.size,
        })),
    };
}
