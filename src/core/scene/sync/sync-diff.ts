import { bytesEqualPrefix } from '../../utils/bytes';
import type { SyncCodec } from '../packcat-bridge';
import type { Node } from '../scene-tree';
import type { TraitBase, TraitSyncState } from '../traits';

// Reusable scratch for the byte-diff path so a fresh Uint8Array is allocated only when a
// slice actually changed, not per slice per tick. Grows to the largest slice ever seen.
// Safe to share across every slice since the diff is sequential and single-threaded.
let scratch = new Uint8Array(256);

/** Packs `instance`'s slice into the shared scratch, growing it once if it didn't fit. Returns bytes written, or <=0 when there's nothing to pack. */
function packToScratch(codec: SyncCodec, instance: TraitBase, node: Node): number {
    let n = codec.packInto(instance, node, scratch, 0);
    if (n < 0) {
        scratch = new Uint8Array(-n);
        n = codec.packInto(instance, node, scratch, 0);
    }
    return n;
}

// Stores scratch[0:n] as slice i's snapshot, reusing the existing buffer in place when the
// size matches so a changed fixed-size slice costs a copy, not an allocation. Only
// first-seen or a size change allocates. Safe to mutate in place because the snapshot
// buffer is serialized into the wire message before the next tick's diff overwrites it;
// if scene_sync ever gains a cross-tick resend buffer, this must copy instead.
function storeSnapshot(sync: TraitSyncState, i: number, n: number): void {
    const prev = sync.bytes[i];
    if (prev !== undefined && prev.length === n) {
        for (let j = 0; j < n; j++) prev[j] = scratch[j]!;
    } else sync.bytes[i] = scratch.slice(0, n);
}

/** Packs and stores slice `i`'s snapshot unconditionally, for the dirty fast-path that already knows the slice changed. */
export function writeSnapshot(codec: SyncCodec, instance: TraitBase, node: Node, i: number, sync: TraitSyncState): void {
    const n = packToScratch(codec, instance, node);
    if (n > 0) storeSnapshot(sync, i, n);
}

/**
 * Decides whether slice `i` should emit this tick by byte-diffing the packed value
 * against the last-emitted snapshot. After a `true` return the freshly packed bytes are
 * in `sync.bytes[i]`, ready for the caller to send.
 * `emitOnFirstSeen`: client upload emits on first sight (server needs the initial owned
 * value); server diff seeds silently (the trait's initial version already covers it).
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
    if (n <= 0) return false;
    const previous = sync.bytes[i];
    if (previous !== undefined && bytesEqualPrefix(scratch, n, previous)) return false;
    storeSnapshot(sync, i, n);
    return previous !== undefined || emitOnFirstSeen;
}
