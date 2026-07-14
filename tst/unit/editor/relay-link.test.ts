// Proof that the two live editor lanes tunnel through a relay UNCHANGED: build
// two RelayLinks over an in-memory paired socket (stands in for guest↔relay and
// host↔relay) and round-trip the EXACT frame shapes the transports emit today.
// If these survive byte-for-byte, createPortBridge / PortTransport / the game
// loop work over a relay with no changes.

import { describe, expect, it } from 'vitest';
import { Channel, createRelayLink, decodeFrame, encodeFrame, type SocketLike } from '../../../editor/net/relay-link';

/** two SocketLikes wired to each other, synchronously — a fake wire. */
function pairedSockets(): [SocketLike, SocketLike] {
    const a: SocketLike = { onmessage: null, send: (d) => queueMicrotask(() => b.onmessage?.({ data: d })), close() {} };
    const b: SocketLike = { onmessage: null, send: (d) => queueMicrotask(() => a.onmessage?.({ data: d })), close() {} };
    return [a, b];
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('relay-link', () => {
    it('carries game-lane byte frames intact', async () => {
        const [ws1, ws2] = pairedSockets();
        const host = createRelayLink(ws1);
        const guest = createRelayLink(ws2);
        const received: Uint8Array[] = [];
        guest.port(Channel.game).onmessage = (e) => received.push(e.data as Uint8Array);

        const frame = new Uint8Array([0, 255, 42, 7, 200, 1]); // an opaque engine frame
        host.port(Channel.game).postMessage(frame);
        await flush();

        expect(received).toHaveLength(1);
        expect([...received[0]]).toEqual([...frame]);
        expect(received[0]).toBeInstanceOf(Uint8Array);
    });

    it('round-trips the real bundler-lane frame shapes (FetchResult / HotPayload / invalidate)', async () => {
        const [ws1, ws2] = pairedSockets();
        const host = createRelayLink(ws1);
        const guest = createRelayLink(ws2);
        const got: unknown[] = [];
        guest.port(Channel.bundler).onmessage = (e) => got.push(e.data);

        // the actual frames that flow over the bundler conduit (see port-bridge.ts
        // BundlerFrame + dev-server.ts FetchResult/HotPayload). NB: the entry
        // module's `fetchModule` importer is undefined; JSON normalizes it to null
        // on the wire — asserted separately below, since the host's resolve()
        // treats it as falsy either way (this is what real Vite-over-WS does too).
        const frames: unknown[] = [
            {
                __bundler: 'result',
                id: 3,
                result: { code: 'export const x = 1\n//# sourceURL=src/index.ts', file: 'src/index.ts', id: 'src/index.ts', url: 'src/index.ts', invalidate: false },
            },
            { __bundler: 'result', id: 4, result: { cache: true } },
            { __bundler: 'result', id: 5, result: { externalize: 'node:path', type: 'module' } },
            {
                __bundler: 'push',
                payload: { type: 'update', updates: [{ type: 'js-update', path: 'src/blocks.ts', acceptedPath: 'src/blocks.ts', timestamp: 12, firstInvalidatedBy: 'src/blocks.ts' }] },
            },
            { __bundler: 'push', payload: { type: 'full-reload', triggeredBy: 'src/index.ts' } },
            { __bundler: 'send', payload: { type: 'custom', event: 'vite:invalidate', data: { path: 'src/a.ts', firstInvalidatedBy: 'src/a.ts' } } },
        ];
        for (const f of frames) host.port(Channel.bundler).postMessage(f);
        await flush();

        expect(got).toEqual(frames); // deep-equal, byte-for-byte after JSON round trip
    });

    it('normalizes an undefined importer to null (host treats it as falsy)', async () => {
        const [ws1, ws2] = pairedSockets();
        const host = createRelayLink(ws1);
        const guest = createRelayLink(ws2);
        let got: unknown;
        guest.port(Channel.bundler).onmessage = (e) => {
            got = e.data;
        };
        // entry-module fetch: importer is undefined.
        host.port(Channel.bundler).postMessage({ __bundler: 'invoke', id: 1, payload: { data: { name: 'fetchModule', data: ['src/index.ts', undefined, {}] } } });
        await flush();
        // undefined → null across JSON; the only lossy case, and a benign one.
        expect(got).toEqual({ __bundler: 'invoke', id: 1, payload: { data: { name: 'fetchModule', data: ['src/index.ts', null, {}] } } });
    });

    it('demuxes channels — a game frame never reaches the bundler port', async () => {
        const [ws1, ws2] = pairedSockets();
        const host = createRelayLink(ws1);
        const guest = createRelayLink(ws2);
        const game: unknown[] = [];
        const bundler: unknown[] = [];
        guest.port(Channel.game).onmessage = (e) => game.push(e.data);
        guest.port(Channel.bundler).onmessage = (e) => bundler.push(e.data);

        host.port(Channel.game).postMessage(new Uint8Array([1, 2, 3]));
        host.port(Channel.bundler).postMessage({ __bundler: 'send', payload: { hello: true } });
        await flush();

        expect(game).toHaveLength(1);
        expect(bundler).toHaveLength(1);
        expect([...(game[0] as Uint8Array)]).toEqual([1, 2, 3]);
    });

    it('frame encoding tags channel + kind', () => {
        const bin = new Uint8Array(encodeFrame(Channel.game, new Uint8Array([9])));
        expect([bin[0], bin[1]]).toEqual([Channel.game, 0]); // binary kind
        const json = new Uint8Array(encodeFrame(Channel.bundler, { a: 1 }));
        expect([json[0], json[1]]).toEqual([Channel.bundler, 1]); // json kind
        expect(decodeFrame(json)).toEqual({ channel: Channel.bundler, data: { a: 1 } });
    });
});
