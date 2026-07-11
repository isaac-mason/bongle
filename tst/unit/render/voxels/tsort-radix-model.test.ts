// CPU mirror of the translucent stable-radix GPU kernels (voxel-resources.ts:
// createRadixCountCompute / createRadixScanCompute / createRadixScatterCompute).
//
// The mirror reproduces the kernels' exact integer math — 1024-item blocks,
// 4 items/thread ownership, 4 rounds of 2-bit stable split with packed 4×8-bit
// counters, pad items as digit 0xFF, run-start rank derivation, and the
// digit-major [digit*numBlocks + block] histogram scan — so the tricky parts
// (counter packing, pad sinking, rank math, cross-block stability) are verified
// against a reference stable sort without needing a GPU in CI. If a kernel's
// math changes, change this mirror to match.

import { describe, expect, it } from 'vitest';

const RADIX_WG = 256;
const RADIX_ITEMS = 4;
const RADIX_BLOCK = RADIX_WG * RADIX_ITEMS; // 1024
const PASSES = 4;

/** one full 4-pass LSD radix sort, mirroring the GPU kernel structure.
 *
 *  Mirrors the fused-count/(key, idx) form: the passes shuffle (key, ORIGINAL
 *  INDEX) pairs and the payload is gathered once at the end (the GPU's last
 *  scatter). The per-pass histogram here is computed standalone — the GPU fuses
 *  it into the previous scatter, but a digit histogram over the same key
 *  multiset is order-independent, so the values are identical by construction. */
function radixSortModel(keysIn: number[], payloadIn: number[]): { keys: number[]; payload: number[] } {
    let srcK = keysIn.slice();
    let srcP = keysIn.map((_, i) => i); // sort indices, not payloads
    const n = srcK.length;
    const nb = Math.ceil(n / RADIX_BLOCK);

    for (let pass = 0; pass < PASSES; pass++) {
        const shift = pass * 8;

        // ── count: hist[digit*nb + b], real items only ──────────────
        const hist = new Array<number>(256 * nb).fill(0);
        for (let b = 0; b < nb; b++) {
            for (let j = 0; j < RADIX_BLOCK; j++) {
                const g = b * RADIX_BLOCK + j;
                if (g >= n) break;
                hist[((srcK[g]! >>> shift) & 255) * nb + b]!++;
            }
        }

        // ── scan: flat exclusive prefix over the digit-major array ──
        let run = 0;
        for (let i = 0; i < 256 * nb; i++) {
            const v = hist[i]!;
            hist[i] = run;
            run += v;
        }

        // ── scatter: per block, stable local 2-bit splits + rank ────
        const dstK = new Array<number>(n).fill(0);
        const dstP = new Array<number>(n).fill(0);
        for (let b = 0; b < nb; b++) {
            const blockBase = b * RADIX_BLOCK;
            const blockCount = Math.min(RADIX_BLOCK, n - blockBase);
            // packed digit cache; pads (item ≥ blockCount) get 0xFF.
            const digOf = (item: number): number => (item < blockCount ? (srcK[blockBase + item]! >>> shift) & 255 : 255);

            // 4 rounds of stable 2-bit split (thread t owns slots t*4..t*4+3).
            // Counters are 16-bit fields, 2 per u32 (lo: v0|v1, hi: v2|v3) —
            // block totals reach 1024, so 8-bit fields would overflow.
            let idx = Array.from({ length: RADIX_BLOCK }, (_, i) => i);
            for (let r = 0; r < 4; r++) {
                const cntLo = new Array<number>(RADIX_WG).fill(0);
                const cntHi = new Array<number>(RADIX_WG).fill(0);
                for (let t = 0; t < RADIX_WG; t++) {
                    for (let k = 0; k < RADIX_ITEMS; k++) {
                        const v = (digOf(idx[t * RADIX_ITEMS + k]!) >>> (2 * r)) & 3;
                        if (v < 2) cntLo[t] = (cntLo[t]! + (1 << (16 * v))) >>> 0;
                        else cntHi[t] = (cntHi[t]! + (1 << (16 * (v - 2)))) >>> 0;
                    }
                }
                // inclusive Hillis scan over both packed-counter words.
                const incLo = new Array<number>(RADIX_WG).fill(0);
                const incHi = new Array<number>(RADIX_WG).fill(0);
                let accLo = 0;
                let accHi = 0;
                for (let t = 0; t < RADIX_WG; t++) {
                    accLo = (accLo + cntLo[t]!) >>> 0;
                    accHi = (accHi + cntHi[t]!) >>> 0;
                    incLo[t] = accLo;
                    incHi[t] = accHi;
                }
                const totalLo = incLo[RADIX_WG - 1]!;
                const totalHi = incHi[RADIX_WG - 1]!;
                const base1 = totalLo & 0xffff;
                const base2 = base1 + (totalLo >>> 16);
                const base3 = base2 + (totalHi & 0xffff);
                const next = new Array<number>(RADIX_BLOCK).fill(0);
                for (let t = 0; t < RADIX_WG; t++) {
                    const exclLo = (incLo[t]! - cntLo[t]!) >>> 0;
                    const exclHi = (incHi[t]! - cntHi[t]!) >>> 0;
                    const start = [exclLo & 0xffff, base1 + (exclLo >>> 16), base2 + (exclHi & 0xffff), base3 + (exclHi >>> 16)];
                    for (let k = 0; k < RADIX_ITEMS; k++) {
                        const item = idx[t * RADIX_ITEMS + k]!;
                        const v = (digOf(item) >>> (2 * r)) & 3;
                        next[start[v]!] = item;
                        start[v]!++;
                    }
                }
                idx = next;
            }

            // run starts (position j begins digit d's run iff j==0 or change).
            const runStart = new Array<number>(256).fill(0);
            for (let j = 0; j < RADIX_BLOCK; j++) {
                const dj = digOf(idx[j]!);
                if (j === 0 || dj !== digOf(idx[j - 1]!)) runStart[dj] = j;
            }
            // write-out: skip pads; dst = scanned base + in-run rank.
            for (let j = 0; j < RADIX_BLOCK; j++) {
                const item = idx[j]!;
                if (item >= blockCount) continue;
                const g = blockBase + item;
                const dig = (srcK[g]! >>> shift) & 255;
                const dst = hist[dig * nb + b]! + (j - runStart[dig]!);
                dstK[dst] = srcK[g]!;
                dstP[dst] = srcP[g]!;
            }
        }
        srcK = dstK;
        srcP = dstP;
    }
    // final gather (the GPU's last-scatter variant): payload by sorted index.
    return { keys: srcK, payload: srcP.map((idx) => payloadIn[idx]!) };
}

/** reference: stable ascending sort by full 32-bit key. */
function referenceStableSort(keys: number[], payload: number[]): { keys: number[]; payload: number[] } {
    const order = keys.map((k, i) => [k >>> 0, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return { keys: order.map(([k]) => k), payload: order.map(([, i]) => payload[i]!) };
}

/** per-block stable local sort by the pass digit (the scatter's in-workgroup
 *  phase): returns the sorted local ordering + per-digit run starts. Exact
 *  mirror of the 4×2-bit split + boundary-detection code above. */
function stableSortBlock(srcK: number[], blockBase: number, blockCount: number, shift: number): { idx: number[]; runStart: number[] } {
    const digOf = (item: number): number => (item < blockCount ? (srcK[blockBase + item]! >>> shift) & 255 : 255);
    let idx = Array.from({ length: RADIX_BLOCK }, (_, i) => i);
    for (let r = 0; r < 4; r++) {
        const cntLo = new Array<number>(RADIX_WG).fill(0);
        const cntHi = new Array<number>(RADIX_WG).fill(0);
        for (let t = 0; t < RADIX_WG; t++) {
            for (let k = 0; k < RADIX_ITEMS; k++) {
                const v = (digOf(idx[t * RADIX_ITEMS + k]!) >>> (2 * r)) & 3;
                if (v < 2) cntLo[t] = (cntLo[t]! + (1 << (16 * v))) >>> 0;
                else cntHi[t] = (cntHi[t]! + (1 << (16 * (v - 2)))) >>> 0;
            }
        }
        const incLo = new Array<number>(RADIX_WG).fill(0);
        const incHi = new Array<number>(RADIX_WG).fill(0);
        let accLo = 0;
        let accHi = 0;
        for (let t = 0; t < RADIX_WG; t++) {
            accLo = (accLo + cntLo[t]!) >>> 0;
            accHi = (accHi + cntHi[t]!) >>> 0;
            incLo[t] = accLo;
            incHi[t] = accHi;
        }
        const totalLo = incLo[RADIX_WG - 1]!;
        const totalHi = incHi[RADIX_WG - 1]!;
        const base1 = totalLo & 0xffff;
        const base2 = base1 + (totalLo >>> 16);
        const base3 = base2 + (totalHi & 0xffff);
        const next = new Array<number>(RADIX_BLOCK).fill(0);
        for (let t = 0; t < RADIX_WG; t++) {
            const exclLo = (incLo[t]! - cntLo[t]!) >>> 0;
            const exclHi = (incHi[t]! - cntHi[t]!) >>> 0;
            const start = [exclLo & 0xffff, base1 + (exclLo >>> 16), base2 + (exclHi & 0xffff), base3 + (exclHi >>> 16)];
            for (let k = 0; k < RADIX_ITEMS; k++) {
                const item = idx[t * RADIX_ITEMS + k]!;
                const v = (digOf(item) >>> (2 * r)) & 3;
                next[start[v]!] = item;
                start[v]!++;
            }
        }
        idx = next;
    }
    const runStart = new Array<number>(256).fill(0);
    for (let j = 0; j < RADIX_BLOCK; j++) {
        const dj = digOf(idx[j]!);
        if (j === 0 || dj !== digOf(idx[j - 1]!)) runStart[dj] = j;
    }
    return { idx, runStart };
}

/**
 * FULL fused-chain mirror: count₀ (self-zeroing columns) → 4 × (scan-with-
 * cross-zero → scatter-with-fused-next-count), with FIXED maxBlocks row stride,
 * hist ping-pong (counts for digit p in hist[p%2]), zeroTo = max(nb, prevNb)
 * tracked ACROSS FIRES, and persistent histogram buffers between fires — the
 * exact state machine the GPU runs. The simple model above cannot see fused-
 * count or cross-fire staleness bugs; this one exists to catch them.
 */
function fusedChainModel(maxBlocks: number) {
    // persistent state across fires (the GPU buffers).
    const hists = [new Array<number>(256 * maxBlocks).fill(0), new Array<number>(256 * maxBlocks).fill(0)];
    let prevNb = 0; // args[4]

    return function fire(keysIn: number[], payloadIn: number[]): { keys: number[]; payload: number[] } {
        const n = keysIn.length;
        const nb = Math.ceil(n / RADIX_BLOCK);
        const zeroTo = Math.max(nb, prevNb); // args[5]
        prevNb = nb;

        let srcK = keysIn.slice();
        let srcI = keysIn.map((_, i) => i);

        // ── count₀: workgroup b zeroes its column, tallies digit 0 ──
        const histA = hists[0]!;
        for (let b = 0; b < nb; b++) {
            for (let t = 0; t < 256; t++) histA[t * maxBlocks + b] = 0;
            for (let j = 0; j < RADIX_BLOCK; j++) {
                const g = b * RADIX_BLOCK + j;
                if (g >= n) break;
                histA[(srcK[g]! & 255) * maxBlocks + b]!++;
            }
        }

        for (let pass = 0; pass < PASSES; pass++) {
            const shift = pass * 8;
            const histCur = hists[pass % 2]!;
            const histNext = hists[(pass + 1) % 2]!;

            // ── scan: zero the other hist's rows (≤ zeroTo), then flat
            //    exclusive prefix of the current hist's live cells in place ──
            for (let t = 0; t < 256; t++) {
                for (let iz = 0; iz < zeroTo; iz++) histNext[t * maxBlocks + iz] = 0;
            }
            let run = 0;
            for (let t = 0; t < 256; t++) {
                for (let i = 0; i < nb; i++) {
                    const idx = t * maxBlocks + i;
                    const v = histCur[idx]!;
                    histCur[idx] = run;
                    run += v;
                }
            }

            // ── scatter: stable local sort + write; fused count of the NEXT
            //    digit at the DESTINATION block into histNext (passes 0..2) ──
            const dstK = new Array<number>(n).fill(0);
            const dstI = new Array<number>(n).fill(0);
            for (let b = 0; b < nb; b++) {
                const blockBase = b * RADIX_BLOCK;
                const blockCount = Math.min(RADIX_BLOCK, n - blockBase);
                const { idx, runStart } = stableSortBlock(srcK, blockBase, blockCount, shift);
                for (let j = 0; j < RADIX_BLOCK; j++) {
                    const item = idx[j]!;
                    if (item >= blockCount) continue;
                    const g = blockBase + item;
                    const key = srcK[g]!;
                    const dig = (key >>> shift) & 255;
                    const dst = histCur[dig * maxBlocks + b]! + (j - runStart[dig]!);
                    dstK[dst] = key;
                    dstI[dst] = srcI[g]!;
                    if (pass < 3) {
                        const dig1 = (key >>> (shift + 8)) & 255;
                        histNext[dig1 * maxBlocks + (dst >> 10)]!++;
                    }
                }
            }
            srcK = dstK;
            srcI = dstI;
        }
        return { keys: srcK, payload: srcI.map((idx) => payloadIn[idx]!) };
    };
}

/** deterministic LCG so failures reproduce. */
function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s;
    };
}

function check(keys: number[]): void {
    const payload = keys.map((_, i) => i); // payload = original index
    const got = radixSortModel(keys, payload);
    const want = referenceStableSort(keys, payload);
    expect(got.keys).toEqual(want.keys);
    expect(got.payload).toEqual(want.payload); // stability: equal keys keep input order
}

describe('translucent radix sort model (GPU kernel mirror)', () => {
    it('sorts empty / single / tiny inputs', () => {
        check([]);
        check([42]);
        check([5, 3, 5, 1, 0xffffffff]);
    });

    it('handles block-boundary sizes (tail masking + pad sinking)', () => {
        const rng = makeRng(7);
        for (const n of [1023, 1024, 1025, 2047, 2048, 2049, 4096]) {
            check(Array.from({ length: n }, () => rng()));
        }
    });

    it('sorts uniform random 32-bit keys', () => {
        const rng = makeRng(1);
        check(Array.from({ length: 5000 }, () => rng()));
    });

    it('keeps stability under heavy duplicates (few distinct keys)', () => {
        const rng = makeRng(2);
        check(Array.from({ length: 3000 }, () => rng() % 7));
    });

    it('handles all-equal keys (single global tie run)', () => {
        check(new Array(2500).fill(0xdeadbeef >>> 0));
    });

    it('handles digit-0xFF keys vs pads (pads must not displace real items)', () => {
        // keys whose every digit is 0xFF collide with the pad digit in every
        // pass; with a non-multiple-of-1024 length, pads must still sink after
        // them in every block.
        const rng = makeRng(3);
        const keys = Array.from({ length: 1500 }, (_, i) => (i % 3 === 0 ? 0xffffffff : rng()));
        check(keys);
    });

    it('FULL FUSED CHAIN: single fire matches reference (fused counts + ping-pong hists)', () => {
        const rng = makeRng(11);
        const maxBlocks = 8; // 8192-item capacity
        for (const n of [1, 100, 1024, 1025, 3000, 8000]) {
            const fire = fusedChainModel(maxBlocks);
            const keys = Array.from({ length: n }, () => rng());
            const payload = keys.map((_, i) => i + 1000);
            const got = fire(keys, payload);
            const want = referenceStableSort(keys, payload);
            expect(got.keys).toEqual(want.keys);
            expect(got.payload).toEqual(want.payload);
        }
    });

    it('FULL FUSED CHAIN: multi-fire sequences with varying N (cross-fire staleness)', () => {
        const rng = makeRng(12);
        const maxBlocks = 8;
        const fire = fusedChainModel(maxBlocks);
        // shrink → grow → shrink → grow patterns exercise prevNb/zeroTo and
        // stale bases/counts left in both histograms between fires.
        for (const n of [5000, 100, 3000, 3000, 1, 8000, 0, 2048, 2049]) {
            const keys = Array.from({ length: n }, () => rng());
            const payload = keys.map((_, i) => i);
            const got = fire(keys, payload);
            const want = referenceStableSort(keys, payload);
            expect(got.keys).toEqual(want.keys);
            expect(got.payload).toEqual(want.payload);
        }
    });

    it('FULL FUSED CHAIN: heavy duplicates + realistic key packing across fires', () => {
        const rng = makeRng(13);
        const maxBlocks = 8;
        const fire = fusedChainModel(maxBlocks);
        for (const n of [4000, 500, 4000]) {
            const keys: number[] = [];
            for (let i = 0; i < n; i++) {
                const bucket = rng() % 4; // few buckets → constant high digits
                const dist = i % 3 === 0 ? 99999 : rng() % (1 << 26);
                keys.push(((bucket << 26) | dist) >>> 0);
            }
            const payload = keys.map((_, i) => i);
            const got = fire(keys, payload);
            const want = referenceStableSort(keys, payload);
            expect(got.keys).toEqual(want.keys);
            expect(got.payload).toEqual(want.payload);
        }
    });

    it('sorts realistic sort keys (bucket|dist|facing packing)', () => {
        // mirror the expand kernel's key shape: [bucket:6][dist:26],
        // with many exactly-tied dist levels (coincident faces) across buckets.
        const rng = makeRng(4);
        const keys: number[] = [];
        for (let i = 0; i < 6000; i++) {
            const bucket = rng() % 64;
            const dist = i % 5 === 0 ? 1234567 : rng() % (1 << 26); // 20% exact dist ties
            keys.push(((bucket << 26) | dist) >>> 0);
        }
        check(keys);
    });
});
