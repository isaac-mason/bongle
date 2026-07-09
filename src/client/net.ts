import { createReassembler, frameOutbound } from '../core/net';
import type { ClientMessage } from '../core/protocol';
import { packClientMessage } from '../core/protocol';

type OutboxEntry = {
    bytes: Uint8Array;
    type: string;
};

export function init() {
    return {
        inbox: [] as Uint8Array[],
        outbox: [] as Uint8Array[],
        /** reassembles inbound fragments back into a whole message batch (a big
         *  batch is split across frames by the server's transport). */
        reassembler: createReassembler(),
        outboxMessages: [] as OutboxEntry[],
        bytesInByType: new Map<string, number>(),
        bytesOutByType: new Map<string, number>(),
        /** latest `net_ping.serverStamp` from the server; echoed back each tick via
         *  `net_ping_ack` so the server can measure our RTT (Quake-style). */
        lastServerStamp: 0,
        /** the server's smoothed measurement of OUR ping (ms), for the net HUD. */
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

/**
 * Frame the queued messages onto the outbox and clear the pending queue. The
 * batch is one atomic unit; `frameOutbound` packs it into a single wire frame,
 * splitting into fragments only when it would exceed WIRE_BUDGET. The transport
 * sends each frame opaquely; the server reassembles the batch whole.
 */
export function flush(state: ClientNet) {
    if (state.outboxMessages.length === 0) return;

    frameOutbound(
        state.outboxMessages.map((m) => m.bytes),
        state.outbox,
    );

    state.outboxMessages.length = 0;
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
