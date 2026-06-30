import type { Client } from 'bongle/interface';
import type { ServerMessage } from '../core/protocol';
import { packServerMessage, packServerPacket } from '../core/protocol';
import type { Clients } from './clients';
import type { Room, Rooms } from './rooms';
import { getClientsInRoom } from './rooms';

/** outbox entry: a pre-packed ServerMessage paired with its `type` for accounting. */
type OutboxEntry = {
    /** bytes for this message, exactly what'll be emitted on the wire (modulo the per-msg varuint length prefix added by ServerPacket). */
    bytes: Uint8Array;
    type: string;
};

export function init() {
    const inbox = new Map<Client, Uint8Array[]>();
    const outbox = new Map<Client, Uint8Array[]>();
    const outboxMessages = new Map<Client, OutboxEntry[]>();

    return {
        inbox,
        outbox,
        outboxMessages,
        /**
         * accumulated byte counts since last drainNetStats, keyed by
         * `message.type`. callers derive totals + per-bucket aggregates
         * (e.g. "game = everything except debug-typed") at record time.
         */
        bytesInByType: new Map<string, number>(),
        bytesOutByType: new Map<string, number>(),
    };
}

export type ServerNet = ReturnType<typeof init>;

export function send(net: ServerNet, client: Client, message: ServerMessage) {
    // pre-pack at send time so per-message bytes are known without a
    // second encode at flush. byte total matches the wire output minus
    // the varuint length-prefix the outer ServerPacket adds per entry.
    const bytes = packServerMessage(message);
    const type = message.type;

    let messages = net.outboxMessages.get(client);
    if (!messages) {
        messages = [];
        net.outboxMessages.set(client, messages);
    }
    messages.push({ bytes, type });

    net.bytesOutByType.set(type, (net.bytesOutByType.get(type) ?? 0) + bytes.byteLength);
}

export function broadcast(net: ServerNet, clients: Clients, message: ServerMessage) {
    for (const clientId of clients.connected.keys()) {
        send(net, clientId, message);
    }
}

/** broadcast a message to all distinct clients in a specific room */
export function broadcastToRoom(net: ServerNet, rooms: Rooms, room: Room, message: ServerMessage): void {
    for (const client of getClientsInRoom(rooms, room)) {
        send(net, client, message);
    }
}

/**
 * Pack all queued per-client OutboxEntries into a single ServerPacket
 * (a list of opaque message bytes), enqueue on the outbox, clear the
 * pending queue.
 */
export function flush(net: ServerNet) {
    for (const [client, messages] of net.outboxMessages) {
        if (messages.length === 0) continue;

        const packet = packServerPacket({ messages: messages.map((m) => m.bytes) });

        let outbox = net.outbox.get(client);
        if (!outbox) {
            outbox = [];
            net.outbox.set(client, outbox);
        }
        outbox.push(packet);
    }

    net.outboxMessages.clear();
}

export type NetStats = {
    bytesIn: number;
    bytesOut: number;
    bytesInByType: Map<string, number>;
    bytesOutByType: Map<string, number>;
};

/** drain accumulated byte counters, returning bytes since last call */
export function drainNetStats(net: ServerNet): NetStats {
    const bytesInByType = net.bytesInByType;
    const bytesOutByType = net.bytesOutByType;
    let bytesIn = 0;
    for (const v of bytesInByType.values()) bytesIn += v;
    let bytesOut = 0;
    for (const v of bytesOutByType.values()) bytesOut += v;
    // hand ownership of the per-type maps to the caller; install fresh ones.
    net.bytesInByType = new Map();
    net.bytesOutByType = new Map();
    return { bytesIn, bytesOut, bytesInByType, bytesOutByType };
}
