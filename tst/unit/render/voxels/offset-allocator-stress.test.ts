// randomized alloc / free / mass-free (room swap) cycles; every live segment must
// stay disjoint and freeStorage must equal capacity minus live bytes.

import { describe, expect, it } from 'vitest';
import {
    createOffsetAllocator,
    type OAHandle,
    oaAllocate,
    oaFree,
    oaStorageReport,
} from '../../../../src/render/offset-allocator';

function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

describe('OffsetAllocator stress', () => {
    it('random alloc/free/clear-all cycles never overlap and never leak', { timeout: 60000 }, () => {
        for (let seed = 1; seed <= 12; seed++) {
            const rand = rng(seed);
            const capacity = 1 << 16;
            const a = createOffsetAllocator(capacity, 4096);
            const live = new Map<number, { handle: OAHandle; size: number }>();
            let liveTotal = 0;
            for (let op = 0; op < 6000; op++) {
                const r = rand();
                if (r < 0.55) {
                    const size = 1 + Math.floor(rand() * (rand() < 0.1 ? 900 : 60));
                    const h = oaAllocate(a, size);
                    if (!h) continue;
                    expect(live.has(h.offset)).toBe(false);
                    live.set(h.offset, { handle: h, size });
                    liveTotal += size;
                } else if (r < 0.97) {
                    if (live.size === 0) continue;
                    const keys = [...live.keys()];
                    const key = keys[Math.floor(rand() * keys.length)]!;
                    const seg = live.get(key)!;
                    live.delete(key);
                    liveTotal -= seg.size;
                    oaFree(a, seg.handle);
                } else {
                    // room swap: free everything in map order
                    for (const seg of live.values()) oaFree(a, seg.handle);
                    live.clear();
                    liveTotal = 0;
                }
                if (op % 400 === 0 || r >= 0.97) {
                    const sorted = [...live.values()].sort((x, y) => x.handle.offset - y.handle.offset);
                    for (let i = 1; i < sorted.length; i++) {
                        const p = sorted[i - 1]!;
                        const c = sorted[i]!;
                        expect(c.handle.offset).toBeGreaterThanOrEqual(p.handle.offset + p.size);
                    }
                    if (sorted.length)
                        expect(sorted[sorted.length - 1]!.handle.offset + sorted[sorted.length - 1]!.size).toBeLessThanOrEqual(
                            capacity,
                        );
                    expect(oaStorageReport(a).totalFree).toBe(capacity - liveTotal);
                }
            }
        }
    });
});
