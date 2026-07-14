// Host-side relay demux/mux: the room prefixes each guest's frames with a 2-byte
// localId toward the host; RelayHostLink splits (localId, channel) back out and
// stamps the localId on outbound frames. Control frames surface on onControl.

import { describe, expect, it } from 'vitest';
import { Channel, createRelayHostLink, encodeFrame, type SocketLike } from '../../../editor/net/relay-link';

/** a socket that records what the host sends and lets the test inject inbound. */
function fakeSocket(): SocketLike & { sent: Uint8Array[] } {
    const s = {
        sent: [] as Uint8Array[],
        onmessage: null as ((e: { data: unknown }) => void) | null,
        send(data: ArrayBuffer) {
            s.sent.push(new Uint8Array(data));
        },
        close() {},
    };
    return s;
}

/** build a host-inbound frame: [u16 localId] ++ relay-link frame. */
function inbound(localId: number, channel: number, data: unknown): Uint8Array {
    const inner = new Uint8Array(encodeFrame(channel, data));
    const out = new Uint8Array(2 + inner.byteLength);
    out[0] = (localId >> 8) & 0xff;
    out[1] = localId & 0xff;
    out.set(inner, 2);
    return out;
}

describe('relay host link', () => {
    it('surfaces control frames with the originating guest localId', () => {
        const socket = fakeSocket();
        const control: Array<{ localId: number; message: unknown }> = [];
        createRelayHostLink(socket, { onControl: (localId, message) => control.push({ localId, message }) });

        socket.onmessage?.({ data: inbound(7, Channel.control, { type: 'guest-join', localId: 7, userId: 'u' }) });
        expect(control).toEqual([{ localId: 7, message: { type: 'guest-join', localId: 7, userId: 'u' } }]);
    });

    it('routes a guest data frame to that guest+channel port only', () => {
        const socket = fakeSocket();
        const link = createRelayHostLink(socket);
        const g7game: unknown[] = [];
        const g7bundler: unknown[] = [];
        const g8game: unknown[] = [];
        link.guestPort(7, Channel.game).onmessage = (e) => g7game.push(e.data);
        link.guestPort(7, Channel.bundler).onmessage = (e) => g7bundler.push(e.data);
        link.guestPort(8, Channel.game).onmessage = (e) => g8game.push(e.data);

        socket.onmessage?.({ data: inbound(7, Channel.game, new Uint8Array([1, 2, 3])) });
        expect(g7game).toHaveLength(1);
        expect([...(g7game[0] as Uint8Array)]).toEqual([1, 2, 3]);
        expect(g7bundler).toHaveLength(0); // different channel
        expect(g8game).toHaveLength(0); // different guest
    });

    it('stamps the guest localId on outbound frames', () => {
        const socket = fakeSocket();
        const link = createRelayHostLink(socket);
        link.guestPort(9, Channel.game).postMessage(new Uint8Array([42]));

        expect(socket.sent).toHaveLength(1);
        const framed = socket.sent[0]!;
        expect((framed[0]! << 8) | framed[1]!).toBe(9); // localId prefix
        expect(framed[2]).toBe(Channel.game); // channel
        expect(framed[3]).toBe(0); // binary kind
        expect([...framed.subarray(4)]).toEqual([42]);
    });

    it('drops a data frame for a channel the session manager has not wired', () => {
        const socket = fakeSocket();
        createRelayHostLink(socket);
        // no guestPort registered — must not throw, just drop.
        expect(() => socket.onmessage?.({ data: inbound(1, Channel.game, new Uint8Array([1])) })).not.toThrow();
    });

    it('dropGuest forgets a guest so later frames no longer route', () => {
        const socket = fakeSocket();
        const link = createRelayHostLink(socket);
        const got: unknown[] = [];
        link.guestPort(3, Channel.game).onmessage = (e) => got.push(e.data);
        link.dropGuest(3);
        socket.onmessage?.({ data: inbound(3, Channel.game, new Uint8Array([9])) });
        expect(got).toHaveLength(0);
    });
});
