import { describe, expect, it } from 'vitest';
import type { PeerFrame } from '../../../os';
import { decodePeerFrame, encodePeerFrame, framedPeer } from '../../../os';

// The `os` relay lane multiplexes every OS connection for a guest onto one stream, so
// its codec has to carry BOTH payload shapes that ride it today: opaque `Uint8Array`
// game frames at 60Hz, and JSON shakeup TransportFrames for the module conduit.
//
// The pre-existing relay codec (build/dev/relay-link.ts) discriminates binary-vs-JSON on
// the TOP-LEVEL value, which works only because each fixed lane carries exactly one
// shape. Wrapping payloads in a `{ t, cid, data }` envelope defeats that: a Uint8Array
// through JSON.stringify becomes {"0":12,…} — multi-fold bloat at 60Hz, and it does not
// round-trip. Hence a real framing, and hence these tests.

const roundTrip = (frame: PeerFrame): PeerFrame => decodePeerFrame(encodePeerFrame(frame));

describe('peer frame codec', () => {
    it('carries a binary game frame as raw bytes, not JSON', () => {
        const payload = new Uint8Array([0, 12, 255, 7, 128]);
        const wire = encodePeerFrame({ t: 'data', cid: 1, data: payload });

        // 6-byte header + the payload verbatim — no base64, no {"0":12,…} expansion.
        expect(wire.byteLength).toBe(6 + payload.byteLength);

        const back = roundTrip({ t: 'data', cid: 1, data: payload });
        expect(back.t).toBe('data');
        const data = (back as { data: unknown }).data;
        expect(data).toBeInstanceOf(Uint8Array);
        expect([...(data as Uint8Array)]).toEqual([...payload]);
    });

    it('carries a JSON transport frame (the module conduit) intact', () => {
        // the shape shakeup's bundler conduit actually sends.
        const invoke = { __bundler: 'invoke', id: 7, call: 'fetchModule', args: ['/src/index.ts'] };
        expect(roundTrip({ t: 'data', cid: 2, data: invoke })).toEqual({ t: 'data', cid: 2, data: invoke });
    });

    it('round-trips open with its name and identity meta', () => {
        const frame: PeerFrame = {
            t: 'open',
            cid: 3,
            name: 'game',
            meta: { ref: 'client', pid: 42, user: { id: 'u1', username: 'isaac' } },
        };
        expect(roundTrip(frame)).toEqual(frame);
    });

    it('round-trips opened / refused / close', () => {
        expect(roundTrip({ t: 'opened', cid: 4 })).toEqual({ t: 'opened', cid: 4 });
        expect(roundTrip({ t: 'refused', cid: 5, reason: 'not routable here' })).toEqual({
            t: 'refused',
            cid: 5,
            reason: 'not routable here',
        });
        expect(roundTrip({ t: 'close', cid: 6 })).toEqual({ t: 'close', cid: 6 });
    });

    it('keeps cids distinct across the full u32 range', () => {
        for (const cid of [0, 1, 255, 256, 65_535, 65_536, 4_294_967_295]) {
            expect(roundTrip({ t: 'close', cid }).cid).toBe(cid);
        }
    });

    it('copies the payload off the transport buffer', () => {
        // a decoded game frame may be handed to the engine inbox and outlive the event,
        // so it must not be a view onto the socket's recycled buffer.
        const wire = encodePeerFrame({ t: 'data', cid: 7, data: new Uint8Array([1, 2, 3]) });
        const back = decodePeerFrame(wire) as { data: Uint8Array };
        wire.fill(0);
        expect([...back.data]).toEqual([1, 2, 3]);
    });

    it('framedPeer moves frames over a byte-carrying port', () => {
        const seen: PeerFrame[] = [];
        const wire: { postMessage(d: unknown): void; onmessage: ((e: { data: unknown }) => void) | null } = {
            postMessage(d) {
                this.onmessage?.({ data: d });
            },
            onmessage: null,
        };
        const peer = framedPeer(wire);
        peer.onMessage((f) => seen.push(f));
        peer.send({ t: 'data', cid: 9, data: new Uint8Array([9, 9]) });
        peer.send({ t: 'close', cid: 9 });

        expect(seen).toHaveLength(2);
        expect([...(seen[0] as { data: Uint8Array }).data]).toEqual([9, 9]);
        expect(seen[1]).toEqual({ t: 'close', cid: 9 });
    });

    it('rejects an unknown frame tag rather than mis-routing it', () => {
        const bad = new Uint8Array(6);
        bad[0] = 99;
        expect(() => decodePeerFrame(bad)).toThrow(/unknown frame tag/);
    });
});
