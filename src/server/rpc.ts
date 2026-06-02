import type { Client } from 'bongle/interface';
import type { RpcDriver } from '../core/rpc';
import * as Net from './net';
import * as Rooms from './rooms';

/**
 * construct the server-side RpcDriver. only job is the side-specific send
 * impls (sendTo / broadcast — server doesn't send to itself); listener
 * bookkeeping + dispatch lives in `core/rpc`. wrap with `Rpc.init(driver)`
 * to get an `Rpc` instance.
 */
export function createDriver(net: Net.ServerNet, rooms: Rooms.Rooms): RpcDriver {
    return {
        send(commandIndex, roomId, payload, client) {
            if (!client) return; // server never sends to itself
            const room = Rooms.getRoom(rooms, roomId);
            if (!room) return;
            const msg = { type: 'net_message' as const, direction: 'to_client' as const, roomId, commandIndex, payload };
            Net.send(net, client as Client, msg);
        },
        broadcast(commandIndex, roomId, payload) {
            const room = Rooms.getRoom(rooms, roomId);
            if (!room) return;
            const msg = { type: 'net_message' as const, direction: 'to_client' as const, roomId, commandIndex, payload };
            Net.broadcastToRoom(net, rooms, room, msg);
        },
    };
}
