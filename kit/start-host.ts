/**
 * kit/start-host.ts — minimal Node host for `bongle start`.
 *
 * Loads the built `dist/server/index.js` as the bongle/interface
 * ServerApp adapter, drives a 60Hz frame loop, attaches the same /game
 * WS transport that dev mode uses, and serves `dist/client/` static.
 *
 * Identical lifecycle contract to the platform's game-room (init →
 * load → update loop → dispose) but with no platform concerns
 * (matchmaking, persistence, allocations). Storage + avatars use the
 * same in-memory drivers as edit-mode dev.
 */

import { createReadStream, statSync, existsSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ServerApp } from 'bongle/interface';
import { createFallbackAvatarsDriver, createInMemoryStorageDriver } from 'bongle/engine-server';
import { attachGameTransport, type GameTransport } from 'bongle/kit/runtime/transport';

export type StartHostOptions = {
    distDir: string;
    distClient: string;
    serverEntry: string;
    port: number;
};

export type HostHandle = {
    port: number;
    close(): Promise<void>;
};

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.bin': 'application/octet-stream',
    '.ogg': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
};

export async function startHost(opts: StartHostOptions): Promise<HostHandle> {
    const adapter = ((await import(pathToFileURL(opts.serverEntry).href)) as { default: ServerApp<unknown> }).default;

    const state = adapter.init({
        options: {},
        driver: {
            storage: createInMemoryStorageDriver(),
            avatars: createFallbackAvatarsDriver(),
        },
    });
    await adapter.load(state);

    const port = await pickPort(opts.port);

    const httpServer = createHttpServer((req, res) => serveStatic(opts.distClient, req, res));
    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, '127.0.0.1', () => { httpServer.off('error', reject); resolve(); });
    });

    // Reuse the dev transport — identical contract.
    const transport: GameTransport = attachGameTransport({ httpServer, app: adapter, state });

    const TICK_MS = 1000 / 60;
    let last = performance.now();
    const timer = setInterval(() => {
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;
        adapter.update(state, dt);
        transport.flush();
    }, TICK_MS);

    let closed = false;
    return {
        port,
        async close() {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            try { transport.close(); } catch {}
            try { adapter.dispose?.(state); } catch (err) { console.warn('[start-host] adapter.dispose failed:', err); }
            await new Promise<void>((r) => httpServer.close(() => r()));
        },
    };
}

function serveStatic(clientDir: string, req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    // Vite's lib build doesn't emit index.html — the platform host
    // normally provides the shell. For local start, synthesize a
    // minimal one that loads index.js (+ optional index.css).
    if (pathname === '/' || pathname === '/index.html') {
        const hasCss = existsSync(path.join(clientDir, 'index.css'));
        const body = `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>bongle</title>
${hasCss ? '    <link rel="stylesheet" href="/index.css" />\n' : ''}    <style>body{margin:0;padding:0;overflow:hidden}canvas{width:100vw;height:100vh}</style>
</head>
<body>
    <script type="module">
import app from '/index.js'
const state = app.init()
await app.load(state)
const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/game'
const ws = new WebSocket(wsUrl); ws.binaryType = 'arraybuffer'
ws.onmessage = (ev) => { if (typeof ev.data !== 'string') app.getInbox(state).push(new Uint8Array(ev.data)) }
const TICK = 1000/60; let last = performance.now()
setInterval(() => {
    const now = performance.now(); const dt = (now-last)/1000; last = now
    app.update(state, dt)
    const outbox = app.getOutbox(state)
    for (const msg of outbox) if (ws.readyState === WebSocket.OPEN) ws.send(msg)
    app.clearOutbox(state)
}, TICK)
    </script>
</body>
</html>
`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(body);
        return;
    }

    // Reject anything that climbs out of clientDir.
    const resolved = path.resolve(clientDir, '.' + pathname);
    if (!resolved.startsWith(clientDir + path.sep) && resolved !== clientDir) {
        res.writeHead(403); res.end('forbidden'); return;
    }

    if (!existsSync(resolved)) {
        res.writeHead(404); res.end('not found'); return;
    }

    const stat = statSync(resolved);
    if (stat.isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
    }

    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
    });
    createReadStream(resolved).pipe(res);
}

/** try `preferred`; if busy, fall back to an OS-assigned port. */
function pickPort(preferred: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                srv.listen(0, () => {
                    const addr = srv.address();
                    const port = typeof addr === 'object' && addr ? addr.port : 0;
                    srv.close(() => resolve(port));
                });
            } else { reject(err); }
        });
        srv.listen(preferred, () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
    });
}
