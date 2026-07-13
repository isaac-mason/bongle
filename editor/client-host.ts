// editor/client-host.ts — main-thread manager for client <iframe> windows.
//
// Each client is a cross-origin iframe (see client/vite.config.ts). This
// brokers its lifecycle: create the iframe, wait for its `client-ready` ping,
// then wire a MessageChannel — one port to the server worker (via ServerHost),
// the other transferred into the iframe. From then on the iframe and worker
// talk frames directly; the main document only relays fs changes.
//
// Opening several clients just calls createClient() again — N iframes, N
// connections, N players on the one server worker.

import type { Filesystem } from './fs';
import type { ServerHost } from './server-host';
import { snapshotFiles } from './session-files';
import type { ClientMeta } from './transport-server';

export type ClientConnection = {
    connectionId: number;
    iframe: HTMLIFrameElement;
    dispose(): void;
};

export type ClientHost = {
    /** Build a client iframe + broker its connection. Mount `.iframe` into a
     *  window; the handshake fires once it loads. */
    createClient(): ClientConnection;
    /** Push a changed file to every live client iframe. */
    relayFsChange(path: string, bytes: Uint8Array): void;
    dispose(): void;
};

export type CreateClientHostOptions = {
    serverHost: ServerHost;
    fs: Filesystem;
    /** Origin the client vite serves from (client/vite.config.ts → :5174). */
    clientOrigin?: string;
    entry?: string;
    log?: (connectionId: number, msg: string) => void;
};

export function createClientHost(opts: CreateClientHostOptions): ClientHost {
    const { serverHost, fs, clientOrigin = 'http://localhost:5174', entry = 'src/index.ts', log = () => {} } = opts;

    const live = new Set<ClientConnection>();
    let nextConnectionId = 1;

    return {
        createClient() {
            const connectionId = nextConnectionId++;

            const iframe = document.createElement('iframe');
            iframe.src = clientOrigin;
            iframe.style.cssText = 'border:0;width:100%;height:100%;display:block;background:#000';
            // let the cross-origin document become cross-origin isolated (its
            // bundler uses SharedArrayBuffer).
            iframe.allow = 'cross-origin-isolated';

            const onMessage = async (e: MessageEvent) => {
                if (e.origin !== clientOrigin || e.source !== iframe.contentWindow) return;
                const msg = e.data as { type?: string; message?: string };
                if (msg.type === 'client-ready') {
                    const files = await snapshotFiles(fs);
                    const channel = new MessageChannel();
                    const meta: ClientMeta = {
                        user: { id: `dev-${connectionId}`, username: `guest-${connectionId}` },
                        joinData: {},
                    };
                    serverHost.joinClient(connectionId, channel.port1, meta);
                    iframe.contentWindow?.postMessage({ type: 'client-init', files, entry }, clientOrigin, [channel.port2]);
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

        relayFsChange(path, bytes) {
            for (const c of live) {
                c.iframe.contentWindow?.postMessage({ type: 'fs-change', path, bytes }, clientOrigin);
            }
        },

        dispose() {
            for (const c of [...live]) c.dispose();
        },
    };
}
