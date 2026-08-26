// per-player adaptive region decode pacing, reported to the server so
// dispatchRegionFull can size its per-tick budget to what THIS client can
// actually decode instead of a fixed constant. mirrors Minecraft's
// ChunkBatchSizeCalculator (whose "chunk" is actually a whole column, the same
// bundling unit our region is): a batch (one processInbox pass' worth of
// voxel_region_full messages) yields a nanos-per-region sample, which is
// outlier-clamped against the current estimate (rejects a one-off GC pause or
// warm-up spike) then folded into a weighted running average whose weight
// grows toward a cap — early samples move the estimate fast, later ones barely
// nudge it. the server applies the reported rate directly with no further
// smoothing, since the client already produced a stable number. a region mixes
// occupied and air chunk slots, so this naturally blends the cost of dense and
// sparse regions into one realistic rate over time, the same way Minecraft's
// per-column measurement blends sections of varying density.

export type RegionBatchPacing = {
    aggregatedNanosPerRegion: number;
    /** grows toward OLD_SAMPLES_WEIGHT_CAP each batch; the divisor in the
     *  running average, so a low weight lets early samples swing the estimate
     *  quickly and a high weight makes it stable once warmed up. */
    oldSamplesWeight: number;
};

const OLD_SAMPLES_WEIGHT_CAP = 49;

/** target region-processing budget per server tick, in nanoseconds — matches
 *  Minecraft's ChunkBatchSizeCalculator constant. converted to a regions/tick
 *  rate via `TARGET_NANOS_PER_TICK / aggregatedNanosPerRegion`. */
const TARGET_NANOS_PER_TICK = 7_000_000;

/** matches discovery.ts's DEFAULT_REGIONS_PER_TICK — seeds the estimate before
 *  any real sample has landed, so the first few ticks behave like a
 *  conservative fixed-constant pacing rather than guessing wildly. */
const DEFAULT_REGIONS_PER_TICK = 1;

const MIN_REGIONS_PER_TICK = 0.01;
const MAX_REGIONS_PER_TICK = 64;

export function init(): RegionBatchPacing {
    return { aggregatedNanosPerRegion: TARGET_NANOS_PER_TICK / DEFAULT_REGIONS_PER_TICK, oldSamplesWeight: 1 };
}

/** fold one batch's measured decode cost into the smoothed estimate. a no-op
 *  if nothing was decoded (nothing to sample). */
export function recordBatch(pacing: RegionBatchPacing, regionCount: number, elapsedNanos: number): void {
    if (regionCount <= 0) return;
    const nanosPerRegion = elapsedNanos / regionCount;
    const clamped = Math.min(Math.max(nanosPerRegion, pacing.aggregatedNanosPerRegion / 3), pacing.aggregatedNanosPerRegion * 3);
    pacing.aggregatedNanosPerRegion = (pacing.aggregatedNanosPerRegion * pacing.oldSamplesWeight + clamped) / (pacing.oldSamplesWeight + 1);
    pacing.oldSamplesWeight = Math.min(pacing.oldSamplesWeight + 1, OLD_SAMPLES_WEIGHT_CAP);
}

/** this client's current best estimate of how many regions/tick it can
 *  decode, reported to the server on every voxel_ack. */
export function desiredRegionsPerTick(pacing: RegionBatchPacing): number {
    const rate = TARGET_NANOS_PER_TICK / pacing.aggregatedNanosPerRegion;
    return Math.min(Math.max(rate, MIN_REGIONS_PER_TICK), MAX_REGIONS_PER_TICK);
}
