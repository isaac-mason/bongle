// ── SegmentArena allocator bench ───────────────────────────────────
//
// run with:
//   pnpm vitest bench src/client/voxels/segment-arena.bench.ts
//
// measures per-op cost AND fragmentation profile of the slot allocator
// powering SegmentArena. baseline (this commit): first-fit free list.
// after OA-5 swaps in OffsetAllocator, the SegmentArena numbers shift;
// the standalone OffsetAllocator/first-fit benches keep providing an
// algorithm-only comparison.
//
// the metrics test ("fragmentation profile") is not a `bench` — it runs
// once and prints peak-used-before-OOM, which `bench` can't report.

import { bench, describe } from 'vitest';
import { createOffsetAllocator, type OAHandle, type OffsetAllocator, oaAllocate, oaFree } from './offset-allocator';
import { arenaAlloc, arenaFree, createQuadArena, type QuadArena } from './voxel-resources';

// ── workload ───────────────────────────────────────────────────────
//
// bimodal alloc-size distribution mirroring real chunks: most chunks
// hold a few hundred quads, a long tail hits 1k–7k.

const CAPACITY_SLOTS = 100_000;
const SMALL_MIN = 1;
const SMALL_MAX = 200;
const LARGE_MIN = 500;
const LARGE_MAX = 5000;
const SMALL_FRACTION = 0.7;

function makeRng(seed: number): () => number {
    let s = seed | 0;
    return () => {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        return (s >>> 0) / 0xffffffff;
    };
}

function nextAllocSize(rand: () => number): number {
    if (rand() < SMALL_FRACTION) {
        return SMALL_MIN + Math.floor(rand() * (SMALL_MAX - SMALL_MIN + 1));
    }
    return LARGE_MIN + Math.floor(rand() * (LARGE_MAX - LARGE_MIN + 1));
}

// ── first-fit reference (independent of SegmentArena) ─────────────
//
// inlined so the standalone bench works regardless of how SegmentArena
// evolves. mirrors the current voxel-visuals.ts free-list shape.

type FFRun = { start: number; length: number };
type FirstFit = { capacity: number; free: FFRun[]; used: number };

function ffCreate(capacity: number): FirstFit {
    return { capacity, free: [{ start: 0, length: capacity }], used: 0 };
}

function ffAlloc(a: FirstFit, slots: number): number | null {
    for (let i = 0; i < a.free.length; i++) {
        const r = a.free[i]!;
        if (r.length < slots) continue;
        const start = r.start;
        if (r.length === slots) a.free.splice(i, 1);
        else {
            r.start += slots;
            r.length -= slots;
        }
        a.used += slots;
        return start;
    }
    return null;
}

function ffFree(a: FirstFit, start: number, slots: number): void {
    a.used -= slots;
    let i = 0;
    while (i < a.free.length && a.free[i]!.start < start) i++;
    a.free.splice(i, 0, { start, length: slots });
    if (i > 0) {
        const left = a.free[i - 1]!;
        if (left.start + left.length === start) {
            left.length += slots;
            a.free.splice(i, 1);
            i--;
        }
    }
    const cur = a.free[i]!;
    if (i + 1 < a.free.length) {
        const right = a.free[i + 1]!;
        if (cur.start + cur.length === right.start) {
            cur.length += right.length;
            a.free.splice(i + 1, 1);
        }
    }
}

// ── pre-built churn script ─────────────────────────────────────────
//
// generate the same alloc/free sequence once. each bench iteration
// replays it from a fresh allocator state so we measure the algorithm,
// not the PRNG or the size mix.

type Op = { kind: 'alloc'; size: number; id: number } | { kind: 'free'; id: number };

function buildChurnScript(opCount: number, seed: number): Op[] {
    const rand = makeRng(seed);
    const ops: Op[] = [];
    const live: number[] = [];
    let nextId = 0;
    for (let i = 0; i < opCount; i++) {
        const wantAlloc = live.length === 0 || (rand() < 0.55 && live.length < 400);
        if (wantAlloc) {
            const id = nextId++;
            ops.push({ kind: 'alloc', size: nextAllocSize(rand), id });
            live.push(id);
        } else {
            const idx = Math.floor(rand() * live.length);
            const id = live.splice(idx, 1)[0]!;
            ops.push({ kind: 'free', id });
        }
    }
    return ops;
}

const CHURN_OPS = 5000;
const SCRIPT = buildChurnScript(CHURN_OPS, 0xc0ffee);

// ── algorithm-only benches ─────────────────────────────────────────

describe('allocator algorithm — per-op throughput', () => {
    bench('first-fit (current)', () => {
        const a = ffCreate(CAPACITY_SLOTS);
        const live = new Map<number, { start: number; size: number }>();
        for (let i = 0; i < SCRIPT.length; i++) {
            const op = SCRIPT[i]!;
            if (op.kind === 'alloc') {
                const start = ffAlloc(a, op.size);
                if (start !== null) live.set(op.id, { start, size: op.size });
            } else {
                const seg = live.get(op.id);
                if (seg) {
                    ffFree(a, seg.start, seg.size);
                    live.delete(op.id);
                }
            }
        }
    });

    bench('OffsetAllocator', () => {
        const a = createOffsetAllocator(CAPACITY_SLOTS, 8192);
        const live = new Map<number, OAHandle>();
        for (let i = 0; i < SCRIPT.length; i++) {
            const op = SCRIPT[i]!;
            if (op.kind === 'alloc') {
                const h = oaAllocate(a, op.size);
                if (h) live.set(op.id, h);
            } else {
                const h = live.get(op.id);
                if (h) {
                    oaFree(a, h);
                    live.delete(op.id);
                }
            }
        }
    });
});

// ── SegmentArena (current path) bench ──────────────────────────────
//
// goes through the real SegmentArena wrapper to catch any overhead the
// wrapper itself adds on top of the bare allocator. before OA-5 this
// hits first-fit; after, OffsetAllocator.

describe('SegmentArena — per-op throughput', () => {
    bench('arenaAlloc/arenaFree (current SegmentArena impl)', () => {
        const arena: QuadArena = createQuadArena(CAPACITY_SLOTS * 52); // bytes
        const live = new Map<number, { start: number; size: number }>();
        for (let i = 0; i < SCRIPT.length; i++) {
            const op = SCRIPT[i]!;
            if (op.kind === 'alloc') {
                try {
                    const start = arenaAlloc(arena, op.size);
                    live.set(op.id, { start, size: op.size });
                } catch {
                    /* OOM — skip */
                }
            } else {
                const seg = live.get(op.id);
                if (seg) {
                    arenaFree(arena, seg.start);
                    live.delete(op.id);
                }
            }
        }
        // dispose to free GpuBuffer typed arrays between iterations
        for (const key in arena.buffers) arena.buffers[key as keyof typeof arena.buffers].dispose();
    });
});

// fragmentation profile lives in segment-arena-fragmentation.test.ts —
// vitest bench mode only picks up `bench` blocks.
