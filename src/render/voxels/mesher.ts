import type { Blocks } from '../../core/voxels/block-registry';
import { serializeBlockRegistryForWorker } from '../../core/voxels/block-registry-serde';
import { type ChunkMeshResult, MAX_QUADS_PER_PASS, QUAD_STRIDE_U32S } from '../../core/voxels/chunk-mesher';
import { MESH_TASKS_SCRATCH_BYTES, type MeshTaskSet, packMeshTasks } from '../../core/voxels/mesh-tasks';
import type { MeshWorkerInMsg, MeshWorkerOutMsg } from '../../core/voxels/mesh-worker';
import type { Chunk, Voxels } from '../../core/voxels/voxels';
import { chunkKey } from '../../core/voxels/voxels';

// minimal Worker surface the dispatcher needs; Worker and MessagePort both satisfy it
export type WorkerLike = {
    postMessage(msg: MeshWorkerInMsg, transfer?: Transferable[]): void;
    onmessage: ((e: MessageEvent<MeshWorkerOutMsg>) => void) | null;
    onerror?: ((ev: unknown) => void) | null;
    onmessageerror?: ((ev: unknown) => void) | null;
    terminate?(): void;
};

// dynamic import keeps the ?worker query out of the static graph; the asset pipeline sets workerCount=0 so it's never resolved
let MeshWorkerCtor: (new () => WorkerLike) | null = null;

// loads the mesh worker bundle; a no-op after the first call
export async function loadMeshWorker(): Promise<void> {
    if (MeshWorkerCtor === null) {
        const mod = await import('./mesher.worker?worker&inline');
        MeshWorkerCtor = mod.default as unknown as new () => WorkerLike;
    }
}

// default worker spawn; MesherOpts.workerFactory overrides it
function spawnMeshWorker(): WorkerLike {
    if (MeshWorkerCtor === null) {
        throw new Error('[mesher] await loadMeshWorker() before creating a worker-backed dispatcher');
    }
    return new MeshWorkerCtor();
}

export type MesherResult = ChunkMeshResult & {
    chunkKey: string;
    gen: number;
};

type MeshOutputSet = {
    opaqueBuf: ArrayBuffer;
    transparentBuf: ArrayBuffer;
    translucentBuf: ArrayBuffer;
};

const PASS_BUF_BYTES = MAX_QUADS_PER_PASS * QUAD_STRIDE_U32S * 4;

type WorkerSlot = {
    worker: WorkerLike;
    // drained first and leads the packet, skips the queueDepth gate
    pendingUrgent: Array<{ chunk: Chunk; gen: number }>;
    pending: Array<{ chunk: Chunk; gen: number }>;
    // posted jobs not yet resulted, spliced by chunkKey on result; bounded by queueDepth
    inFlight: Array<{ chunkKey: string; gen: number }>;
    // posted-but-unresulted packet count; how many packet buffers to replenish on crash
    inFlightBatches: number;
    // registry version this slot has acked; dispatch-eligible only when it equals the dispatcher's
    registryVersion: number;
    // registry version last posted here; a gap vs registryVersion means an init is pending
    pendingRegistryVersion: number;
    // main's model of the worker's cache (chunkKey -> version), diffed against dispatches into set/delete deltas
    cachedVersions: Map<string, number>;
};

export type Mesher = {
    slots: WorkerSlot[];
    queueDepth: number;
    // chunk key -> owning slot, from enqueue through in-flight; for dedup and result lookup
    inFlightByChunk: Map<string, { slot: number; gen: number }>;
    // world epoch, bumped by resetMeshCaches; a result echoing an older epoch is dropped
    epoch: number;
    results: MesherResult[];
    // chunk keys lost to a worker crash, awaiting the caller to re-dirty them
    lost: string[];
    packetPool: ArrayBuffer[];
    outputPool: MeshOutputSet[];
    registryVersion: number;
    // canonical serialized registry, kept so a respawned worker re-inits without re-encoding
    registryBuf: ArrayBuffer | null;
    // spawns a worker for a slot; called at boot and on crash respawn
    spawn: () => WorkerLike;
    // per-worker chunk-cache budget; LRU entries beyond it are evicted
    cacheMaxChunks: number;
    perf: MeshPerf;
};

export type MeshPerf = {
    buildMs: number; // main-thread ms spent packing the MeshTasks packet
    postMs: number; // main-thread ms spent in postMessage
    workUs: number; // worker-reported us of mesh work
    enqueues: number; // main->worker posts, one per batch
    results: number; // worker->main result messages drained, one per batch
};

export type MesherOpts = {
    // override the worker spawn; defaults to the ?worker&inline bundle loaded by loadMeshWorker
    workerFactory?: () => WorkerLike;
    workerCount: number;
    queueDepth: number;
    // per-worker chunk-cache budget in chunks, ~16 KB each, defaults to 256 (~4 MB)
    cacheMaxChunks?: number;
};

export function createMesher(opts: MesherOpts): Mesher {
    const slots: WorkerSlot[] = [];
    const spawn = opts.workerFactory ?? spawnMeshWorker;
    const d: Mesher = {
        slots,
        queueDepth: opts.queueDepth,
        inFlightByChunk: new Map(),
        epoch: 0,
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

    // output pool has URGENT_RESERVE_PER_WORKER headroom per worker so an urgent chunk always finds a free buffer
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

// wires onmessage + crash handlers for a (possibly newly respawned) worker
function wireWorker(d: Mesher, slotIndex: number, worker: WorkerLike): void {
    worker.onmessage = (e) => handleWorkerMessage(d, slotIndex, e.data);
    worker.onerror = (ev) => handleWorkerCrash(d, slotIndex, 'error', ev);
    worker.onmessageerror = (ev) => handleWorkerCrash(d, slotIndex, 'messageerror', ev);
}

// respawns a crashed worker slot; a crash detaches every buffer in flight, so they're replenished with fresh ones
function handleWorkerCrash(d: Mesher, slotIndex: number, kind: 'error' | 'messageerror', ev: unknown): void {
    const slot = d.slots[slotIndex];
    if (!slot) return;
    console.warn(`[mesher] worker slot ${slotIndex} crashed (${kind}); respawning`, ev);

    for (const entry of slot.inFlight) {
        const tracked = d.inFlightByChunk.get(entry.chunkKey);
        if (tracked && tracked.slot === slotIndex && tracked.gen === entry.gen) {
            d.inFlightByChunk.delete(entry.chunkKey);
        }
        d.lost.push(entry.chunkKey);
    }

    // replenish one packet buffer per in-flight batch, one output set per in-flight task
    for (let i = 0; i < slot.inFlightBatches; i++) d.packetPool.push(new ArrayBuffer(MESH_TASKS_SCRATCH_BYTES));
    for (let i = 0; i < slot.inFlight.length; i++) d.outputPool.push(allocateOutputSet());
    slot.inFlight.length = 0;
    slot.inFlightBatches = 0;

    // the respawned worker starts with an empty cache, so drop our model of it
    slot.cachedVersions.clear();

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

export function setMeshRegistry(d: Mesher, reg: Blocks): void {
    d.registryVersion += 1;
    const version = d.registryVersion;
    d.registryBuf = serializeBlockRegistryForWorker(reg, version);

    // per-slot copy: postMessage transfer detaches the buffer, so it can't ship to N workers as-is
    for (let i = 0; i < d.slots.length; i++) {
        const slot = d.slots[i]!;
        const buf = d.registryBuf.slice(0);
        slot.pendingRegistryVersion = version;
        slot.worker.postMessage({ cmd: 'initRegistry', version, buf }, [buf]);
    }
}

export function isInFlight(d: Mesher, key: string): boolean {
    return d.inFlightByChunk.has(key);
}

// invalidates every per-worker cache on a room swap, since caches are keyed by bare chunk coordinate
export function resetMeshCaches(d: Mesher): void {
    d.epoch++;
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

// a chunk's tasks always route to the same worker by region hash, so its neighborhood accumulates in that worker's cache
const MESH_REGION_BITS = 3; // region = 8 chunks per axis

function affinityWorker(cx: number, cy: number, cz: number, n: number): number {
    const rx = cx >> MESH_REGION_BITS;
    const ry = cy >> MESH_REGION_BITS;
    const rz = cz >> MESH_REGION_BITS;
    const h = (Math.imul(rx, 73856093) ^ Math.imul(ry, 19349663) ^ Math.imul(rz, 83492791)) | 0;
    return ((h % n) + n) % n;
}

// max tasks per batch packet; bounds message size and keeps a cold batch's set-union under the packet scratch
const MESH_BATCH_MAX = 8;

// extra output-buffer sets reserved per worker beyond queueDepth, so urgent chunks always find a free buffer at flush
const URGENT_RESERVE_PER_WORKER = 2;

// the batch being assembled this flush, urgent entries first then normal; reused scratch, allocates nothing
const _batch: Array<{ chunk: Chunk; gen: number }> = [];

// reused packcat value scratch; the set/delete key arrays parallel the entries so cache commit can defer until packInto succeeds
const _setEntries: MeshTaskSet[] = [];
const _setKeys: string[] = [];
const _delEntries: Array<{ cx: number; cy: number; cz: number }> = [];
const _delKeys: string[] = [];
const _tasks: Array<{ cx: number; cy: number; cz: number; gen: number }> = [];
const _packetValue = { set: _setEntries, delete: _delEntries, tasks: _tasks };
const _neighborhoodKeys = new Set<string>();

function slotAcceptable(d: Mesher, slot: WorkerSlot): boolean {
    return (
        slot.registryVersion === d.registryVersion &&
        slot.pendingRegistryVersion === d.registryVersion &&
        slot.pending.length + slot.inFlight.length < d.queueDepth
    );
}

// enqueues a chunk for meshing, routing to its affinity worker (or spilling to the least-committed worker); flushMeshQueue posts the batch
export function queueMesh(d: Mesher, chunk: Chunk, gen: number, opts: { urgent?: boolean; allowSpill?: boolean } = {}): boolean {
    const key = chunkKey(chunk.cx, chunk.cy, chunk.cz);
    if (d.inFlightByChunk.has(key)) return false;

    let chosen = affinityWorker(chunk.cx, chunk.cy, chunk.cz, d.slots.length);
    let slot = d.slots[chosen]!;

    if (opts.urgent) {
        // urgent bypasses the queueDepth gate but still needs a registry-acked slot
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

// diffs the union of the first batchN chunks in _batch against slot.cachedVersions into set/delete scratch, then packs into packetBuf
function buildBatchPacket(d: Mesher, slot: WorkerSlot, voxels: Voxels, batchN: number, packetBuf: ArrayBuffer): boolean {
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
                    if (_neighborhoodKeys.has(neighborKey)) continue;
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

    // evict oldest entries not in this batch's neighborhood to stay under the cache budget; evictions ride the delete list
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

// commits the scratch deltas from the last successful buildBatchPacket to our model of the worker cache
function commitBatch(slot: WorkerSlot): void {
    const cachedVersions = slot.cachedVersions;
    for (let i = 0; i < _delKeys.length; i++) cachedVersions.delete(_delKeys[i]!);
    for (let i = 0; i < _setKeys.length; i++) {
        const key = _setKeys[i]!;
        cachedVersions.delete(key);
        cachedVersions.set(key, _setEntries[i]!.version);
    }
}

// builds and posts one batch for slot from its pending queues (urgent first), if a packet and output buffers are free
function flushSlot(d: Mesher, slotIndex: number, voxels: Voxels): void {
    const slot = d.slots[slotIndex]!;
    const total = slot.pendingUrgent.length + slot.pending.length;
    if (total === 0) return;
    if (slot.registryVersion !== d.registryVersion || slot.pendingRegistryVersion !== d.registryVersion) return;
    if (d.packetPool.length === 0 || d.outputPool.length === 0) return;

    let batchN = Math.min(total, d.outputPool.length, MESH_BATCH_MAX);
    // urgent-first so those chunks lead the packet and survive the overflow-halving below
    _batch.length = 0;
    for (let i = 0; i < slot.pendingUrgent.length && _batch.length < batchN; i++) _batch.push(slot.pendingUrgent[i]!);
    for (let i = 0; i < slot.pending.length && _batch.length < batchN; i++) _batch.push(slot.pending[i]!);

    const packetBuf = d.packetPool[d.packetPool.length - 1]!;

    const tBuild = performance.now();
    // halves the batch on overflow; a single task always fits (at most 27 chunks)
    while (!buildBatchPacket(d, slot, voxels, batchN, packetBuf) && batchN > 1) batchN = batchN >> 1;

    d.packetPool.pop();
    commitBatch(slot);

    const outBufs: ArrayBuffer[] = [];
    for (let i = 0; i < batchN; i++) {
        const out = d.outputPool.pop()!;
        outBufs.push(out.opaqueBuf, out.transparentBuf, out.translucentBuf);
        const p = _batch[i]!;
        slot.inFlight.push({ chunkKey: chunkKey(p.chunk.cx, p.chunk.cy, p.chunk.cz), gen: p.gen });
    }
    // urgent entries are at the front of _batch, so the first min(pendingUrgent, batchN) come off pendingUrgent, the rest off pending
    const urgentTaken = Math.min(slot.pendingUrgent.length, batchN);
    slot.pendingUrgent.splice(0, urgentTaken);
    slot.pending.splice(0, batchN - urgentTaken);
    slot.inFlightBatches++;

    const tPost = performance.now();
    slot.worker.postMessage({ cmd: 'meshTasks', epoch: d.epoch, packetBuf, outBufs }, [packetBuf, ...outBufs]);
    const tEnd = performance.now();
    d.perf.buildMs += tPost - tBuild;
    d.perf.postMs += tEnd - tPost;
    d.perf.enqueues++;
}

// builds and posts batches for every worker with pending work; call once per frame after the enqueue loop
export function flushMeshQueue(d: Mesher, voxels: Voxels): void {
    for (let i = 0; i < d.slots.length; i++) flushSlot(d, i, voxels);
}

function handleWorkerMessage(d: Mesher, slotIndex: number, msg: MeshWorkerOutMsg): void {
    const slot = d.slots[slotIndex]!;
    if (msg.cmd === 'initRegistryAck') {
        slot.registryVersion = msg.version;
        return;
    }
    if (msg.cmd === 'result') {
        d.perf.workUs += msg.workUs;
        d.perf.results++;
        slot.inFlightBatches--;

        d.packetPool.push(msg.recycle.packetBuf);
        const outBufs = msg.recycle.outBufs;
        for (let i = 0; i < outBufs.length; i += 3) {
            d.outputPool.push({ opaqueBuf: outBufs[i]!, transparentBuf: outBufs[i + 1]!, translucentBuf: outBufs[i + 2]! });
        }

        // a batch posted before the last resetMeshCaches meshed a world that's no longer active; its results aren't ours
        if (msg.epoch !== d.epoch) return;

        for (const result of msg.results) {
            // splice by key: FIFO usually puts it at 0, but a stale-gen result could differ
            const inFlightIndex = slot.inFlight.findIndex((e) => e.chunkKey === result.chunkKey && e.gen === result.gen);
            if (inFlightIndex >= 0) slot.inFlight.splice(inFlightIndex, 1);
            const tracked = d.inFlightByChunk.get(result.chunkKey);
            if (tracked && tracked.gen === result.gen) d.inFlightByChunk.delete(result.chunkKey);

            d.results.push({
                chunkKey: result.chunkKey,
                gen: result.gen,
                opaque: result.opaque,
                transparent: result.transparent,
                translucent: result.translucent,
                aabb: result.aabb,
            });
        }

        // does not refill the slot here: recycled buffers still back queued results until drained; flushMeshQueue refills next frame
        return;
    }
}

// reads the accumulated per-frame mesh perf counters and resets them
export function readMeshPerf(d: Mesher): MeshPerf {
    const p = d.perf;
    d.perf = { buildMs: 0, postMs: 0, workUs: 0, enqueues: 0, results: 0 };
    return p;
}

export function disposeMesher(d: Mesher): void {
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

// test-only inspection helper for verifying slot queue depth and pool size invariants
export function meshQueueStats(d: Mesher): {
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
