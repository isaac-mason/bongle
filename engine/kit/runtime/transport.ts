/**
 * kit/runtime/transport.ts — `/game` WS transport for the dev server.
 *
 * Mounts a `ws.WebSocketServer` in noServer mode and hooks Vite's HTTP
 * server's `upgrade` event so that `/game` upgrade requests handshake into
 * a binary-frame WS while every other path (HMR, file requests, …) flows
 * to Vite normally.
 *
 * Plumbs each connection through a `ServerApp<S>`:
 *   - **inbox**: incoming binary frames push onto `app.getInbox(state).get(clientId)`.
 *   - **outbox**: caller's frame loop runs `transport.flush()` after `app.update()`
 *     to drain `app.getOutbox(state)` to the connected sockets, then `app.clearOutbox(state)`.
 *
 * Identity is assigned per-connection from a monotonic counter (`Client` is a
 * `number` in `@bongle/interface`). Dev synthesizes `User` + `joinData` from
 * URL query params (e.g. `/game?userId=alice&username=Alice`) — deployed
 * shells pass these through their auth/SDK; in dev there's no auth gate.
 *
 * Replaces the gatho-based runtime for dev: same ServerApp contract, no
 * external WS framework.
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { URL } from 'node:url';
import type { Client, JsonValue, ServerApp, User } from '@bongle/interface';
import { WebSocketServer, type WebSocket } from 'ws';

export type AttachGameTransportOptions<S> = {
    /** Vite dev server's `httpServer` (createServer with `server: { ... }`). */
    httpServer: HttpServer;
    app: ServerApp<S>;
    state: S;
    /** URL pathname to claim. Defaults to `/game`. */
    path?: string;
};

export type GameTransport = {
    /** Drain `app.getOutbox(state)` to connected sockets and clear it.
     *  Call once per frame, after `app.update(state, dt)`. */
    flush(): void;
    /** Stop accepting new upgrades; close every live socket. Idempotent. */
    close(): void;
};

export function attachGameTransport<S>(opts: AttachGameTransportOptions<S>): GameTransport {
    const { httpServer, app, state, path = '/game' } = opts;

    const wss = new WebSocketServer({ noServer: true });
    const sockets = new Map<Client, WebSocket>();
    let nextClientId: Client = 1;

    const onUpgrade = (req: IncomingMessage, socket: import('node:net').Socket, head: Buffer) => {
        // url is a path+query string here. parse via WHATWG URL with a
        // dummy base so `pathname` + `searchParams` are available.
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== path) return; // not ours — vite's HMR ws gets the rest

        wss.handleUpgrade(req, socket, head, (ws) => {
            const clientId: Client = nextClientId++;
            sockets.set(clientId, ws);

            const userId = url.searchParams.get('userId') ?? `dev-${clientId}`;
            const username = url.searchParams.get('username') ?? `guest-${clientId}`;
            const user: User = { id: userId, username };

            // arbitrary key/value join data from query string; dev-only,
            // deployed shells supply richer data through their auth/SDK.
            const joinData: Record<string, JsonValue> = {};
            for (const [k, v] of url.searchParams) {
                if (k === 'userId' || k === 'username') continue;
                joinData[k] = v;
            }

            try {
                app.onClientJoin(state, clientId, user, joinData);
            } catch (err) {
                console.error(`[game-transport] onClientJoin threw for ${clientId}:`, err);
                ws.close(1011, 'join failed');
                sockets.delete(clientId);
                return;
            }

            ws.binaryType = 'nodebuffer';
            ws.on('message', (data, isBinary) => {
                if (!isBinary) {
                    console.warn(`[game-transport] dropping non-binary frame from ${clientId}`);
                    return;
                }
                // ws may hand us Buffer / Buffer[] / ArrayBuffer depending on
                // perMessageDeflate / fragmentation. Normalize to Uint8Array.
                let bytes: Uint8Array;
                if (data instanceof ArrayBuffer) {
                    bytes = new Uint8Array(data);
                } else if (Array.isArray(data)) {
                    bytes = new Uint8Array(Buffer.concat(data));
                } else {
                    // Buffer
                    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                }

                const inbox = app.getInbox(state);
                let q = inbox.get(clientId);
                if (!q) {
                    q = [];
                    inbox.set(clientId, q);
                }
                q.push(bytes);
            });

            const handleClose = () => {
                if (!sockets.delete(clientId)) return; // already cleaned up
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
                for (const msg of messages) {
                    ws.send(msg, { binary: true });
                }
            }
            app.clearOutbox(state);
        },
        close() {
            httpServer.off('upgrade', onUpgrade);
            for (const ws of sockets.values()) {
                try { ws.close(1001, 'server shutting down'); } catch {}
            }
            sockets.clear();
            wss.close();
        },
    };
}
