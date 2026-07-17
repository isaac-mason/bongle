// cli/realms/server/transport.ts — `/game` WS transport for `bongle dev`.
//
// Mounts a `ws.WebSocketServer` in noServer mode and hooks Vite's HTTP server's
// `upgrade` event: `/game` upgrades handshake into a binary-frame WS; every other
// path (Vite HMR, file requests) flows to Vite normally. Each connection is plumbed
// through a `ServerApp<S>` (inbox push / outbox drain on flush).

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { URL } from 'node:url';
import { type WebSocket, WebSocketServer } from 'ws';
import type { Client, JsonValue, ResolvedAvatar, ServerApp, User } from '../../../interface/index';

export type AttachGameTransportOptions<S> = {
    httpServer: HttpServer;
    app: ServerApp<S>;
    state: S;
    /** URL pathname to claim. Defaults to `/game`. */
    path?: string;
    /** per-join avatar pick (random from the sample pool) — passed to onClientJoin
     *  so the client gets a real avatar instead of the engine's builtin fallback. */
    resolveAvatar?: () => ResolvedAvatar | undefined;
};

export type GameTransport = {
    /** Drain `app.getOutbox(state)` to sockets + clear it. Call once per frame. */
    flush(): void;
    /** Stop accepting upgrades; close every live socket. Idempotent. */
    close(): void;
};

export function attachGameTransport<S>(opts: AttachGameTransportOptions<S>): GameTransport {
    const { httpServer, app, state, path = '/game' } = opts;

    const wss = new WebSocketServer({ noServer: true });
    const sockets = new Map<Client, WebSocket>();
    let nextClientId: Client = 1;

    const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== path) return; // not ours — vite's HMR ws gets the rest

        wss.handleUpgrade(req, socket, head, (ws) => {
            const clientId: Client = nextClientId++;
            sockets.set(clientId, ws);

            const user: User = {
                id: url.searchParams.get('userId') ?? `dev-${clientId}`,
                username: url.searchParams.get('username') ?? `guest-${clientId}`,
            };
            const joinData: Record<string, JsonValue> = {};
            for (const [k, v] of url.searchParams) {
                if (k !== 'userId' && k !== 'username') joinData[k] = v;
            }

            try {
                app.onClientJoin(state, clientId, user, joinData, opts.resolveAvatar?.());
            } catch (err) {
                console.error(`[game-transport] onClientJoin threw for ${clientId}:`, err);
                ws.close(1011, 'join failed');
                sockets.delete(clientId);
                return;
            }

            ws.binaryType = 'nodebuffer';
            ws.on('message', (data, isBinary) => {
                if (!isBinary) return;
                let bytes: Uint8Array;
                if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
                else if (Array.isArray(data)) bytes = new Uint8Array(Buffer.concat(data));
                else bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                const inbox = app.getInbox(state);
                let q = inbox.get(clientId);
                if (!q) {
                    q = [];
                    inbox.set(clientId, q);
                }
                q.push(bytes);
            });

            const handleClose = () => {
                if (!sockets.delete(clientId)) return;
                try {
                    app.onClientLeave(state, clientId);
                } catch (err) {
                    console.error(`[game-transport] onClientLeave threw for ${clientId}:`, err);
                }
            };
            ws.on('close', handleClose);
            ws.on('error', (err) => {
                console.warn(`[game-transport] socket error for ${clientId}:`, err);
                handleClose();
            });
        });
    };

    httpServer.on('upgrade', onUpgrade);

    return {
        flush() {
            const outbox = app.getOutbox(state);
            for (const [clientId, messages] of outbox) {
                const ws = sockets.get(clientId);
                if (!ws || ws.readyState !== ws.OPEN) continue;
                for (const msg of messages) ws.send(msg, { binary: true });
            }
            app.clearOutbox(state);
        },
        close() {
            httpServer.off('upgrade', onUpgrade);
            for (const ws of sockets.values()) {
                try {
                    ws.close(1001, 'server shutting down');
                } catch {}
            }
            sockets.clear();
            wss.close();
        },
    };
}
