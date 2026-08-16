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
