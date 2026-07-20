// ── shared per-slice change detection ────────────────────────────────
//
// the single source of truth for "did this sync slice change enough to emit
// this tick", used by BOTH directions:
//   - server diff (discovery.ts), server-authority broadcast
//   - client upload (replication.ts), owner-authority send
//
// keeping one implementation means the byte-diff behaves identically on both ends,
// no drift between mirror copies.
//
// the per-slice snapshot (last-emitted bytes) lives on the trait instance's `_sync`
// arrays, indexed by slice, so this is array indexing, not keyed side-map lookups.

import { bytesEqualPrefix } from '../../utils/bytes';
import type { Node } from '../scene-tree';
import type { SyncCodec } from '../packcat-bridge';
import type { TraitBase, TraitSyncState } from '../traits';

// reusable scratch for the byte-diff path. `packInto` writes here instead of
// allocating a fresh Uint8Array per slice per tick, we only copy out (alloc)
// when a slice actually changed. grows to the largest slice ever seen, then
// stays put. the diff is sequential + single-threaded, so one shared buffer is
// safe across every slice.
let scratch = new Uint8Array(256);

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
 * place when the size matches, so a *changed* fixed-size slice (the common
 * case: positions, quaternions, scalars) costs a copy, not an allocation. only
 * first-seen or a size change allocates.
 *
 * mutating in place is safe because the snapshot buffer is aliased into THIS
 * tick's scene_sync messages (readChangedFields hands out the buffer directly),
 * and those are serialized in netflush before the next tick's diff overwrites
 * here, last tick's bytes are already on the wire. (if scene_sync ever gains a
 * cross-tick resend buffer, this must copy instead.)
 */
function storeSnapshot(sync: TraitSyncState, i: number, n: number): void {
    const prev = sync.bytes[i];
    // in-place copy of scratch[0:n] without a subarray view, this runs per
    // changed slice per tick (e.g. realtime positions), so it must not allocate.
    // first-seen / size-change still allocates the owned snapshot buffer (rare).
    if (prev !== undefined && prev.length === n) {
        for (let j = 0; j < n; j++) prev[j] = scratch[j]!;
    } else sync.bytes[i] = scratch.slice(0, n);
}

/**
 * pack + store slice `i`'s snapshot unconditionally, for the dirty fast-path,
 * which already knows the slice changed (no byte-diff needed). shares the same
 * in-place buffer reuse as the diff path.
 */
export function writeSnapshot(codec: SyncCodec, instance: TraitBase, node: Node, i: number, sync: TraitSyncState): void {
    const n = packToScratch(codec, instance, node);
    if (n > 0) storeSnapshot(sync, i, n);
}

/**
 * decide whether slice `i` on `instance` should emit this tick by byte-diffing the
 * packed value against the last-emitted snapshot, updating the snapshot when it
 * differs. after a `true` return the freshly packed bytes are in `sync.bytes[i]`,
 * ready for the caller to send.
 *
 * byte-diff: emits when the packed bytes differ. ('explicit' fields are kept off the
 * diff pass by the caller; if one reaches here it byte-diffs like 'diff'.)
 *
 * `emitOnFirstSeen`, what to do the very first time a slice is seen: the client
 * upload emits it (the server needs the initial owned value); the server diff
 * seeds silently (the trait's initial version already covers it).
 */
export function diffSync(
    codec: SyncCodec,
    instance: TraitBase,
    node: Node,
    i: number,
    sync: TraitSyncState,
    emitOnFirstSeen: boolean,
): boolean {
    const n = packToScratch(codec, instance, node);
    if (n <= 0) return false; // no serdes, nothing to diff or send
    const previous = sync.bytes[i];
    // compare scratch[0:n] in place, no subarray view per slice per tick.
    if (previous !== undefined && bytesEqualPrefix(scratch, n, previous)) return false;
    storeSnapshot(sync, i, n); // reuse the snapshot buffer in place when size-stable
    return previous !== undefined || emitOnFirstSeen;
}
