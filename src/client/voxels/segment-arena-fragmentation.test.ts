// ── Fragmentation profile (one-shot metrics) ──────────────────────
//
// Companion to segment-arena.bench.ts. Vitest bench mode only runs
// `bench` blocks; `it` blocks need a `.test.ts` host to be picked up.
// Fills each allocator with a bimodal workload until first OOM and
// reports peak-used + alloc count — captured as worklog data for the
// OffsetAllocator port, not a pass/fail gate.

import { describe, it } from 'vitest';

import { createOffsetAllocator, type OAHandle, oaAllocate, oaFree } from './offset-allocator';

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

// First-fit reference (mirror of voxel-visuals.ts current free-list).
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

describe('fragmentation profile (peak used at first OOM)', () => {
    it('reports first-fit baseline + OffsetAllocator', () => {
        const measure = (
            name: string,
            alloc: (size: number) => boolean,
            free: () => void,
            used: () => number,
            liveCount: () => number,
        ) => {
            const rand = makeRng(0x12345);
            let allocCount = 0;
            let oomCount = 0;
            let firstOomAt = -1;
            let firstOomUsed = -1;
            // Steady-state churn: aim for ~60% capacity utilization, then run
            // many ops with a balanced alloc/free coin. OOM happens when a
            // request can't fit despite enough total free space — i.e. when
            // fragmentation has carved up the heap. Count OOMs as the metric.
            const TARGET_USED = Math.floor(CAPACITY_SLOTS * 0.6);
            const OPS = 50_000;
            for (let i = 0; i < OPS; i++) {
                // bias alloc when below target, free when above; small jitter.
                const pressure = used() < TARGET_USED ? 0.7 : 0.3;
                const wantAlloc = liveCount() === 0 || rand() < pressure;
                if (wantAlloc) {
                    const size = nextAllocSize(rand);
                    if (!alloc(size)) {
                        if (firstOomAt < 0) {
                            firstOomAt = i;
                            firstOomUsed = used();
                        }
                        oomCount++;
                    } else {
                        allocCount++;
                    }
                } else {
                    free();
                }
            }
            const pct = firstOomUsed >= 0 ? ((firstOomUsed / CAPACITY_SLOTS) * 100).toFixed(1) : 'n/a';
            // eslint-disable-next-line no-console
            console.log(
                `[${name}] ops=${OPS} allocs=${allocCount} OOMs=${oomCount}` +
                    ` firstOOM=${firstOomAt} (used=${firstOomUsed}/${CAPACITY_SLOTS}, ${pct}%)`,
            );
        };

        // first-fit
        {
            const a = ffCreate(CAPACITY_SLOTS);
            const live: { start: number; size: number }[] = [];
            const rand = makeRng(0xdeadbeef);
            measure(
                'first-fit',
                (size) => {
                    const start = ffAlloc(a, size);
                    if (start === null) return false;
                    live.push({ start, size });
                    return true;
                },
                () => {
                    if (live.length === 0) return;
                    const idx = Math.floor(rand() * live.length);
                    const seg = live.splice(idx, 1)[0]!;
                    ffFree(a, seg.start, seg.size);
                },
                () => a.used,
                () => live.length,
            );
        }

        // OffsetAllocator
        {
            const a = createOffsetAllocator(CAPACITY_SLOTS, 8192);
            const live: OAHandle[] = [];
            const rand = makeRng(0xdeadbeef);
            let used = 0;
            measure(
                'OffsetAllocator',
                (size) => {
                    const h = oaAllocate(a, size);
                    if (!h) return false;
                    live.push(h);
                    used += size;
                    return true;
                },
                () => {
                    if (live.length === 0) return;
                    const idx = Math.floor(rand() * live.length);
                    const h = live.splice(idx, 1)[0]!;
                    used -= a.nodeSize[h.node]!;
                    oaFree(a, h);
                },
                () => used,
                () => live.length,
            );
        }
    });
});
