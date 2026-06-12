import type { Client, User } from 'bongle/interface';
import type { Avatar } from '../core/avatar/avatar';
import { type WireIndex } from '../core/registry';

export type ClientState = {
    id: Client;
    /** authenticated identity for this connection's lifetime. */
    user: User;
    /**
     * INBOUND wire-index tables for messages received from this client —
     * the client's outbound tables, mirrored on this side. seeded from the
     * server's local module at join time (both sides built from the same
     * source, so they agree at connect), and refreshed whenever the client
     * sends a `wire_table` message after its own HMR flush.
     */
    inboundTraitWireIndex: WireIndex;
    inboundCommandWireIndex: WireIndex;

    /** The user's resolved avatar identity — recorded at join from the
     *  reservation the matchmaker stamped (or the builtin on dev/edit).
     *  Set once and stays set for the connection lifetime; its model
     *  payload streams into Resources behind it. */
    avatar: Avatar | null;
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
    });
}

export function onLeave(state: Clients, clientId: Client) {
    state.connected.delete(clientId);
}
