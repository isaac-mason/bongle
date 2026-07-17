// editor/net/gatho-socket.ts — adapt a gatho/client RoomConnection to the
// SocketLike the relay layer expects.
//
// gatho.connect takes its handlers up front and returns a connection with
// send/close; SocketLike wants a settable `onmessage`. This bridges the two so a
// host or guest can wrap its relay-room connection and hand it to
// createRelayHostLink / createRelayLink unchanged.

import { connect } from 'gatho/client';
import type { SocketLike } from '../../build';

export type ConnectRelayOptions = {
    onOpen?: () => void;
    onClose?: () => void;
    onError?: (e: Event) => void;
};

/** Dial a relay room (the ws url + token from /api/edit/host|join) and expose it
 *  as a SocketLike. Relay frames are binary + reliable/ordered. */
export function connectRelaySocket(url: string, opts: ConnectRelayOptions = {}): SocketLike {
    let onmessage: ((e: { data: unknown }) => void) | null = null;

    const conn = connect(url, {
        onMessage: (message) => onmessage?.({ data: message }),
        onOpen: opts.onOpen,
        onClose: opts.onClose,
        onError: opts.onError,
    });

    return {
        send: (data) => conn.send(data, { reliable: true }),
        close: () => conn.close(),
        get onmessage() {
            return onmessage;
        },
        set onmessage(cb) {
            onmessage = cb;
        },
    };
}
