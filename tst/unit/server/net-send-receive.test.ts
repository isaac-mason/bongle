// ── the app <-> host net boundary is send (host-provided) and receive (app) by channel ──
//
// Inbound frames queue on the engine's own per-client, per-channel inbox until the
// next update; outbound frames leave through the host's `send` from inside update,
// on Channel.RELIABLE. Fragments reassemble per channel, so a whole frame on one
// channel cannot disturb a fragment sequence in flight on another.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Channel } from '../../../interface/client';
import { frameOutbound, WIRE_BUDGET } from '../../../src/core/net';
import { packClientMessage } from '../../../src/core/protocol';
import * as EngineServer from '../../../src/server/server';
import { bootEditServer, type EditServerHarness } from './edit-server-harness';

const CLIENT = 3;

let h: EditServerHarness;

beforeEach(async () => {
    h = await bootEditServer([]);
    EngineServer.onClientJoin(h.server, CLIENT, { id: 'u', username: 'u' }, {});
    // the join itself sends; the tests below look at what happens after this point.
    EngineServer.update(h.server, 1 / 60);
    h.sent.length = 0;
});

afterEach(async () => {
    await h.dispose();
});

function frames(messages: Uint8Array[]): Uint8Array[] {
    const out: Uint8Array[] = [];
    frameOutbound(messages, out);
    return out;
}

describe('receive', () => {
    it('queues on the client and channel until update, then drains that queue', () => {
        const [frame] = frames([packClientMessage({ type: 'ping' })]);
        EngineServer.receive(h.server, CLIENT, Channel.RELIABLE, frame);
        expect(h.server.net.inbox.get(CLIENT)?.[Channel.RELIABLE]).toHaveLength(1);

        EngineServer.update(h.server, 1 / 60);
        expect(h.server.net.inbox.get(CLIENT)?.[Channel.RELIABLE]).toHaveLength(0);
        // the ping is answered through the host's send, on the reliable channel.
        expect(h.sent.some((s) => s.client === CLIENT && s.channel === Channel.RELIABLE)).toBe(true);
    });

    it('drops the queue and reassembly state when the client leaves', () => {
        const [frame] = frames([packClientMessage({ type: 'ping' })]);
        EngineServer.receive(h.server, CLIENT, Channel.RELIABLE, frame);
        EngineServer.update(h.server, 1 / 60);
        expect(h.server.net.reassemblers.has(CLIENT)).toBe(true);

        EngineServer.onClientLeave(h.server, CLIENT);
        expect(h.server.net.inbox.has(CLIENT)).toBe(false);
        expect(h.server.net.reassemblers.has(CLIENT)).toBe(false);
    });

    it('reassembles fragments per channel, undisturbed by a whole frame on the other channel', () => {
        // one oversized batch splits into parts on the reliable channel.
        const big = packClientMessage({ type: 'chat_input', roomId: 'r', line: 'x'.repeat(WIRE_BUDGET + 16) });
        const parts = frames([big]);
        expect(parts.length).toBeGreaterThan(1);
        const [whole] = frames([packClientMessage({ type: 'ping' })]);

        EngineServer.receive(h.server, CLIENT, Channel.RELIABLE, parts[0]);
        EngineServer.update(h.server, 1 / 60);
        // a partial reassembly is now held for the reliable channel only.
        const reassemblers = h.server.net.reassemblers.get(CLIENT)!;
        expect(reassemblers[Channel.RELIABLE].buf).not.toBeNull();
        expect(reassemblers[Channel.UNRELIABLE].buf).toBeNull();

        // a whole frame on the unreliable channel decodes on its own and leaves the
        // in-flight fragment sequence alone.
        h.sent.length = 0;
        EngineServer.receive(h.server, CLIENT, Channel.UNRELIABLE, whole);
        EngineServer.update(h.server, 1 / 60);
        expect(reassemblers[Channel.RELIABLE].buf).not.toBeNull();
        expect(h.sent.some((s) => s.client === CLIENT)).toBe(true);

        for (const part of parts.slice(1)) EngineServer.receive(h.server, CLIENT, Channel.RELIABLE, part);
        EngineServer.update(h.server, 1 / 60);
        expect(reassemblers[Channel.RELIABLE].buf).toBeNull();
    });
});
