// editor/realms/client/client-host.ts — main-thread manager for client <iframe> windows.
//
// Each client is a SAME-ORIGIN iframe served by the main vite. This brokers its
// lifecycle: create the iframe, wait for its `client-ready` ping, then wire its
// transport lanes and transfer the ports in. HOW the lanes are wired is a
// `ClientConnector`: local (host) → the server worker + DevServer, the iframe opens
// OPFS; relay (guest) → bridged to the host over the relay, with a proxied fs. The
// iframe machinery here is identical either way.
//
// Opening several clients just calls createClient() again — N iframes, N
// connections. (A guest's relay is a single pipe, so a guest opens ONE.)

import type { ServerHost } from '../server/server-host';
import type { ClientMeta } from '../server/transport-server';

export type ClientConnection = {
    connectionId: number;
    iframe: HTMLIFrameElement;
    dispose(): void;
};

/** Wires a new client iframe's transport lanes and returns the ports to transfer
 *  into its `client-init`. Two implementations: `localConnector` (host) and the
 *  guest's relay connector (see guest-session.ts). */
export type ClientConnector = {
    connect(connectionId: number, meta: ClientMeta): { ports: MessagePort[]; dispose(): void };
};

export type ClientHost = {
    /** Build a client iframe + broker its connection. Mount `.iframe` into a
     *  window; the handshake fires once it loads. */
    createClient(): ClientConnection;
    /** Signal a changed path to every live client (OPFS iframes re-read on it;
     *  guest iframes get changes over their fsrpc lane instead, so this is a no-op
     *  for them and simply never called on the guest host). */
    relayFsChange(path: string): void;
    /** Re-handshake every live client — call after a server restart, whose new
     *  worker knows nothing of the old connections. Reloading the iframe re-fires
     *  `client-ready`, which re-runs `connector.connect`. */
    rejoinAll(): void;
    dispose(): void;
};

export type CreateClientHostOptions = {
    /** how each new client's lanes are wired (host vs guest). */
    connector: ClientConnector;
    /** the OPFS project a HOST iframe opens directly; ignored by a guest iframe,
     *  which gets a fsrpc port and reads the host's tree over the relay instead. */
    projectName: string;
    /** Same-origin path the main vite serves the client document from
     *  (realms/client/index.html). BASE_URL carries vite's `base` (trailing slash). */
    clientPath?: string;
    entry?: string;
    log?: (connectionId: number, msg: string) => void;
};

export function createClientHost(opts: CreateClientHostOptions): ClientHost {
    const {
        connector,
        projectName,
        clientPath = `${import.meta.env.BASE_URL}realms/client/index.html`,
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
            // the client realm shares a SharedArrayBuffer with the bundler worker
            // (port-bridge), so this nested iframe must be cross-origin isolated too —
            // delegate the permission (COEP header alone isn't enough for an embedded
            // doc; the embedder must grant it).
            iframe.allow = 'cross-origin-isolated; autoplay';
            iframe.style.cssText = 'border:0;width:100%;height:100%;display:block;background:#000';

            // tears down the current connect(); replaced on each client-ready so a
            // rejoin (reload → fresh client-ready) re-wires cleanly.
            let currentDispose: () => void = () => {};
            const onMessage = (e: MessageEvent) => {
                if (e.origin !== targetOrigin || e.source !== iframe.contentWindow) return;
                const msg = e.data as { type?: string; message?: string };
                if (msg.type === 'client-ready') {
                    currentDispose();
                    const meta: ClientMeta = {
                        user: { id: `dev-${connectionId}`, username: `guest-${connectionId}` },
                        joinData: {},
                    };
                    const { ports, dispose } = connector.connect(connectionId, meta);
                    currentDispose = dispose;
                    iframe.contentWindow?.postMessage({ type: 'client-init', projectName, entry }, targetOrigin, ports);
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
                    currentDispose();
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

        rejoinAll() {
            for (const c of live) c.iframe.contentWindow?.location.reload();
        },

        dispose() {
            for (const c of [...live]) c.dispose();
        },
    };
}

/** host connector: game → the local server worker, bundler → the DevServer conduit;
 *  the iframe opens the shared OPFS itself (no fsrpc port). */
export function localConnector(
    serverHost: ServerHost,
    connectRealm: (env: string, port: MessagePort) => void,
): ClientConnector {
    return {
        connect(connectionId, meta) {
            const game = new MessageChannel();
            const bundler = new MessageChannel();
            serverHost.joinClient(connectionId, game.port1, meta);
            connectRealm(`client:${connectionId}`, bundler.port1);
            return {
                ports: [game.port2, bundler.port2],
                dispose() {
                    serverHost.leaveClient(connectionId);
                },
            };
        },
    };
}
