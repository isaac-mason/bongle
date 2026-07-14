// editor/client-host.ts — main-thread manager for client <iframe> windows.
//
// Each client is a SAME-ORIGIN iframe served by the main vite. This brokers its
// lifecycle: create the iframe, wait for its `client-ready` ping, then wire two
// MessageChannels — the game transport (→ server worker) and the bundler
// transport (→ host DevServer). The iframe opens the shared OPFS project itself,
// so no fs snapshot crosses the boundary; the main doc only signals fs changes.
//
// Opening several clients just calls createClient() again — N iframes, N
// connections, N players on the one server worker.

import type { ServerHost } from '../server/server-host';
import type { ClientMeta } from '../server/transport-server';

export type ClientConnection = {
    connectionId: number;
    iframe: HTMLIFrameElement;
    dispose(): void;
};

export type ClientHost = {
    /** Build a client iframe + broker its connection. Mount `.iframe` into a
     *  window; the handshake fires once it loads. */
    createClient(): ClientConnection;
    /** Signal a changed path to every live client (they re-read shared OPFS). */
    relayFsChange(path: string): void;
    dispose(): void;
};

export type CreateClientHostOptions = {
    serverHost: ServerHost;
    /** connect each iframe's bundler conduit to the bundler worker (env
     *  `client:<connectionId>`); transfers the port. */
    connectRealm: (env: string, port: MessagePort) => void;
    /** OPFS project each iframe opens directly (same origin as the main doc). */
    projectName: string;
    /** Same-origin path the main vite serves the client document from
     *  (editor/client/index.html). The client is a same-origin iframe — env is
     *  per-realm in the browser bundler, and it runs a runner (no transform → no
     *  SAB), so no separate origin/vite is needed. */
    clientPath?: string;
    entry?: string;
    log?: (connectionId: number, msg: string) => void;
};

export function createClientHost(opts: CreateClientHostOptions): ClientHost {
    const {
        serverHost,
        connectRealm,
        projectName,
        clientPath = '/client/index.html',
        entry = 'src/index.ts',
        log = () => {},
    } = opts;
    const targetOrigin = window.location.origin;

    const live = new Set<ClientConnection>();
    let nextConnectionId = 1;

    return {
        createClient() {
            const connectionId = nextConnectionId++;

            const iframe = document.createElement('iframe');
            iframe.src = clientPath;
            iframe.style.cssText = 'border:0;width:100%;height:100%;display:block;background:#000';

            const onMessage = async (e: MessageEvent) => {
                if (e.origin !== targetOrigin || e.source !== iframe.contentWindow) return;
                const msg = e.data as { type?: string; message?: string };
                if (msg.type === 'client-ready') {
                    // two channels: the game transport (→ server worker) and the
                    // bundler conduit (→ bundler worker, this iframe's realm).
                    const game = new MessageChannel();
                    const bundler = new MessageChannel();
                    const meta: ClientMeta = {
                        user: { id: `dev-${connectionId}`, username: `guest-${connectionId}` },
                        joinData: {},
                    };
                    serverHost.joinClient(connectionId, game.port1, meta);
                    connectRealm(`client:${connectionId}`, bundler.port1);
                    // the iframe opens the shared OPFS project itself — no snapshot.
                    iframe.contentWindow?.postMessage({ type: 'client-init', projectName, entry }, targetOrigin, [
                        game.port2,
                        bundler.port2,
                    ]);
                    log(connectionId, 'connected');
                } else if (msg.type === 'client-error') {
                    log(connectionId, `error: ${msg.message}`);
                }
            };
            window.addEventListener('message', onMessage);

            const connection: ClientConnection = {
                connectionId,
                iframe,
                dispose() {
                    if (!live.delete(connection)) return;
                    window.removeEventListener('message', onMessage);
                    serverHost.leaveClient(connectionId);
                    iframe.remove();
                },
            };
            live.add(connection);
            return connection;
        },

        relayFsChange(path) {
            for (const c of live) {
                c.iframe.contentWindow?.postMessage({ type: 'fs-change', path }, targetOrigin);
            }
        },

        dispose() {
            for (const c of [...live]) c.dispose();
        },
    };
}
