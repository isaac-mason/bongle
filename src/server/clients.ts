import type { Client, User } from 'bongle/interface';
import type { Avatar } from '../core/avatar/avatar';
import type { InboundProtocol } from '../core/registry';

export type ClientState = {
    id: Client;
    /** authenticated identity for this connection's lifetime. */
    user: User;
    /** decode context for messages from this client, seeded from our local registry
     *  at join and replaced when the client sends its `wire_table`. */
    inbound: InboundProtocol;

    /** resolved avatar identity, set once at join and held for the connection's
     *  lifetime; its model payload streams into Resources behind it. */
    avatar: Avatar | null;

    /** smoothed RTT in ms (0 until known), Quake `SV_CalcPings`-style: each `net_ping`
     *  carries a `serverStamp` the client echoes via `net_ping_ack`. */
    pingMs: number;
    pingSamples: number[];
};

export function init() {
    return {
        connected: new Map<Client, ClientState>(),
    };
}

export type Clients = ReturnType<typeof init>;

export function onJoin(state: Clients, clientId: Client, user: User, inbound: InboundProtocol) {
    state.connected.set(clientId, {
        id: clientId,
        user,
        inbound,
        avatar: null,
        pingMs: 0,
        pingSamples: [],
    });
}

export function onLeave(state: Clients, clientId: Client) {
    state.connected.delete(clientId);
}

/** RTT samples averaged into `pingMs`, similar to Quake's PACKET_BACKUP window. */
const PING_WINDOW = 16;

/** folds one `net_ping_ack` into a connection's smoothed ping; ignores unset (0) and
 *  absurd samples. */
export function recordPingAck(cs: ClientState, serverStampAck: number, nowMs: number): void {
    if (serverStampAck === 0) return;
    const rtt = (nowMs - serverStampAck) >>> 0; // uint32 wrap-safe
    if (rtt > 60_000) return; // stale / clock glitch
    cs.pingSamples.push(rtt);
    if (cs.pingSamples.length > PING_WINDOW) cs.pingSamples.shift();
    let total = 0;
    for (const s of cs.pingSamples) total += s;
    cs.pingMs = Math.round(total / cs.pingSamples.length);
}
