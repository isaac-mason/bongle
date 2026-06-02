import type { Client, User } from 'bongle/interface';
import type { Avatar } from '../core/avatar/avatar';
import type { PlayerId } from '../core/client';
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

    /** The user's resolved avatar — null until the engine's avatar
     *  pipeline completes (driver.avatars.resolve + model load into
     *  Resources). Once set it stays set for the connection lifetime. */
    avatar: Avatar | null;

    /** True once the engine has kicked driver.avatars.resolve for this
     *  client. Prevents duplicate resolves if onClientJoin is re-entered
     *  for any reason. */
    avatarResolveStarted: boolean;

    /** Players awaiting their resolved avatar to be stamped onto their
     *  CharacterTrait. Populated when a player is created before this
     *  client's avatar has finished loading; drained by the engine the
     *  moment `avatar` lands. */
    avatarPendingPlayers: Set<PlayerId>;

    /** @internal staging slot for the resolved-but-not-yet-loaded avatar.
     *  Filled by the avatar subsystem's resolve completion; consumed by
     *  the per-tick drain once `Resources.hasModel(modelId)` flips true. */
    _pendingResolved?: { modelId: string; rigType: string };
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
        avatarResolveStarted: false,
        avatarPendingPlayers: new Set(),
    });
}

export function onLeave(state: Clients, clientId: Client) {
    state.connected.delete(clientId);
}
