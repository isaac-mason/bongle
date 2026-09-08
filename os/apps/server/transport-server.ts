// os/apps/server/transport-server.ts — the in-tab game transport, server side.
//
// Runs in the server app's realm. Where the deployed server accepts WS upgrades
// (game-room) and the cli dev server accepts WS upgrades
// (cli/realms/server/transport.ts), this accepts a MessagePort per connected
// client. Each port is one client's bidirectional frame pipe:
//   - inbound  : port.onmessage -> app.receive(state, clientId, channel, frame)
//   - outbound : the engine's `send` (handed in at init) posts to the client's port
//
// Multiple clients => multiple ports => multiple `Client`s on the one server —
// that's multiplayer-in-a-tab (each window is another player). The caller
// brokers the ports and tags each with a `connectionId` so leave can be
// signalled without a referenceable port. The port map is created by the caller
// (createPortMap) BEFORE the engine, because the engine's `send` closes over it.

import { Channel, type Client, type JsonValue, type ServerApp, type ServerInitOptions, type User } from 'bongle/interface';

export type ClientMeta = { user: User; joinData: Record<string, JsonValue> };

export type PortMap = {
    ports: Map<Client, MessagePort>;
    /** the engine's outbound sink: a client with no port (left, or never joined)
     *  is a silent drop. structured clone copies the bytes — no transfer, because
     *  a frame may be a view into a pooled buffer the engine reuses. */
    send: ServerInitOptions['send'];
};

export function createPortMap(): PortMap {
    const ports = new Map<Client, MessagePort>();
    return { ports, send: (client, _channel, bytes) => ports.get(client)?.postMessage(bytes) };
}

export type PortTransport = {
    /** A client connected: allocate a `Client`, fire onClientJoin, and start
     *  delivering its frames to the engine. `connectionId` is the caller's handle
     *  for this connection (for leaveClient). */
    acceptClient(connectionId: number, port: MessagePort, meta: ClientMeta): void;
    /** The caller dropped this connection (window closed / channel gone). */
    leaveClient(connectionId: number): void;
    /** Detach every client. Idempotent. */
    close(): void;
};

export function createPortTransport<S>(
    app: ServerApp<S>,
    state: S,
    resolveAvatar: () => Parameters<ServerApp<S>['onClientJoin']>[4],
    { ports }: PortMap,
): PortTransport {
    const clientByConnection = new Map<number, Client>();
    let nextClientId: Client = 1;

    function detach(clientId: Client) {
        const port = ports.get(clientId);
        if (port) {
            port.onmessage = null;
            port.close();
        }
        ports.delete(clientId);
    }

    return {
        acceptClient(connectionId, port, meta) {
            const clientId: Client = nextClientId++;
            clientByConnection.set(connectionId, clientId);
            ports.set(clientId, port);

            try {
                app.onClientJoin(state, clientId, meta.user, meta.joinData, resolveAvatar());
            } catch (err) {
                console.error(`[editor-transport] onClientJoin threw for ${clientId}:`, err);
                clientByConnection.delete(connectionId);
                detach(clientId);
                return;
            }

            // assigning onmessage implicitly starts the port; frames the client
            // posted before now were queued and arrive in order here.
            port.onmessage = (e: MessageEvent) => {
                const data = e.data;
                const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array);
                app.receive(state, clientId, Channel.RELIABLE, bytes);
            };
        },

        leaveClient(connectionId) {
            const clientId = clientByConnection.get(connectionId);
            if (clientId === undefined) return;
            clientByConnection.delete(connectionId);
            detach(clientId);
            try {
                app.onClientLeave(state, clientId);
            } catch (err) {
                console.error(`[editor-transport] onClientLeave threw for ${clientId}:`, err);
            }
        },

        close() {
            for (const clientId of ports.keys()) detach(clientId);
            clientByConnection.clear();
        },
    };
}
