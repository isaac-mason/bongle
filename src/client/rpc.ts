import type { RpcDriver } from '../core/rpc';
import * as ClientNet from './net';
import { LOCAL_ROOM_PREFIX } from './rooms';

/**
 * construct the client-side RpcDriver. only job is the side-specific send
 * impl (client only ever sends to its server; sendTo/broadcast are server-
 * side concepts and noop here). local rooms skip the wire since they have
 * no server peer.
 */
export function createDriver(net: ClientNet.ClientNet): RpcDriver {
    return {
        send(commandIndex, roomId, payload) {
            if (roomId.startsWith(LOCAL_ROOM_PREFIX)) return;
            ClientNet.send(net, {
                type: 'net_message',
                direction: 'to_server',
                roomId,
                commandIndex,
                payload,
            });
        },
        broadcast() {
            /* client doesn't broadcast */
        },
    };
}
