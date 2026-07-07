import type { Client, User } from 'bongle/interface';
import type { Avatar } from '../core/avatar/avatar';
import type { WireIndex } from '../core/registry';

export type ClientState = {
    id: Client;
    /** authenticated identity for this connection's lifetime. */
    user: User;
    /**
     * INBOUND wire-index tables for messages received from this client,
     * the client's outbound tables, mirrored on this side. seeded from the
     * server's local module at join time (both sides built from the same
     * source, so they agree at connect), and refreshed whenever the client
     * sends a `wire_table` message after its own HMR flush.
     */
    inboundTraitWireIndex: WireIndex;
    inboundCommandWireIndex: WireIndex;

    /** The user's resolved avatar identity, recorded at join from the
     *  reservation the matchmaker stamped (or the builtin on dev/edit).
     *  Set once and stays set for the connection lifetime; its model
     *  payload streams into Resources behind it. */
    avatar: Avatar | null;

    /** server-measured RTT (ms), Quake `SV_CalcPings`-style: each `net_ping` carries a
     *  `serverStamp`; the client echoes the latest via `net_ping_ack`; RTT = now − stamp in
     *  the SERVER's own clock (no offset entanglement), smoothed over a sample window.
     *  `pingMs` is the smoothed value (0 until known), echoed down for the client's HUD. */
    pingMs: number;
    pingSamples: number[];
};

export function init() {
    return {
        connected: new Map<Client, ClientState>(),
    };
}

export type Clients = ReturnType<typeof init>;

export function onJoin(
    state: Clients,
    clientId: Client,
    user: User,
    inboundTraitWireIndex: WireIndex,
    inboundCommandWireIndex: WireIndex,
) {
    state.connected.set(clientId, {
        id: clientId,
        user,
        inboundTraitWireIndex,
        inboundCommandWireIndex,
        avatar: null,
        pingMs: 0,
        pingSamples: [],
    });
}

export function onLeave(state: Clients, clientId: Client) {
    state.connected.delete(clientId);
}

/** RTT samples averaged into `pingMs` (≈ Quake's PACKET_BACKUP window). */
const PING_WINDOW = 16;

/** fold one `net_ping_ack` into a connection's smoothed ping. `serverStampAck` is a
 *  `serverStamp` we sent earlier; `nowMs` is the same server monotonic clock, so
 *  `nowMs − serverStampAck` is a true RTT. 0 (never echoed) + absurd samples are ignored. */
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
