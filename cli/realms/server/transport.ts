// cli/realms/server/transport.ts, the `/game` WS transport for `bongle dev` and
// `bongle start`.
//
// Mounts a `ws.WebSocketServer` in noServer mode and hooks the HTTP server's
// `upgrade` event: `/game` upgrades handshake into a binary-frame WS; every other
// path (Vite HMR, file requests) flows on normally. Each socket joins the client
// table (build/dev/host.ts), which owns the engine-side join / receive / leave;
// this file only parses the upgrade and adapts the socket.

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { URL } from 'node:url';
import { WebSocketServer } from 'ws';
import { type ClientTable, closeClients, joinClient } from '../../../build/dev/host';
import type { JsonValue, ResolvedAvatar, ServerApp, User } from '../../../interface/index';

export type AttachGameTransportOptions<S> = {
    httpServer: HttpServer;
    app: ServerApp<S>;
    state: S;
    /** created BEFORE the engine: its `send` is the engine's outbound sink. */
    clients: ClientTable;
    /** URL pathname to claim. Defaults to `/game`. */
    path?: string;
    /** per-join avatar pick, so the client wears a real avatar instead of the
     *  engine's builtin fallback. */
    resolveAvatar?: () => ResolvedAvatar | undefined;
};

export type GameTransport = {
    /** Stop accepting upgrades; close every live socket. Idempotent. */
    close(): void;
};

export function attachGameTransport<S>(opts: AttachGameTransportOptions<S>): GameTransport {
    const { httpServer, app, state, clients, path = '/game' } = opts;
    const wss = new WebSocketServer({ noServer: true });

    const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== path) return; // not ours: vite's HMR ws gets the rest

        wss.handleUpgrade(req, socket, head, (ws) => {
            const user: User = {
                id: url.searchParams.get('userId') ?? `dev-${clients.nextClientId}`,
                username: url.searchParams.get('username') ?? `guest-${clients.nextClientId}`,
            };
            const joinData: Record<string, JsonValue> = {};
            for (const [k, v] of url.searchParams) {
                if (k !== 'userId' && k !== 'username') joinData[k] = v;
            }

            const conn = {
                send: (bytes: Uint8Array) => {
                    if (ws.readyState === ws.OPEN) ws.send(bytes, { binary: true });
                },
                close: () => ws.close(1001, 'closed by server'),
            };
            const member = joinClient(clients, app, state, conn, user, joinData, opts.resolveAvatar?.());
            if (!member) return;

            ws.binaryType = 'nodebuffer';
            ws.on('message', (data, isBinary) => {
                if (!isBinary) return;
                if (data instanceof ArrayBuffer) member.receive(new Uint8Array(data));
                else if (Array.isArray(data)) member.receive(new Uint8Array(Buffer.concat(data)));
                else member.receive(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            });
            ws.on('close', member.leave);
            ws.on('error', (err) => {
                console.warn(`[game-transport] socket error for ${member.clientId}:`, err);
                member.leave();
            });
        });
    };

    httpServer.on('upgrade', onUpgrade);

    return {
        close() {
            httpServer.off('upgrade', onUpgrade);
            closeClients(clients);
            wss.close();
        },
    };
}
