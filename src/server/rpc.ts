import type { Client } from 'bongle/interface';
import type { RpcDriver } from '../core/rpc';
import * as Discovery from './discovery';
import * as Rooms from './rooms';

/**
 * construct the server-side RpcDriver. only job is the side-specific send
 * impls (sendTo / broadcast, server doesn't send to itself); listener
 * bookkeeping + dispatch lives in `core/rpc`. wrap with `Rpc.init(driver)`
 * to get an `Rpc` instance.
 *
 * Sends do NOT go straight to the outbox: they're queued on `discovery` and
 * drained (by `Discovery.flushCommands`) after the per-tick scene distribution,
 * so a command can't beat this tick's scene state (join_room / scene_sync) onto
 * a client's ordered socket. See discovery.ts "RPC command ordering".
 */
const toClientMsg = (roomId: string, commandIndex: number, payload: Uint8Array) => ({
    type: 'net_message' as const,
    direction: 'to_client' as const,
    roomId,
    commandIndex,
    payload,
});

export function createDriver(rooms: Rooms.Rooms, discovery: Discovery.Discovery): RpcDriver {
    return {
        send(commandIndex, roomId, payload, client) {
            if (!client) return; // server never sends to itself
            if (!Rooms.getRoom(rooms, roomId)) return;
            Discovery.queueCommand(discovery, {
                kind: 'send',
                client: client as Client,
                msg: toClientMsg(roomId, commandIndex, payload),
            });
        },
        broadcast(commandIndex, roomId, payload) {
            if (!Rooms.getRoom(rooms, roomId)) return;
            Discovery.queueCommand(discovery, { kind: 'broadcast', roomId, msg: toClientMsg(roomId, commandIndex, payload) });
        },
    };
}
