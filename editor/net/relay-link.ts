// editor/net/relay-link.ts — MessagePort-over-WebSocket, the load-bearing trick
// of multiplayer editing.
//
// The whole editor↔host wiring is already MessagePort-based: the game transport
// (client iframe ↔ server worker, opaque byte frames) and the bundler conduit
// (client iframe ↔ host DevServer, module-runner protocol as plain-JSON frames).
// A "guest in another browser" needs those exact two couplings — the only
// difference is the pipe. So instead of teaching the transports about the
// network, we give them a `PortLike` that looks like a MessagePort but tunnels
// over one WebSocket, multiplexed by a 1-byte channel tag.
//
// Consequence: `createPortBridge`, the server worker's `PortTransport`, and
// `client-main`'s game loop all run UNCHANGED over a relay — they just receive a
// relay-backed port instead of a MessageChannel port. The relay itself stays
// dumb (see relay-server.mjs): it forwards these frames by session, never
// parsing them.
//
// Verified serialization-safe (2026-07-14): game frames are Uint8Array; bundler
// frames (FetchResult / HotPayload / vite:invalidate) are pure JSON — Vite's own
// module-runner protocol, which Vite ships over a WebSocket. Nothing carries a
// Map, typed array, function, or class instance.

/** The MessagePort surface the transports actually use: assign `onmessage`,
 *  `postMessage`, and (server side) `close`. A relay port and a real MessagePort
 *  are interchangeable through this. */
export type PortLike = {
    postMessage(data: unknown): void;
    onmessage: ((e: { data: unknown }) => void) | null;
    close(): void;
};

/** Named channels multiplexed over one relay socket. Game + bundler mirror the
 *  two local MessageChannels a client iframe gets today; fsrpc replaces the
 *  guest's (impossible) shared-OPFS access with read-through RPC to the host;
 *  control carries join/leave/permission. One byte, room for growth. */
export const Channel = {
    control: 0,
    game: 1,
    bundler: 2,
    fsrpc: 3,
} as const;
export type Channel = (typeof Channel)[keyof typeof Channel];

/** The minimal duplex the link needs — satisfied by a browser `WebSocket`
 *  (binaryType='arraybuffer') and by node `ws`. Binary in, binary out. */
export type SocketLike = {
    send(data: ArrayBuffer): void;
    close(): void;
    onmessage: ((e: { data: unknown }) => void) | null;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

const KIND_BINARY = 0;
const KIND_JSON = 1;

/** Normalize whatever a socket hands us (ArrayBuffer / Uint8Array / node Buffer /
 *  Blob-less) to a Uint8Array view. */
function toBytes(data: unknown): Uint8Array {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new Error(`[relay] non-binary frame: ${typeof data}`);
}

/** frame = [u8 channel][u8 kind][payload]. Uint8Array payloads ride raw
 *  (kind=binary, no base64 tax on 60Hz game frames); everything else is JSON. */
export function encodeFrame(channel: number, data: unknown): ArrayBuffer {
    const isBinary = data instanceof Uint8Array || data instanceof ArrayBuffer || ArrayBuffer.isView(data);
    const body = isBinary ? toBytes(data) : enc.encode(JSON.stringify(data));
    const out = new Uint8Array(2 + body.byteLength);
    out[0] = channel;
    out[1] = isBinary ? KIND_BINARY : KIND_JSON;
    out.set(body, 2);
    return out.buffer;
}

export type DecodedFrame = { channel: number; data: unknown };

export function decodeFrame(raw: unknown): DecodedFrame {
    const view = toBytes(raw);
    const channel = view[0];
    const kind = view[1];
    // copy off the socket's backing buffer: a game frame may be handed straight
    // to the engine inbox and outlive this event.
    const body = view.slice(2);
    return { channel, data: kind === KIND_BINARY ? body : JSON.parse(dec.decode(body)) };
}

export type RelayLink = {
    /** a MessagePort-shaped endpoint bound to `channel`. Give it to any transport
     *  that expects a MessagePort; its posts ride the socket, its onmessage fires
     *  on inbound frames for this channel. */
    port(channel: number): PortLike;
    close(): void;
};

/** Wrap one socket as a channel-multiplexed set of MessagePort-likes. Both a
 *  guest↔relay socket and each host↔relay per-guest socket speak this. */
export function createRelayLink(socket: SocketLike): RelayLink {
    const ports = new Map<number, PortLike>();

    socket.onmessage = (e) => {
        const frame = decodeFrame(e.data);
        const p = ports.get(frame.channel);
        // a frame for a channel nobody opened yet is dropped — the transports
        // establish their port before the peer starts sending on it (join order).
        p?.onmessage?.({ data: frame.data });
    };

    return {
        port(channel) {
            let p = ports.get(channel);
            if (!p) {
                p = {
                    onmessage: null,
                    postMessage(data) {
                        socket.send(encodeFrame(channel, data));
                    },
                    // one socket backs every channel; closing a single logical
                    // port just detaches it (real teardown is link.close()).
                    close() {
                        ports.delete(channel);
                    },
                };
                ports.set(channel, p);
            }
            return p;
        },
        close() {
            ports.clear();
            socket.close();
        },
    };
}
