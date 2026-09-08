// os/apps/server/transport-server.ts, the in-tab game transport, server side.
//
// Runs in the server app's realm. Where the deployed server accepts WS upgrades
// (game-room) and the cli dev server accepts WS upgrades
// (cli/realms/server/transport.ts), this accepts an OS Channel per connected
// client. Each channel is one client's bidirectional frame pipe:
//   - inbound  : the receive fn acceptClient returns -> app.receive(state, clientId, channel, frame)
//   - outbound : the engine's `send` (handed in at init) posts to the client's channel
//
// Multiple clients => multiple channels => multiple `Client`s on the one server:
// multiplayer-in-a-tab (each window is another player). The channel map is
// created by the caller (createClientChannels) BEFORE the engine, because the
// engine's `send` closes over it.

import { Channel, type Client, type JsonValue, type ServerApp, type ServerInitOptions, type User } from 'bongle/interface';
import type { Channel as OsChannel } from '../../interface';

export type ClientMeta = { user: User; joinData: Record<string, JsonValue> };

export type ClientChannels = {
    channels: Map<Client, OsChannel>;
    /** the engine's outbound sink: a client with no channel (left, or never joined)
     *  is a silent drop. structured clone copies the bytes; no transfer, because a
     *  frame may be a view into a pooled buffer the engine reuses. */
    send: ServerInitOptions['send'];
};

export function createClientChannels(): ClientChannels {
    const channels = new Map<Client, OsChannel>();
    return { channels, send: (client, _channel, bytes) => channels.get(client)?.send(bytes) };
}

export type ChannelTransport = {
    /** A client connected: allocate a `Client`, fire onClientJoin, and return the
     *  inbound frame handler (what the OS listener hands back). The channel's
     *  `closed` is the leave signal. */
    acceptClient(conn: OsChannel, meta: ClientMeta): (frame: unknown) => void;
    /** Detach every client without firing leave. Idempotent. */
    close(): void;
};

const toU8 = (frame: unknown): Uint8Array => (frame instanceof ArrayBuffer ? new Uint8Array(frame) : (frame as Uint8Array));

export function createChannelTransport<S>(
    app: ServerApp<S>,
    state: S,
    resolveAvatar: () => Parameters<ServerApp<S>['onClientJoin']>[4],
    { channels }: ClientChannels,
): ChannelTransport {
    let nextClientId: Client = 1;

    return {
        acceptClient(conn, meta) {
            const clientId: Client = nextClientId++;
            channels.set(clientId, conn);
            try {
                app.onClientJoin(state, clientId, meta.user, meta.joinData, resolveAvatar());
            } catch (err) {
                console.error(`[editor-transport] onClientJoin threw for ${clientId}:`, err);
                channels.delete(clientId);
                conn.close();
                return () => {};
            }
            // a channel closed by the transport's own close() is already out of the
            // map: no leave for a shutdown, only for a client that went away.
            void conn.closed.then(() => {
                if (!channels.delete(clientId)) return;
                try {
                    app.onClientLeave(state, clientId);
                } catch (err) {
                    console.error(`[editor-transport] onClientLeave threw for ${clientId}:`, err);
                }
            });
            return (frame) => app.receive(state, clientId, Channel.RELIABLE, toU8(frame));
        },

        close() {
            const open = [...channels.values()];
            channels.clear();
            for (const conn of open) conn.close();
        },
    };
}
