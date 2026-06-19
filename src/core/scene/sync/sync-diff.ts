// ── shared per-slice change detection ────────────────────────────────
//
// the single source of truth for "did this sync slice change enough to emit
// this tick", used by BOTH directions:
//   - server diff (discovery.ts)        — server-authority broadcast
//   - client upload (replication.ts)    — owner-authority send
//
// keeping one implementation means the byte-diff and the ThresholdRate metric
// behave identically on both ends — no drift between mirror copies.
//
// the per-slice snapshot (last-emitted bytes + value) lives on the trait
// instance's `_sync` arrays, indexed by slice — so this is array indexing, not
// keyed side-map lookups.

import type { Node } from '../nodes';
import type { SyncCodec } from '../packcat-bridge';
import type { SyncDef, TraitBase, TraitSyncState } from '../traits';
import { bytesEqual } from '../../utils/bytes';

// reusable scratch for the byte-diff path. `packInto` writes here instead of
// allocating a fresh Uint8Array per slice per tick — we only copy out (alloc)
// when a slice actually changed. grows to the largest slice ever seen, then
// stays put. the diff is sequential + single-threaded, so one shared buffer is
// safe across every slice.
let scratch = new Uint8Array(256);

/**
 * snapshot a ThresholdRate slice's last-emitted `value`. `value` is a live
 * reference, so it must be copied — reusing `prev`'s buffer when shape-compatible
 * (zero-alloc steady state), cloning otherwise. scalars store directly.
 */
export function captureValue(prev: unknown, value: unknown): unknown {
    if (typeof value !== 'object' || value === null) return value;
    const v = value as ArrayLike<number>;
    if ((Array.isArray(prev) || ArrayBuffer.isView(prev)) && (prev as ArrayLike<number>).length === v.length) {
        const p = prev as { [i: number]: number };
        for (let i = 0; i < v.length; i++) p[i] = v[i]!;
        return prev;
    }
    return Array.isArray(v) ? (v as number[]).slice() : (v as Float32Array).slice();
}

/**
 * pack `instance`'s slice into the shared scratch, growing it once to the exact
 * size `packInto` reports if it didn't fit. returns bytes written (>0), or ≤0
 * when there's nothing to pack (no serdes / pack error).
 */
function packToScratch(codec: SyncCodec, instance: TraitBase, node: Node): number {
    let n = codec.packInto(instance, node, scratch, 0);
    if (n < 0) {
        scratch = new Uint8Array(-n);
        n = codec.packInto(instance, node, scratch, 0);
    }
    return n;
}

/**
 * store `scratch[0:n]` as slice `i`'s snapshot, reusing the existing buffer in
 * place when the size matches — so a *changed* fixed-size slice (the common
 * case: positions, quaternions, scalars) costs a copy, not an allocation. only
 * first-seen or a size change allocates.
 *
 * mutating in place is safe because the snapshot buffer is aliased into THIS
 * tick's scene_sync messages (readChangedFields hands out the buffer directly),
 * and those are serialized in netflush before the next tick's diff overwrites
 * here — last tick's bytes are already on the wire. (if scene_sync ever gains a
 * cross-tick resend buffer, this must copy instead.)
 */
function storeSnapshot(sync: TraitSyncState, i: number, n: number): void {
    const prev = sync.bytes[i];
    if (prev !== undefined && prev.length === n) prev.set(scratch.subarray(0, n));
    else sync.bytes[i] = scratch.slice(0, n);
}

/**
 * pack + store slice `i`'s snapshot unconditionally — for the dirty fast-path,
 * which already knows the slice changed (no byte-diff needed). shares the same
 * in-place buffer reuse as the diff path.
 */
export function writeSnapshot(codec: SyncCodec, instance: TraitBase, node: Node, i: number, sync: TraitSyncState): void {
    const n = packToScratch(codec, instance, node);
    if (n > 0) storeSnapshot(sync, i, n);
}

/**
 * decide whether `syncDef`'s slice `i` on `instance` should emit this tick,
 * updating the byte snapshot (+ the value snapshot for ThresholdRate) to the
 * emitted value when so. after a `true` return the freshly packed bytes are in
 * `sync.bytes[i]`, ready for the caller to send.
 *
 * - ThresholdRate → emits once `metric(lastEmitted, current) ≥ threshold`; the
 *   value snapshot only advances on emit, so sub-threshold drift accumulates.
 * - else → byte-diff: emits when the packed bytes differ.
 *
 * `emitOnFirstSeen` — what to do the very first time a slice is seen: the client
 * upload emits it (the server needs the initial owned value); the server diff
 * seeds silently (the trait's initial version already covers it).
 */
export function diffSyncSlice(
    syncDef: SyncDef,
    codec: SyncCodec,
    instance: TraitBase,
    node: Node,
    i: number,
    sync: TraitSyncState,
    emitOnFirstSeen: boolean,
): boolean {
    const rate = syncDef.rate;

    if (typeof rate === 'object' && rate !== null) {
        const value = syncDef.pack(instance);
        const prev = sync.values[i];
        // sub-threshold: leave both snapshots untouched so the change accumulates.
        if (prev !== undefined && rate.metric(prev, value) < rate.threshold) return false;
        sync.values[i] = captureValue(prev, value);
        const tn = packToScratch(codec, instance, node);
        if (tn > 0) storeSnapshot(sync, i, tn);
        return prev !== undefined || emitOnFirstSeen;
    }

    const n = packToScratch(codec, instance, node);
    if (n <= 0) return false; // no serdes — nothing to diff or send
    const current = scratch.subarray(0, n);
    const previous = sync.bytes[i];
    if (previous !== undefined && bytesEqual(current, previous)) return false;
    storeSnapshot(sync, i, n); // reuse the snapshot buffer in place when size-stable
    return previous !== undefined || emitOnFirstSeen;
}
