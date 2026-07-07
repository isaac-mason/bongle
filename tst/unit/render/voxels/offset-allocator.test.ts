// ── OffsetAllocator tests ──────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import {
    _internal,
    createOffsetAllocator,
    OA_UNUSED,
    type OAHandle,
    type OffsetAllocator,
    oaAllocate,
    oaAllocationSize,
    oaFree,
    oaReset,
    oaStorageReport,
} from '../../../../src/render/voxels/offset-allocator';

// ── helpers ─────────────────────────────────────────────────────────

function allocOrThrow(a: OffsetAllocator, size: number): OAHandle {
    const h = oaAllocate(a, size);
    if (!h) throw new Error(`oaAllocate(${size}) returned null`);
    return h;
}

/** Brute-force tracker: live segments with sizes. Asserts no overlap as a
 *  cross-check against the allocator's internal bookkeeping. */
type LiveSeg = { offset: number; size: number; handle: OAHandle };
function assertNoOverlap(live: LiveSeg[]): void {
    const sorted = [...live].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!;
        const cur = sorted[i]!;
        expect(cur.offset).toBeGreaterThanOrEqual(prev.offset + prev.size);
    }
}

// ── SmallFloat helpers ──────────────────────────────────────────────

describe('SmallFloat', () => {
    const { uintToFloatRoundUp, uintToFloatRoundDown, floatToUint } = _internal;

    it('denorm range (0..7) is exact', () => {
        for (let i = 0; i < 8; i++) {
            expect(uintToFloatRoundUp(i)).toBe(i);
            expect(uintToFloatRoundDown(i)).toBe(i);
            expect(floatToUint(i)).toBe(i);
        }
    });

    it('round-up bin ≥ size for normalised range', () => {
        for (let size = 8; size <= 100000; size += 137) {
            const bin = uintToFloatRoundUp(size);
            expect(floatToUint(bin)).toBeGreaterThanOrEqual(size);
        }
    });

    it('round-down bin ≤ size for normalised range', () => {
        for (let size = 8; size <= 100000; size += 137) {
            const bin = uintToFloatRoundDown(size);
            expect(floatToUint(bin)).toBeLessThanOrEqual(size);
        }
    });

    it('round-up overhead ≤ 12.5%', () => {
        for (let size = 8; size <= 1_000_000; size += 1009) {
            const bin = uintToFloatRoundUp(size);
            const actual = floatToUint(bin);
            const overhead = (actual - size) / size;
            expect(overhead).toBeLessThanOrEqual(0.125 + 1e-9);
        }
    });

    it('round-up = round-down for exact bin sizes (representable range)', () => {
        // Bins 240..255 (exp 30, 31) encode sizes ≥ 2^32, which don't fit in
        // a u32, the C++ has the same limitation. Real allocations stay well
        // below this; we test the practical range.
        const MAX_REPRESENTABLE_BIN = 240; // exclusive
        for (let bin = 1; bin < MAX_REPRESENTABLE_BIN; bin++) {
            const size = floatToUint(bin);
            expect(uintToFloatRoundDown(size)).toBe(bin);
            expect(uintToFloatRoundUp(size)).toBe(bin);
        }
    });

    it('mantissa overflow carries into exponent', () => {
        // size 15: highest bit 3, mantissaStartBit 0, mantissa 7. lowBits empty
        // so no round-up bump → bin = (1<<3)|7 = 15.
        expect(uintToFloatRoundUp(15)).toBe(15);
        // size 17: highestBit 4, mantissaStartBit 1, mantissa = 17>>1 & 7 = 0,
        // lowBitsMask = 1, size & 1 = 1 → mantissa++ → 1. bin = (2<<3)+1 = 17.
        expect(uintToFloatRoundUp(17)).toBe(17);
        expect(floatToUint(uintToFloatRoundUp(17))).toBeGreaterThanOrEqual(17);
    });
});

// ── bit helpers ─────────────────────────────────────────────────────

describe('findLowestSetBitAfter', () => {
    const { findLowestSetBitAfter } = _internal;

    it('returns first set bit ≥ start', () => {
        expect(findLowestSetBitAfter(0b10110, 0)).toBe(1);
        expect(findLowestSetBitAfter(0b10110, 2)).toBe(2);
        expect(findLowestSetBitAfter(0b10110, 3)).toBe(4);
    });

    it('returns NO_SPACE if no bits at or above start', () => {
        expect(findLowestSetBitAfter(0b00110, 3)).toBe(OA_UNUSED);
        expect(findLowestSetBitAfter(0, 0)).toBe(OA_UNUSED);
    });

    it('handles bit 31', () => {
        expect(findLowestSetBitAfter(0x80000000 | 0, 0)).toBe(31);
        expect(findLowestSetBitAfter(0x80000000 | 0, 31)).toBe(31);
    });
});

// ── allocator basics ────────────────────────────────────────────────

describe('OffsetAllocator basics', () => {
    it('one alloc consumes from the seed free node', () => {
        const a = createOffsetAllocator(1024, 64);
        const before = oaStorageReport(a);
        expect(before.totalFree).toBe(1024);

        const h = allocOrThrow(a, 100);
        expect(h.offset).toBe(0);
        expect(oaAllocationSize(a, h)).toBe(100);

        const after = oaStorageReport(a);
        expect(after.totalFree).toBe(1024 - 100);
    });

    it('sequential allocs return non-overlapping offsets', () => {
        const a = createOffsetAllocator(1024, 64);
        const sizes = [100, 50, 200, 75, 33];
        const handles = sizes.map((s) => allocOrThrow(a, s));
        const live = handles.map((h, i) => ({ offset: h.offset, size: sizes[i]!, handle: h }));
        assertNoOverlap(live);
        const totalUsed = sizes.reduce((s, x) => s + x, 0);
        expect(oaStorageReport(a).totalFree).toBe(1024 - totalUsed);
    });

    it('free returns space to the pool', () => {
        const a = createOffsetAllocator(1024, 64);
        const h = allocOrThrow(a, 500);
        oaFree(a, h);
        expect(oaStorageReport(a).totalFree).toBe(1024);
        // and we can re-allocate the same span
        const h2 = allocOrThrow(a, 500);
        expect(h2.offset).toBe(0);
    });

    it('free coalesces with both neighbours', () => {
        const a = createOffsetAllocator(1024, 64);
        const a1 = allocOrThrow(a, 100);
        const a2 = allocOrThrow(a, 100);
        const a3 = allocOrThrow(a, 100);
        oaFree(a, a1);
        oaFree(a, a3);
        // Mid free should now merge with both neighbours into one 1024-byte free run.
        oaFree(a, a2);
        const rep = oaStorageReport(a);
        expect(rep.totalFree).toBe(1024);
        // A 1024-sized alloc must succeed → only possible if it's contiguous.
        const big = allocOrThrow(a, 1024);
        expect(big.offset).toBe(0);
    });
});

// ── OOM ─────────────────────────────────────────────────────────────

describe('OOM behaviour', () => {
    // NOTE on sizes: TLSF-style bin classification is conservative, a free
    // region of size N lives in `roundDown(N)` but an alloc-of-N needs
    // `roundUp(N)`. Sizes that aren't exact bin sizes (e.g. 100) will fail to
    // alloc from a same-size region. Use powers of 2 (which are exact bin
    // sizes) so the tests exercise true OOM rather than bin-quantization OOM.

    it('returns null when no fit', () => {
        const a = createOffsetAllocator(128, 64);
        allocOrThrow(a, 128);
        expect(oaAllocate(a, 1)).toBeNull();
    });

    it('returns null when node pool exhausted', () => {
        // maxAllocs=4 → freeOffset starts at 3. Seed insert consumes one node.
        // Each alloc that splits consumes one more. Eventually pool empties.
        const a = createOffsetAllocator(1_000_000, 4);
        const handles: OAHandle[] = [];
        let oom = false;
        for (let i = 0; i < 100; i++) {
            const h = oaAllocate(a, 16);
            if (!h) {
                oom = true;
                break;
            }
            handles.push(h);
        }
        expect(oom).toBe(true);
        // freeing returns nodes; we can alloc again.
        oaFree(a, handles[handles.length - 1]!);
        const h = oaAllocate(a, 16);
        expect(h).not.toBeNull();
    });

    it('null when largest free region is too small (fragmentation)', () => {
        const a = createOffsetAllocator(384, 64);
        const a1 = allocOrThrow(a, 128);
        const a2 = allocOrThrow(a, 128);
        const a3 = allocOrThrow(a, 128);
        // Free non-adjacent.
        oaFree(a, a1);
        oaFree(a, a3);
        // Total free = 256, but no single 256-slot region exists (a2 in middle).
        expect(oaAllocate(a, 256)).toBeNull();
        // 128 still fits twice.
        const r1 = oaAllocate(a, 128);
        const r2 = oaAllocate(a, 128);
        expect(r1).not.toBeNull();
        expect(r2).not.toBeNull();
        // After freeing a2 (with both 128s re-used), the middle still merges
        // adjacency-wise into one 128 region.
        oaFree(a, a2);
        const h = oaAllocate(a, 128);
        expect(h).not.toBeNull();
    });
});

// ── bin boundaries ──────────────────────────────────────────────────

describe('bin boundaries', () => {
    it('allocs straddling bin edges round-trip via the same offset after free+realloc', () => {
        const a = createOffsetAllocator(1024 * 1024, 256);
        for (const size of [7, 8, 9, 15, 16, 17, 31, 32, 33, 127, 128, 129, 1023, 1024, 1025]) {
            const h = allocOrThrow(a, size);
            const off = h.offset;
            oaFree(a, h);
            const h2 = allocOrThrow(a, size);
            expect(h2.offset).toBe(off);
            oaFree(a, h2);
        }
    });
});

// ── randomised stress ───────────────────────────────────────────────

describe('randomised alloc/free stress', () => {
    it('1000-op churn never overlaps and never leaks', () => {
        const capacity = 100_000;
        const a = createOffsetAllocator(capacity, 4096);
        const live: LiveSeg[] = [];

        // Seeded PRNG (xorshift32) for determinism.
        let seed = 0xc0ffee;
        const rand = () => {
            seed ^= seed << 13;
            seed ^= seed >>> 17;
            seed ^= seed << 5;
            return (seed >>> 0) / 0xffffffff;
        };

        for (let i = 0; i < 1000; i++) {
            const wantAlloc = live.length === 0 || (rand() < 0.6 && live.length < 200);
            if (wantAlloc) {
                const size = 1 + Math.floor(rand() * 500);
                const h = oaAllocate(a, size);
                if (h) {
                    live.push({ offset: h.offset, size, handle: h });
                    expect(h.offset + size).toBeLessThanOrEqual(capacity);
                }
            } else {
                const idx = Math.floor(rand() * live.length);
                const seg = live.splice(idx, 1)[0]!;
                oaFree(a, seg.handle);
            }
            assertNoOverlap(live);
        }

        // Drain and verify full reclaim.
        while (live.length > 0) oaFree(a, live.pop()!.handle);
        expect(oaStorageReport(a).totalFree).toBe(capacity);
    });
});

// ── reset ───────────────────────────────────────────────────────────

describe('oaReset', () => {
    it('clears all state and re-seeds full capacity', () => {
        const a = createOffsetAllocator(1024, 64);
        for (let i = 0; i < 5; i++) allocOrThrow(a, 100);
        oaReset(a);
        expect(oaStorageReport(a).totalFree).toBe(1024);
        const h = allocOrThrow(a, 1024);
        expect(h.offset).toBe(0);
    });
});
