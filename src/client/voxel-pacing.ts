export type RegionBatchPacing = {
    aggregatedNanosPerRegion: number;
    /** divisor in the running average; grows toward OLD_SAMPLES_WEIGHT_CAP so
     *  early samples swing the estimate fast and later ones barely nudge it. */
    oldSamplesWeight: number;
    /** smoothed render-frame duration (seconds). The decode budget is spent once per
     *  frame, so this is what turns a per-frame budget into the per-second figure the
     *  server is told about. */
    smoothedFrameSeconds: number;
};

const OLD_SAMPLES_WEIGHT_CAP = 49;

/** target region-processing budget per RENDER FRAME, in nanoseconds. Decoding happens in
 *  the frame's inbox pass, so this is a slice of a frame and has nothing to do with the
 *  server's cadence: it stays fixed however fast or slow the room ticks. */
const TARGET_NANOS_PER_FRAME = 7_000_000;

/** seeds the estimate before any real sample has landed: one region in a frame's budget. */
const DEFAULT_REGIONS_PER_FRAME = 1;

/** how fast a frame is assumed to be until real ones have been observed. */
const DEFAULT_FRAME_SECONDS = 1 / 60;

/** smoothing on the frame-duration estimate; a single long frame shouldn't collapse the
 *  reported rate, and a single short one shouldn't spike it. */
const FRAME_SMOOTHING = 0.1;

const MIN_REGIONS_PER_SECOND = 0.6;
const MAX_REGIONS_PER_SECOND = 3840;

export function init(): RegionBatchPacing {
    return {
        aggregatedNanosPerRegion: TARGET_NANOS_PER_FRAME / DEFAULT_REGIONS_PER_FRAME,
        oldSamplesWeight: 1,
        smoothedFrameSeconds: DEFAULT_FRAME_SECONDS,
    };
}

/** fold one render frame's duration into the estimate; called wherever acks are flushed. */
export function recordFrame(pacing: RegionBatchPacing, frameSeconds: number): void {
    if (!(frameSeconds > 0)) return;
    pacing.smoothedFrameSeconds += (frameSeconds - pacing.smoothedFrameSeconds) * FRAME_SMOOTHING;
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

/** this client's current best estimate of how many regions per SECOND it can decode,
 *  reported to the server on every voxel_ack: the per-frame budget spent as often as
 *  frames actually arrive. */
export function desiredRegionsPerSecond(pacing: RegionBatchPacing): number {
    const perFrame = TARGET_NANOS_PER_FRAME / pacing.aggregatedNanosPerRegion;
    const rate = perFrame / pacing.smoothedFrameSeconds;
    return Math.min(Math.max(rate, MIN_REGIONS_PER_SECOND), MAX_REGIONS_PER_SECOND);
}
