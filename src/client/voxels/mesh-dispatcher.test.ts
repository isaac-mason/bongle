// ── mesh-dispatcher tests ───────────────────────────────────────────
//
// Drives the worker protocol via in-process stub workers — no real
// Worker spawned. Each stub holds two queues: dispatcher → worker
// inbox and worker → dispatcher outbox. Tests step the protocol
// explicitly (processWorker → deliverToMain) so invariants like
// queue depth + pool size can be inspected mid-protocol.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerAllShapes } from 'crashcat';
import {
    createMeshDispatcher,
    dispatcherStats,
    disposeMeshDispatcher,
    enqueueMesh,
    isInFlight,
    type MeshDispatcherResult,
    setMeshRegistry,
    type WorkerLike,
} from './mesh-dispatcher';
import {
    type MeshWorkerInMsg,
    type MeshWorkerOutMsg,
    type WorkerState,
    createWorkerState,
    handleMessage,
} from '../../core/voxels/mesh-worker';
import { buildTestRegistry, resetVoxelRegistry } from '../../core/voxels/test-helpers';
import { createChunk, createVoxels, setChunkBlock } from '../../core/voxels/voxels';

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    resetVoxelRegistry();
});

type TestWorker = {
    worker: WorkerLike;
    inbox: MeshWorkerInMsg[];
    outbox: MeshWorkerOutMsg[];
    state: WorkerState;
};

function createTestWorker(): TestWorker {
    const inbox: MeshWorkerInMsg[] = [];
    const outbox: MeshWorkerOutMsg[] = [];
    const state = createWorkerState();
    let onmessage: ((e: MessageEvent<MeshWorkerOutMsg>) => void) | null = null;
    const worker: WorkerLike = {
        postMessage: (msg) => {
            inbox.push(msg);
        },
        get onmessage() {
            return onmessage;
        },
        set onmessage(h) {
            onmessage = h;
        },
    };
    return { worker, inbox, outbox, state };
}

/** drive every queued inbound message through `handleMessage`, queuing
 *  responses into the outbox. */
function processWorker(tw: TestWorker): void {
    while (tw.inbox.length > 0) {
        const msg = tw.inbox.shift()!;
        const out = handleMessage(tw.state, msg);
        if (out !== null) tw.outbox.push(out);
    }
}

/** deliver every outbox message back to the dispatcher's slot
 *  onmessage handler. */
function deliverToMain(tw: TestWorker): void {
    while (tw.outbox.length > 0) {
        const msg = tw.outbox.shift()!;
        tw.worker.onmessage?.({ data: msg } as MessageEvent<MeshWorkerOutMsg>);
    }
}

function step(workers: TestWorker[]): void {
    for (const w of workers) processWorker(w);
    for (const w of workers) deliverToMain(w);
}

function buildSmallRegistry() {
    return buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
}

function makeChunkWithOneBlock(reg: ReturnType<typeof buildSmallRegistry>) {
    const voxels = createVoxels(reg);
    const chunk = createChunk(0, 0, 0);
    voxels.chunks.set('0,0,0', chunk);
    setChunkBlock(chunk, 5, 5, 5, 'stone', reg);
    return { voxels, chunk };
}

describe('mesh-dispatcher', () => {
    describe('registry handshake', () => {
        it('slots are ineligible for dispatch until initRegistry ack', () => {
            const reg = buildSmallRegistry();
            const tw = createTestWorker();
            const results: MeshDispatcherResult[] = [];
            const d = createMeshDispatcher({
                workerFactory: () => tw.worker,
                workerCount: 1,
                queueDepth: 2,
                onResult: (r) => results.push(r),
            });
            setMeshRegistry(d, reg);

            // Before ack, enqueue must fail — slot pendingVersion !== registryVersion via ack
            const { voxels, chunk } = makeChunkWithOneBlock(reg);
            expect(enqueueMesh(d, voxels, chunk, 1)).toBe(false);

            // After processing the initRegistry message, the slot should be eligible.
            step([tw]);
            expect(enqueueMesh(d, voxels, chunk, 1)).toBe(true);
            disposeMeshDispatcher(d);
        });
    });

    describe('dispatch + dedup', () => {
        function bootstrap() {
            const reg = buildSmallRegistry();
            const tw = createTestWorker();
            const results: MeshDispatcherResult[] = [];
            const d = createMeshDispatcher({
                workerFactory: () => tw.worker,
                workerCount: 1,
                queueDepth: 3,
                onResult: (r) => results.push(r),
            });
            setMeshRegistry(d, reg);
            step([tw]); // ack
            return { reg, tw, results, d };
        }

        it('round-trips a single mesh job', () => {
            const { reg, tw, results, d } = bootstrap();
            const { voxels, chunk } = makeChunkWithOneBlock(reg);

            expect(enqueueMesh(d, voxels, chunk, 1)).toBe(true);
            expect(isInFlight(d, '0,0,0')).toBe(true);

            step([tw]);
            expect(results.length).toBe(1);
            expect(results[0]!.chunkKey).toBe('0,0,0');
            expect(results[0]!.gen).toBe(1);
            expect(results[0]!.opaque).not.toBeNull();
            expect(results[0]!.opaque!.quadCount).toBe(6);
            expect(isInFlight(d, '0,0,0')).toBe(false);
            disposeMeshDispatcher(d);
        });

        it('dedups: enqueuing the same chunk twice rejects the second', () => {
            const { reg, tw, d } = bootstrap();
            const { voxels, chunk } = makeChunkWithOneBlock(reg);

            expect(enqueueMesh(d, voxels, chunk, 1)).toBe(true);
            // Same key, even at a higher gen, must skip — caller is
            // expected to wait for the in-flight result to land first.
            expect(enqueueMesh(d, voxels, chunk, 2)).toBe(false);

            step([tw]);
            // After the result clears the entry, re-enqueue should succeed.
            expect(enqueueMesh(d, voxels, chunk, 2)).toBe(true);
            disposeMeshDispatcher(d);
        });

        it('forwards stale-gen results — caller decides what to do', () => {
            const { reg, tw, results, d } = bootstrap();
            const { voxels, chunk } = makeChunkWithOneBlock(reg);

            enqueueMesh(d, voxels, chunk, 5);
            step([tw]);

            expect(results.length).toBe(1);
            expect(results[0]!.gen).toBe(5);
            disposeMeshDispatcher(d);
        });
    });

    describe('queue depth + load balancing', () => {
        function bootstrap(workerCount: number, queueDepth: number) {
            const reg = buildSmallRegistry();
            const tws: TestWorker[] = [];
            const results: MeshDispatcherResult[] = [];
            const d = createMeshDispatcher({
                workerFactory: () => {
                    const tw = createTestWorker();
                    tws.push(tw);
                    return tw.worker;
                },
                workerCount,
                queueDepth,
                onResult: (r) => results.push(r),
            });
            setMeshRegistry(d, reg);
            for (const tw of tws) processWorker(tw); // process initRegistry
            for (const tw of tws) deliverToMain(tw); // deliver ack
            return { reg, tws, results, d };
        }

        function makeChunkAt(reg: ReturnType<typeof buildSmallRegistry>, cx: number, cy: number, cz: number) {
            const voxels = createVoxels(reg);
            const chunk = createChunk(cx, cy, cz);
            voxels.chunks.set(`${cx},${cy},${cz}`, chunk);
            setChunkBlock(chunk, 5, 5, 5, 'stone', reg);
            return { voxels, chunk };
        }

        it('balances jobs across slots — picks the shortest queue', () => {
            const { reg, d } = bootstrap(2, 3);

            const c0 = makeChunkAt(reg, 0, 0, 0);
            const c1 = makeChunkAt(reg, 1, 0, 0);
            const c2 = makeChunkAt(reg, 2, 0, 0);
            const c3 = makeChunkAt(reg, 3, 0, 0);

            enqueueMesh(d, c0.voxels, c0.chunk, 1);
            enqueueMesh(d, c1.voxels, c1.chunk, 1);
            enqueueMesh(d, c2.voxels, c2.chunk, 1);
            enqueueMesh(d, c3.voxels, c3.chunk, 1);

            const stats = dispatcherStats(d);
            expect(stats.inFlightTotal).toBe(4);
            // Should be split 2/2, not 4/0 (load balance picks the
            // shortest queue at each enqueue).
            expect(stats.perSlot.map((p) => p.inFlight).sort()).toEqual([2, 2]);
            disposeMeshDispatcher(d);
        });

        it('refuses dispatch when every slot is saturated at queueDepth', () => {
            const { reg, d } = bootstrap(1, 2);

            const c0 = makeChunkAt(reg, 0, 0, 0);
            const c1 = makeChunkAt(reg, 1, 0, 0);
            const c2 = makeChunkAt(reg, 2, 0, 0);

            expect(enqueueMesh(d, c0.voxels, c0.chunk, 1)).toBe(true);
            expect(enqueueMesh(d, c1.voxels, c1.chunk, 1)).toBe(true);
            // workerCount=1, queueDepth=2 → 3rd enqueue must fail.
            expect(enqueueMesh(d, c2.voxels, c2.chunk, 1)).toBe(false);
            disposeMeshDispatcher(d);
        });
    });

    describe('buffer pool round-trip', () => {
        it('pool size returns to initial after every dispatch+result cycle', () => {
            const reg = buildSmallRegistry();
            const tws: TestWorker[] = [];
            const d = createMeshDispatcher({
                workerFactory: () => {
                    const tw = createTestWorker();
                    tws.push(tw);
                    return tw.worker;
                },
                workerCount: 2,
                queueDepth: 3,
                onResult: () => {},
            });
            setMeshRegistry(d, reg);
            step(tws); // ack both slots

            const initialPool = dispatcherStats(d).poolSize;
            expect(initialPool).toBe(2 * 3); // workerCount * queueDepth

            // Enqueue 4 jobs — pool drops by 4.
            for (let i = 0; i < 4; i++) {
                const voxels = createVoxels(reg);
                const chunk = createChunk(i, 0, 0);
                voxels.chunks.set(`${i},0,0`, chunk);
                setChunkBlock(chunk, 5, 5, 5, 'stone', reg);
                expect(enqueueMesh(d, voxels, chunk, 1)).toBe(true);
            }
            expect(dispatcherStats(d).poolSize).toBe(initialPool - 4);

            // Process + deliver every result — pool restored.
            step(tws);
            expect(dispatcherStats(d).poolSize).toBe(initialPool);
            disposeMeshDispatcher(d);
        });

        it('crash recovery: lost in-flight chunks resurface via onLost, pool replenished, slot respawned', () => {
            const reg = buildSmallRegistry();
            // Track every worker spawned by the factory so we can detect
            // respawn (slot 0 should be on its 2nd worker after the crash).
            const tws: TestWorker[] = [];
            const lostKeys: string[] = [];
            const d = createMeshDispatcher({
                workerFactory: () => {
                    const tw = createTestWorker();
                    tws.push(tw);
                    return tw.worker;
                },
                workerCount: 1,
                queueDepth: 3,
                onResult: () => {},
                onLost: (key) => lostKeys.push(key),
            });
            setMeshRegistry(d, reg);
            step([tws[0]!]); // ack the initial worker

            const initialPool = dispatcherStats(d).poolSize;
            expect(initialPool).toBe(3);
            expect(tws.length).toBe(1);

            // Queue 2 jobs at the live worker — both are in flight at slot 0.
            const c0 = (() => {
                const voxels = createVoxels(reg);
                const chunk = createChunk(0, 0, 0);
                voxels.chunks.set('0,0,0', chunk);
                setChunkBlock(chunk, 5, 5, 5, 'stone', reg);
                return { voxels, chunk };
            })();
            const c1 = (() => {
                const voxels = createVoxels(reg);
                const chunk = createChunk(1, 0, 0);
                voxels.chunks.set('1,0,0', chunk);
                setChunkBlock(chunk, 5, 5, 5, 'stone', reg);
                return { voxels, chunk };
            })();
            expect(enqueueMesh(d, c0.voxels, c0.chunk, 7)).toBe(true);
            expect(enqueueMesh(d, c1.voxels, c1.chunk, 7)).toBe(true);
            expect(dispatcherStats(d).poolSize).toBe(initialPool - 2);
            expect(dispatcherStats(d).inFlightTotal).toBe(2);

            // Simulate the worker crashing mid-job.
            tws[0]!.worker.onerror?.(new Error('boom'));

            // Lost chunks surfaced via onLost; dedup map drained; pool
            // replenished to its original capacity; a fresh worker was
            // spawned for slot 0.
            expect(new Set(lostKeys)).toEqual(new Set(['0,0,0', '1,0,0']));
            expect(dispatcherStats(d).inFlightTotal).toBe(0);
            expect(dispatcherStats(d).poolSize).toBe(initialPool);
            expect(tws.length).toBe(2);

            // Fresh worker is ineligible for dispatch until its
            // initRegistry ack lands.
            expect(enqueueMesh(d, c0.voxels, c0.chunk, 8)).toBe(false);
            step([tws[1]!]); // ack the respawned worker
            expect(enqueueMesh(d, c0.voxels, c0.chunk, 8)).toBe(true);
            disposeMeshDispatcher(d);
        });

        it('returns false when the pool is exhausted', () => {
            const reg = buildSmallRegistry();
            const tw = createTestWorker();
            const d = createMeshDispatcher({
                workerFactory: () => tw.worker,
                // 1 worker, depth 1 → pool size 1, queue capacity 1.
                workerCount: 1,
                queueDepth: 1,
                onResult: () => {},
            });
            setMeshRegistry(d, reg);
            step([tw]);

            const v0 = createVoxels(reg);
            const c0 = createChunk(0, 0, 0);
            v0.chunks.set('0,0,0', c0);
            setChunkBlock(c0, 5, 5, 5, 'stone', reg);

            const v1 = createVoxels(reg);
            const c1 = createChunk(1, 0, 0);
            v1.chunks.set('1,0,0', c1);
            setChunkBlock(c1, 5, 5, 5, 'stone', reg);

            expect(enqueueMesh(d, v0, c0, 1)).toBe(true);
            // pool empty (1 borrowed of 1) AND queue full → false
            expect(enqueueMesh(d, v1, c1, 1)).toBe(false);
            disposeMeshDispatcher(d);
        });
    });
});
