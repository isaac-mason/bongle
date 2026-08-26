// ── adaptive region decode pacing ────────────────────────────────────────
//
// mirrors Minecraft's ChunkBatchSizeCalculator (whose "chunk" is actually a
// whole column, our region's equivalent unit): outlier-clamped weighted
// average of nanos-per-region, converted to a regions/tick rate against a
// fixed per-tick time budget. locks in: seeded default before any sample,
// that a sustained decode cost converges the reported rate toward the
// matching throughput, that a one-off outlier sample is clamped rather than
// swinging the estimate wildly, the reported clamp range, and the
// regionCount<=0 no-op.

import { describe, expect, it } from 'vitest';
import { desiredRegionsPerTick, init, recordBatch } from '../../../src/client/voxel-pacing';

describe('voxel-pacing', () => {
    it('seeds a rate matching the default before any real sample lands', () => {
        const pacing = init();
        expect(desiredRegionsPerTick(pacing)).toBeCloseTo(1, 5);
    });

    it('converges toward the rate implied by a sustained decode cost', () => {
        const pacing = init();
        // ~0.5ms/region sustained → 7ms budget / 0.5ms = 14 regions/tick. the
        // seeded default (1 region/tick) starts 14x off this target, a much
        // bigger gap than the weight-capped weighted average closes quickly —
        // 300 samples to give it room to actually converge.
        for (let i = 0; i < 300; i++) recordBatch(pacing, 10, 10 * 500_000);
        expect(desiredRegionsPerTick(pacing)).toBeCloseTo(14, 0);
    });

    it('clamps a single outlier sample instead of reacting to it fully', () => {
        const pacing = init();
        // settle at the seeded default's implied cost first (1 region / 7ms,
        // matching DEFAULT_REGIONS_PER_TICK's seed).
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

    it('reports within [0.01, 64] regions/tick regardless of how extreme the decode cost is', () => {
        const verySlow = init();
        for (let i = 0; i < 60; i++) recordBatch(verySlow, 1, 10_000_000_000); // 10s/region
        expect(desiredRegionsPerTick(verySlow)).toBeGreaterThanOrEqual(0.01);

        const veryFast = init();
        for (let i = 0; i < 60; i++) recordBatch(veryFast, 1000, 1); // ~0ns/region
        expect(desiredRegionsPerTick(veryFast)).toBeLessThanOrEqual(64);
    });

    it('a zero-region batch is a no-op (nothing to sample)', () => {
        const pacing = init();
        const before = { ...pacing };
        recordBatch(pacing, 0, 123_456);
        expect(pacing).toEqual(before);
    });
});
