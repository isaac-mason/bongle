import { Channel, type ClientDriver } from 'bongle/interface';
import { createReassembler, frameOutbound, type Reassembler } from '../core/net';
import type { ClientMessage } from '../core/protocol';
import { packClientMessage } from '../core/protocol';

type OutboxEntry = {
    bytes: Uint8Array;
    type: string;
};

export function init() {
    return {
        /** inbound frames awaiting the next tick, indexed by Channel. */
        inbox: [[], []] as Uint8Array[][],
        /** framed outbound batch, drained to the driver at the end of flush. */
        outbox: [] as Uint8Array[],
        /** reassembles inbound fragments back into a whole message batch. one per
         *  channel, since fragments are contiguous only within one channel. */
        reassemblers: [createReassembler(), createReassembler()] as Reassembler[],
        outboxMessages: [] as OutboxEntry[],
        bytesInByType: new Map<string, number>(),
        bytesOutByType: new Map<string, number>(),
        /** latest `net_ping.serverStamp`; echoed back each tick via `net_ping_ack`
         *  so the server can measure our RTT. */
        lastServerStamp: 0,
        /** the server's smoothed measurement of our ping (ms), for the net HUD. */
        pingMs: 0,
    };
}

export type ClientNet = ReturnType<typeof init>;

export function send(state: ClientNet, message: ClientMessage) {
    const bytes = packClientMessage(message);
    const type = message.type;
    state.outboxMessages.push({ bytes, type });
    state.bytesOutByType.set(type, (state.bytesOutByType.get(type) ?? 0) + bytes.byteLength);
}

/** Frame the queued messages and hand each frame to the host. `frameOutbound`
 *  packs the batch into a single wire frame, splitting into fragments only
 *  when it would exceed WIRE_BUDGET; the server reassembles the batch whole. */
export function flush(state: ClientNet, send: ClientDriver['send']) {
    if (state.outboxMessages.length === 0) return;

    frameOutbound(
        state.outboxMessages.map((m) => m.bytes),
        state.outbox,
    );
    state.outboxMessages.length = 0;

    for (const frame of state.outbox) send(Channel.RELIABLE, frame);
    state.outbox.length = 0;
}

export type NetStats = {
    bytesIn: number;
    bytesOut: number;
    bytesInByType: Map<string, number>;
    bytesOutByType: Map<string, number>;
};

/** drain accumulated byte counters, returning bytes since last call */
export function drainNetStats(state: ClientNet): NetStats {
    const bytesInByType = state.bytesInByType;
    const bytesOutByType = state.bytesOutByType;
    let bytesIn = 0;
    for (const v of bytesInByType.values()) bytesIn += v;
    let bytesOut = 0;
    for (const v of bytesOutByType.values()) bytesOut += v;
    state.bytesInByType = new Map();
    state.bytesOutByType = new Map();
    return { bytesIn, bytesOut, bytesInByType, bytesOutByType };
}
