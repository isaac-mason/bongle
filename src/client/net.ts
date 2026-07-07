import type { ClientMessage } from '../core/protocol';
import { packClientMessage, packClientPacket } from '../core/protocol';

type OutboxEntry = {
    bytes: Uint8Array;
    type: string;
};

export function init() {
    return {
        inbox: [] as Uint8Array[],
        outbox: [] as Uint8Array[],
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
 * Pack queued OutboxEntries into a single ClientPacket (list of opaque
 * message bytes), enqueue on the outbox, clear the pending queue.
 */
export function flush(state: ClientNet) {
    if (state.outboxMessages.length === 0) return;

    const packet = packClientPacket({ messages: state.outboxMessages.map((m) => m.bytes) });
    state.outbox.push(packet);

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
