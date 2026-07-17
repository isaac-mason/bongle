// editor/realms/server/transport-server.ts — the in-tab game transport, server side.
//
// Runs in the server worker (server-env). Where the deployed server accepts WS
// upgrades (apps/game-room) and the kit dev server accepts WS upgrades
// (kit/runtime/transport.ts), this accepts a MessagePort per connected client
// iframe. Each port is one client's bidirectional frame pipe:
//   - inbound  : port.onmessage → push the frame onto app.getInbox(state).get(clientId)
//   - outbound : flush() drains app.getOutbox(state) → port.postMessage(frame)
//
// Multiple client iframes ⇒ multiple ports ⇒ multiple `Client`s on the one
// server — that's multiplayer-in-a-tab (each window is another player). The
// main document brokers the ports (it owns both the worker and the iframes); it
// tags each with a `connectionId` so leave can be signalled without a
// referenceable port (main transfers both ends of the channel away).

import type { Client, JsonValue, ServerApp, User } from '../../../interface/index';

export type ClientMeta = { user: User; joinData: Record<string, JsonValue> };

export type PortTransport = {
    /** A client iframe connected: allocate a `Client`, fire onClientJoin, and
     *  start pumping its frames into the inbox. `connectionId` is the main
     *  document's handle for this connection (for leaveClient). */
    acceptClient(connectionId: number, port: MessagePort, meta: ClientMeta): void;
    /** The main document dropped this connection (window closed / iframe gone). */
    leaveClient(connectionId: number): void;
    /** Drain each client's outbox to its port and clear it. Call once per frame,
     *  after app.update(). */
    flush(): void;
    /** Detach every client. Idempotent. */
    close(): void;
};

export function createPortTransport<S>(
    app: ServerApp<S>,
    state: S,
    resolveAvatar: () => Parameters<ServerApp<S>['onClientJoin']>[4],
): PortTransport {
    const ports = new Map<Client, MessagePort>();
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

            // assigning onmessage implicitly starts the port; frames the iframe
            // posted before now were queued and flush in order here.
            port.onmessage = (e: MessageEvent) => {
                const data = e.data;
                const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array);
                const inbox = app.getInbox(state);
                let q = inbox.get(clientId);
                if (!q) {
                    q = [];
                    inbox.set(clientId, q);
                }
                q.push(bytes);
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

        flush() {
            const outbox = app.getOutbox(state);
            for (const [clientId, messages] of outbox) {
                const port = ports.get(clientId);
                if (!port) continue;
                // structured clone copies the bytes — no transfer, because a
                // frame may be a view into a pooled buffer the engine reuses.
                for (const msg of messages) port.postMessage(msg);
            }
            app.clearOutbox(state);
        },

        close() {
            for (const clientId of ports.keys()) detach(clientId);
            clientByConnection.clear();
        },
    };
}
