// ── sync dirtiness + rate ─────────────────────────────────────────────
//
// two orthogonal per-sync policies, and the send-side helpers that read them:
//   - `dirty`: WHAT counts as a change worth sending (byte-diff or explicit-only).
//     consumed by the diff pass (sync-diff.ts).
//   - `rate`: HOW OFTEN a dirty value may send, at most. consumed by the send
//     path (discovery.ts fanout). nothing un-dirty ever sends, regardless of rate.
//
// diff detection still runs every tick for all nodes (cheap byte compare); rate
// gating only applies to the send path (serialization + network I/O).

/**
 * `dirty` policy constructors — what counts as a change worth sending. byte-diff is
 * the default; producers that don't reliably byte-change (set-once fields) opt into
 * `explicit` and mark themselves dirty via `SyncHandle.dirty()`.
 */
export const dirty = {
    /** dirty on any byte change (the default). */
    diff: (): 'diff' => 'diff',
    /** never auto-dirty; only `SyncHandle.dirty()` marks it. */
    explicit: (): 'explicit' => 'explicit',
};

/**
 * `rate` policy constructors — the maximum send cadence for a dirty value.
 */
export const rate = {
    /** send at most `hz` times/sec (a per-field time-gate, Quake's snapshotMsec). */
    hz: (hz: number): { hz: number } => ({ hz }),
    /** send every tick the value is dirty (the default, no throttle). */
    realtime: (): 'realtime' => 'realtime',
};

/**
 * returns true if a dirty value may send this tick given its `hz` cap and timing.
 */
export function shouldSendThisTick(hz: number, lastSentTick: number, currentTick: number, tickRate: number): boolean {
    if (hz <= 0) return false;
    const ticksPerSend = tickRate / hz;
    return currentTick - lastSentTick >= ticksPerSend;
}
