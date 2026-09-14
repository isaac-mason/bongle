export type RegionBatchPacing = {
    aggregatedNanosPerRegion: number;
    /** divisor in the running average; grows toward OLD_SAMPLES_WEIGHT_CAP so
     *  early samples swing the estimate fast and later ones barely nudge it. */
    oldSamplesWeight: number;
};

const OLD_SAMPLES_WEIGHT_CAP = 49;

/** target region-processing budget per server tick, in nanoseconds. */
const TARGET_NANOS_PER_TICK = 7_000_000;

/** must match discovery.ts's DEFAULT_REGIONS_PER_TICK; seeds the estimate
 *  before any real sample has landed. */
const DEFAULT_REGIONS_PER_TICK = 1;

const MIN_REGIONS_PER_TICK = 0.01;
const MAX_REGIONS_PER_TICK = 64;

export function init(): RegionBatchPacing {
    return { aggregatedNanosPerRegion: TARGET_NANOS_PER_TICK / DEFAULT_REGIONS_PER_TICK, oldSamplesWeight: 1 };
}

/** fold one batch's measured decode cost into the smoothed estimate. */
export function recordBatch(pacing: RegionBatchPacing, regionCount: number, elapsedNanos: number): void {
    if (regionCount <= 0) return;
    const nanosPerRegion = elapsedNanos / regionCount;
    const clamped = Math.min(Math.max(nanosPerRegion, pacing.aggregatedNanosPerRegion / 3), pacing.aggregatedNanosPerRegion * 3);
    pacing.aggregatedNanosPerRegion =
        (pacing.aggregatedNanosPerRegion * pacing.oldSamplesWeight + clamped) / (pacing.oldSamplesWeight + 1);
    pacing.oldSamplesWeight = Math.min(pacing.oldSamplesWeight + 1, OLD_SAMPLES_WEIGHT_CAP);
}

/** this client's current best estimate of how many regions/tick it can
 *  decode, reported to the server on every voxel_ack. */
export function desiredRegionsPerTick(pacing: RegionBatchPacing): number {
    const rate = TARGET_NANOS_PER_TICK / pacing.aggregatedNanosPerRegion;
    return Math.min(Math.max(rate, MIN_REGIONS_PER_TICK), MAX_REGIONS_PER_TICK);
}
