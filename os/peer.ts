import type { PeerFrame, PeerLink } from './interface';

/** wrap a MessagePort as a PeerLink (a stand-in for a WebSocket to another
 *  machine — used by tests and same-origin peers). Only plain frames cross it —
 *  never transferred ports. */
export function messagePortPeer(port: MessagePort): PeerLink {
    return {
        send: (frame) => port.postMessage(frame),
        onMessage: (cb) => {
            port.onmessage = (e) => cb(e.data as PeerFrame);
        },
    };
}

// ── wire codec ───────────────────────────────────────────────────────────────
//
// frame = [u8 t][u32 cid LE][u8 kind][body]
//
// A `data` payload that is already bytes rides RAW (kind=binary). That is the whole
// point of having a codec at all: the game path carries `Uint8Array`s at 60Hz, and a
// Uint8Array through JSON.stringify becomes {"0":12,"1":255,…} — several-fold bloat,
// and it does not round-trip (the receiver gets a plain object, not bytes). Control
// frames carry a name/meta/reason and are small, so they are JSON.

const T = { open: 0, opened: 1, refused: 2, data: 3, close: 4 } as const;
const T_NAME = ['open', 'opened', 'refused', 'data', 'close'] as const;
const KIND_BINARY = 0;
const KIND_JSON = 1;

const enc = new TextEncoder();
const dec = new TextDecoder();

const asBytes = (data: unknown): Uint8Array | null => {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
};

export function encodePeerFrame(frame: PeerFrame): Uint8Array {
    let kind = KIND_JSON;
    let body: Uint8Array;
    if (frame.t === 'data') {
        const bytes = asBytes(frame.data);
        if (bytes !== null) {
            kind = KIND_BINARY;
            body = bytes;
        } else {
            body = enc.encode(JSON.stringify(frame.data));
        }
    } else if (frame.t === 'open') {
        body = enc.encode(JSON.stringify({ name: frame.name, meta: frame.meta }));
    } else if (frame.t === 'refused') {
        body = enc.encode(JSON.stringify({ reason: frame.reason }));
    } else {
        body = new Uint8Array(0); // opened / close carry nothing but their cid
    }
    const out = new Uint8Array(6 + body.byteLength);
    out[0] = T[frame.t];
    new DataView(out.buffer).setUint32(1, frame.cid, true);
    out[5] = kind;
    out.set(body, 6);
    return out;
}

export function decodePeerFrame(raw: Uint8Array): PeerFrame {
    const t = T_NAME[raw[0]];
    if (t === undefined) throw new Error(`[peer] unknown frame tag ${raw[0]}`);
    const cid = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(1, true);
    const kind = raw[5];
    // copy off the socket's backing buffer: a game frame may be handed to the engine
    // inbox and outlive this event.
    const body = raw.slice(6);
    switch (t) {
        case 'data':
            return { t, cid, data: kind === KIND_BINARY ? body : JSON.parse(dec.decode(body)) };
        case 'open': {
            const { name, meta } = JSON.parse(dec.decode(body));
            return { t, cid, name, meta };
        }
        case 'refused':
            return { t, cid, reason: JSON.parse(dec.decode(body)).reason };
        default:
            return { t, cid };
    }
}

/** A PeerLink over any byte-carrying port (a relay lane, a WebSocket). */
export function framedPeer(port: {
    postMessage(data: unknown): void;
    onmessage: ((e: { data: unknown }) => void) | null;
}): PeerLink {
    return {
        send: (frame) => port.postMessage(encodePeerFrame(frame)),
        onMessage: (cb) => {
            port.onmessage = (e) => {
                const d = e.data;
                const bytes = asBytes(d);
                if (bytes === null) throw new Error('[peer] non-binary frame on a framed peer lane');
                cb(decodePeerFrame(bytes));
            };
        },
    };
}
