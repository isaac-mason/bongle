// editor/net/relay-link.ts — MessagePort-over-WebSocket, the load-bearing trick
// of multiplayer editing.
//
// A `PortLike` looks like a MessagePort but tunnels over one WebSocket, multiplexed
// by a 1-byte channel tag. The relay itself stays dumb (see relay-server.mjs): it
// forwards frames by session, never parsing them.
//
// TWO KINDS OF LANE ride this, and the difference matters:
//
//   fsrpc  — a raw PortLike handed straight to the transport. One per guest, alive for
//            the session, fanned out LOCALLY to that guest's processes. The transport
//            (remote-fs) runs unchanged over it, which is the original trick.
//
//   os     — NOT a raw port. It carries OS peer frames (see os/peer.ts), cid-multiplexed,
//            so every connection a guest opens — its client's `game`, one `bundler` per
//            process — shares it with real open/opened/close semantics. It replaced the
//            fixed `game` and `bundler` lanes, which were singletons carrying per-client
//            and per-process connections: a second one silently stole the lane.
//
// Serialization: the `os` lane has its OWN codec precisely because `encodeFrame` below
// discriminates binary-vs-JSON on the TOP-LEVEL value. That works while a lane carries
// exactly one payload shape (fsrpc does), but an envelope defeats it — a Uint8Array game
// frame inside `{t,cid,data}` would be JSON-stringified into {"0":12,…}. See
// `encodePeerFrame`. Channel 2 is retired (the old `bundler`); do not reuse it.

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
    /** every OS connection for this guest, multiplexed by cid (game, bundler, …).
     *  Replaced the fixed `game`/`bundler` lanes: those carried per-client and
     *  per-process connections over singletons, so a second one silently stole the
     *  lane from the first. See llm/plan-guest-multiplayer-over-os.md. */
    os: 1,
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

// ── host side ───────────────────────────────────────────────────────
//
// The host holds ONE socket to the relay carrying every guest's frames, each
// prefixed by the room with the guest's 2-byte localId:
//   host inbound  = [u16 localId][channel][kind][payload]
// So the host demuxes (guest, channel), where the guest side is the plain
// single-peer RelayLink above. This is the asymmetry from apps/edit-relay: a
// guest speaks plain frames, the room stamps the localId toward the host.
//
// Control-channel frames (guest-join / guest-leave, originated by the room)
// surface on `onControl` with the localId, so the session manager can react to
// guests appearing/leaving WITHOUT pre-registering every localId. Data channels
// (game / bundler / fsrpc) are lazily wired via `guestPort` inside that handler.

export type RelayHostLink = {
    /** A MessagePort-shaped endpoint for one guest's data channel. Posts are
     *  stamped with the guest localId toward the relay; inbound frames for
     *  (localId, channel) fire its onmessage. */
    guestPort(localId: number, channel: number): PortLike;
    /** Forget a guest's ports (call on guest-leave). */
    dropGuest(localId: number): void;
    close(): void;
};

export type RelayHostLinkOptions = {
    /** Fired for every control-channel frame, carrying the originating guest's
     *  localId — the session manager's hook for guest-join / guest-leave. */
    onControl?: (localId: number, message: unknown) => void;
};

export function createRelayHostLink(socket: SocketLike, opts: RelayHostLinkOptions = {}): RelayHostLink {
    // localId → channel → port.
    const guests = new Map<number, Map<number, PortLike>>();

    const channelsFor = (localId: number) => {
        let m = guests.get(localId);
        if (!m) {
            m = new Map();
            guests.set(localId, m);
        }
        return m;
    };

    socket.onmessage = (e) => {
        const bytes = toBytes(e.data);
        if (bytes.length < 2) return;
        const localId = (bytes[0] << 8) | bytes[1];
        const frame = decodeFrame(bytes.subarray(2));
        if (frame.channel === Channel.control) {
            opts.onControl?.(localId, frame.data);
            return;
        }
        // data frames land on a lazily-created port; if the session manager
        // hasn't wired this channel yet the frame is dropped (guest-join, which
        // triggers wiring, always precedes a guest's data frames).
        guests.get(localId)?.get(frame.channel)?.onmessage?.({ data: frame.data });
    };

    return {
        guestPort(localId, channel) {
            const m = channelsFor(localId);
            let p = m.get(channel);
            if (!p) {
                p = {
                    onmessage: null,
                    postMessage(data) {
                        const inner = new Uint8Array(encodeFrame(channel, data));
                        const out = new Uint8Array(2 + inner.byteLength);
                        out[0] = (localId >> 8) & 0xff;
                        out[1] = localId & 0xff;
                        out.set(inner, 2);
                        socket.send(out.buffer);
                    },
                    close() {
                        m.delete(channel);
                    },
                };
                m.set(channel, p);
            }
            return p;
        },
        dropGuest(localId) {
            guests.delete(localId);
        },
        close() {
            guests.clear();
            socket.close();
        },
    };
}
