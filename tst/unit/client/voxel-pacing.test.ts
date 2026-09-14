// ── adaptive region decode pacing ────────────────────────────────────────
//
// mirrors Minecraft's ChunkBatchSizeCalculator (whose "chunk" is actually a
// whole column, our region's equivalent unit): outlier-clamped weighted
// average of nanos-per-region, converted to a regions/SECOND rate against a
// fixed per-render-frame time budget. per-second because the budget is spent
// per client frame while the server spends it per tick, and the two rates are
// independent. locks in: seeded default before any sample, that a sustained
// decode cost converges the reported rate toward the matching throughput, that
// a one-off outlier sample is clamped rather than swinging the estimate wildly,
// the reported clamp range, and the regionCount<=0 no-op.

import { describe, expect, it } from 'vitest';
import { desiredRegionsPerSecond, init, recordBatch, recordFrame } from '../../../src/client/voxel-pacing';

describe('voxel-pacing', () => {
    it('seeds a rate matching the default before any real sample lands', () => {
        const pacing = init();
        // one region per frame's budget, at the assumed 60fps until frames are observed.
        expect(desiredRegionsPerSecond(pacing)).toBeCloseTo(60, 5);
    });

    it('converges toward the rate implied by a sustained decode cost', () => {
        const pacing = init();
        // ~0.5ms/region sustained → 7ms budget / 0.5ms = 14 regions per frame, and
        // 14 * 60fps = 840/s. the seeded default starts 14x off this target, a much
        // bigger gap than the weight-capped weighted average closes quickly —
        // 300 samples to give it room to actually converge.
        for (let i = 0; i < 300; i++) recordBatch(pacing, 10, 10 * 500_000);
        expect(desiredRegionsPerSecond(pacing)).toBeCloseTo(840, -1);
    });

    it('reports the same throughput when frames are slower, spread over fewer of them', () => {
        const fast = init();
        const slow = init();
        for (let i = 0; i < 300; i++) {
            recordBatch(fast, 10, 10 * 500_000);
            recordBatch(slow, 10, 10 * 500_000);
        }
        // a 30fps client spends the same per-frame budget half as often, so it asks
        // for half the per-second throughput.
        for (let i = 0; i < 200; i++) recordFrame(slow, 1 / 30);
        expect(desiredRegionsPerSecond(slow)).toBeCloseTo(desiredRegionsPerSecond(fast) / 2, -1);
    });

    it('clamps a single outlier sample instead of reacting to it fully', () => {
        const pacing = init();
        // settle at the seeded default's implied cost first (1 region / 7ms,
        // matching the per-frame seed).
        for (let i = 0; i < 20; i++) recordBatch(pacing, 1, 7_000_000);
        const before = pacing.aggregatedNanosPerRegion;

        // one wildly slow batch (e.g. a GC pause) — 100x the settled cost.
        recordBatch(pacing, 1, before * 100);

        // the sample itself is clamped to at most 3x the pre-sample estimate,
        // and then folded into a weighted average with ~20 prior samples behind
        // it, so the result moves but stays far below the raw 100x outlier.
        expect(pacing.aggregatedNanosPerRegion).toBeLessThan(before * 3);
        expect(pacing.aggregatedNanosPerRegion).toBeGreaterThan(before);
    });

    it('reports within [0.6, 3840] regions/second regardless of how extreme the decode cost is', () => {
        const verySlow = init();
        for (let i = 0; i < 60; i++) recordBatch(verySlow, 1, 10_000_000_000); // 10s/region
        expect(desiredRegionsPerSecond(verySlow)).toBeGreaterThanOrEqual(0.6);

        const veryFast = init();
        for (let i = 0; i < 60; i++) recordBatch(veryFast, 1000, 1); // ~0ns/region
        expect(desiredRegionsPerSecond(veryFast)).toBeLessThanOrEqual(3840);
    });

    it('a zero-region batch is a no-op (nothing to sample)', () => {
        const pacing = init();
        const before = { ...pacing };
        recordBatch(pacing, 0, 123_456);
        expect(pacing).toEqual(before);
    });
});
