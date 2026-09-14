/** `dirty` policy constructors. Byte-diff is the default; set-once fields that don't reliably byte-change opt into `explicit` and mark themselves via `SyncHandle.dirty()`. */
export const dirty = {
    /** dirty on any byte change (the default). */
    diff: (): 'diff' => 'diff',
    /** never auto-dirty; only `SyncHandle.dirty()` marks it. */
    explicit: (): 'explicit' => 'explicit',
};

/** `rate` policy constructors: the maximum send cadence for a dirty value. */
export const rate = {
    /** Sends at most `hz` times/sec, a per-field time-gate. */
    hz: (hz: number): { hz: number } => ({ hz }),
    /** Sends every tick the value is dirty (the default, no throttle). */
    realtime: (): 'realtime' => 'realtime',
};

/** True if a dirty value may send this tick given its `hz` cap and timing. */
export function shouldSendThisTick(hz: number, lastSentTick: number, currentTick: number, tickRate: number): boolean {
    if (hz <= 0) return false;
    const ticksPerSend = tickRate / hz;
    return currentTick - lastSentTick >= ticksPerSend;
}
