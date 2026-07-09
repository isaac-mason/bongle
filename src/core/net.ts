/**
 * core/net.ts — `/game` wire frame: format + fragmentation.
 *
 * A frame is a packcat discriminated union, so packing a batch of messages IS
 * framing it — the union discriminant leads the bytes, no hand-rolled header:
 *   whole → { messages }              the whole batch in one frame
 *   part  → { offset, total, data }   a slice of an oversized whole frame's bytes
 *
 * The batch is ONE atomic unit: the receiver decodes and applies all of its
 * messages together, so a whole tick's updates land in lockstep — no
 * partial-subtree state, no owner-authoritative echo built on a half-applied
 * tree. When a whole frame would exceed the `ws` library's 100 MiB maxPayload
 * (a large voxel fill, an initial scene burst) — which kills the socket
 * (RangeError: Max payload size exceeded / code 1009) — its packed bytes are
 * carved into `part` frames and reassembled verbatim on the far side, then
 * decoded as the original whole frame. Splitting is purely transport; the batch
 * is still decoded atomically, never in pieces.
 *
 * Every send site calls `frameOutbound`; every receive site calls `acceptFrame`
 * against a per-connection `Reassembler`.
 */

import { pack } from './scene/pack';

/** Max bytes per outbound frame. Well under ws's 100 MiB maxPayload; a bigger
 *  whole frame is split into `part` frames of at most this size. */
export const WIRE_BUDGET = 4 * 1024 * 1024;

/** Hard cap on a single reassembly before bailing — guards against a peer
 *  claiming an absurd `total`. */
export const MAX_REASSEMBLY_BYTES = 512 * 1024 * 1024;

/** Safe upper bound on a `part` frame's overhead beyond its `data` slice
 *  (union discriminant + varuint data length + offset + total). */
const SPLIT_OVERHEAD = 32;

const FrameSerDes = pack.build(
    pack.union('kind', [
        pack.object({ kind: pack.literal('whole'), messages: pack.list(pack.uint8Array()) }),
        pack.object({ kind: pack.literal('part'), offset: pack.uint32(), total: pack.uint32(), data: pack.uint8Array() }),
    ]),
);

/**
 * Pack `messages` into a whole frame and enqueue it — or, if it would exceed
 * WIRE_BUDGET, carve its packed bytes into `part` frames. Packing the whole
 * frame is the framing; the split path is the only one that allocates extra
 * buffers, and it only runs for oversized batches.
 */
export function frameOutbound(messages: Uint8Array[], out: Uint8Array[]): void {
    const whole = FrameSerDes.pack({ kind: 'whole', messages });
    if (whole.byteLength <= WIRE_BUDGET) {
        out.push(whole);
        return;
    }
    const chunk = WIRE_BUDGET - SPLIT_OVERHEAD;
    for (let offset = 0; offset < whole.byteLength; offset += chunk) {
        const data = whole.subarray(offset, Math.min(offset + chunk, whole.byteLength));
        out.push(FrameSerDes.pack({ kind: 'part', offset, total: whole.byteLength, data }));
    }
}

/** Per-connection reassembly buffer. One per live socket. */
export type Reassembler = { buf: Uint8Array | null };

export function createReassembler(): Reassembler {
    return { buf: null };
}

/**
 * Decode one received frame. A whole frame yields its message list directly; a
 * part frame accumulates into the per-connection buffer and yields the list
 * only once the final slice lands (null until then). Throws on a
 * malformed/oversized fragment — the caller should drop the connection.
 *
 * Fragments arrive in order (contiguous on a reliable socket): offset 0 opens
 * the buffer, and the slice reaching `total` closes it.
 */
export function acceptFrame(r: Reassembler, frame: Uint8Array): Uint8Array[] | null {
    const f = FrameSerDes.unpack(frame);
    if (f.kind === 'whole') return f.messages;

    if (f.total > MAX_REASSEMBLY_BYTES) {
        throw new Error(`[transport] reassembly total ${f.total} exceeds ${MAX_REASSEMBLY_BYTES}`);
    }
    if (f.offset === 0) r.buf = new Uint8Array(f.total);
    if (!r.buf || r.buf.byteLength !== f.total || f.offset + f.data.byteLength > f.total) {
        throw new Error(`[transport] fragment desync: offset=${f.offset} total=${f.total}`);
    }
    r.buf.set(f.data, f.offset);
    if (f.offset + f.data.byteLength < f.total) return null; // more fragments coming

    const complete = r.buf;
    r.buf = null;
    const whole = FrameSerDes.unpack(complete);
    return whole.kind === 'whole' ? whole.messages : null;
}
