import type { RelayFrame, RelayLink } from './interface';

/** wrap a MessagePort as a relay (stand-in for a WebSocket to another machine).
 *  Only plain frames cross it — never transferred ports. */
export function messagePortRelay(port: MessagePort): RelayLink {
    return {
        send: (frame) => port.postMessage(frame),
        onMessage: (cb) => {
            port.onmessage = (e) => cb(e.data as RelayFrame);
        },
    };
}
