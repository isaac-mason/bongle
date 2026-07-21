// lib/cli/start.ts — `bongle start <bundle>`: run a built bundle (the output of
// `bongle build`) locally, standalone. Boots the bundle's SERVER entry in-process
// with a `/game` WS transport + a 60Hz sim loop, and serves the CLIENT entry as
// static files behind a small HTML shell that drives the ClientApp over that
// socket. Same host shape the platform provides (apps/bongle-play-room +
// apps/bongle-play-client), minus matchmaking / gatho / the HTTP service — a single
// local room for smoke-testing a build before deploy.
//
// The bundle arg is either a `bongle build` output dir (contains bongle.json) or
// the `bundle.zip` itself (unpacked next to the cwd). Drivers are the in-memory
// storage + the engine's sample-avatar fallback, exactly like `bongle dev`.

import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { contentType } from '../build';
import type { ResolvedAvatar, ServerApp } from '../interface/index';
import { createFallbackAvatarsDriver, resolveSampleAvatarFile } from '../src/node/sample-avatars-driver';
import { createInMemoryStorageDriver } from '../src/server/storage-in-memory';
import { attachGameTransport } from './realms/server/transport';

const STEP_MS = 1000 / 60;
const STEP_S = STEP_MS / 1000;

/** Resolve the bundle arg to an unpacked directory containing bongle.json. A
 *  directory is used in place; a `.zip` is unpacked into `<cwd>/.bongle-run` (a
 *  location under the project so the server bundle's `import 'sharp'` — kept
 *  external by the build — resolves against the project's node_modules). */
function resolveBundleDir(bundleArg: string): string {
    const abs = path.resolve(bundleArg);
    const stat = existsSync(abs) ? statSync(abs) : null;
    if (!stat) throw new Error(`no such bundle: ${abs}`);

    if (stat.isDirectory()) {
        if (!existsSync(path.join(abs, 'bongle.json'))) throw new Error(`${abs} has no bongle.json — not a built bundle`);
        return abs;
    }

    // a zip: unpack into <cwd>/.bongle-run (files overwritten in place).
    const dest = path.resolve('.bongle-run');
    const entries = unzipSync(readFileSync(abs));
    for (const [name, bytes] of Object.entries(entries)) {
        if (name.endsWith('/')) continue;
        const out = path.join(dest, name);
        mkdirSync(path.dirname(out), { recursive: true });
        writeFileSync(out, bytes);
    }
    console.log(`  · Unpacked ${path.basename(abs)} → ${dest}`);
    return dest;
}

type Manifest = { client?: { styles?: { entry?: string } } };

/** The HTML shell served at `/`: process shim (engine deps read it in the
 *  browser), the engine stylesheet, and an inline module that drives the client
 *  bundle's default-exported ClientApp over the `/game` socket (init → connect →
 *  load → rAF loop), mirroring apps/bongle-play-client's start-client. */
function shellHtml(hasStyles: boolean): string {
    const styles = hasStyles ? '<link rel="stylesheet" href="/index.css" />' : '';
    return `<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>bongle</title>
        <script>
            window.process ??= { env: { NODE_ENV: 'production' }, platform: 'browser', argv: [], version: '', versions: {} };
        </script>
        ${styles}
        <style>
            html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
        </style>
    </head>
    <body>
        <script type="module">
            import app from '/index.js';

            // no host portal locally: matchmake is a no-op, platform verbs inert.
            const driver = {
                matchmake() {},
                platform: { commercialBreak: async () => {}, rewardedBreak: async () => false },
            };
            const state = app.init(driver);

            // connect first so the server's initial frames buffer into the inbox
            // while assets load, then advance once load resolves.
            const ws = new WebSocket(\`ws://\${location.host}/game\`);
            ws.binaryType = 'arraybuffer';
            ws.addEventListener('message', (e) => app.getInbox(state).push(new Uint8Array(e.data)));
            await new Promise((res) => ws.addEventListener('open', () => res(), { once: true }));

            await app.load(state);

            let last = performance.now();
            function frame(now) {
                const dt = (now - last) / 1000;
                last = now;
                app.update(state, dt);
                // Uint8Array may be SAB-backed — send a plain-ArrayBuffer copy.
                for (const bytes of app.getOutbox(state)) ws.send(bytes.slice().buffer);
                app.clearOutbox(state);
                requestAnimationFrame(frame);
            }
            requestAnimationFrame(frame);
        </script>
    </body>
</html>
`;
}

/** Serve one request out of the bundle's client/ dir. `/` → the shell; the
 *  sample-avatar route → the engine's example glbs; anything else → a static
 *  file under client/ (path-traversal guarded), else 404. */
function handleRequest(req: IncomingMessage, res: ServerResponse, clientDir: string, html: string): void {
    const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);

    if (pathname === '/' || pathname === '/index.html') {
        res.setHeader('Content-Type', 'text/html');
        res.end(html);
        return;
    }

    // sample-avatar glbs the fallback avatars driver hands the client as
    // same-origin URLs (served from the engine's lib/avatars, not the bundle).
    const avatarFile = resolveSampleAvatarFile(pathname);
    if (avatarFile) {
        res.setHeader('Content-Type', 'model/gltf-binary');
        createReadStream(avatarFile).pipe(res);
        return;
    }

    const file = path.join(clientDir, pathname.replace(/^\/+/, ''));
    if (!file.startsWith(clientDir + path.sep)) {
        res.statusCode = 403;
        res.end('forbidden');
        return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
        res.statusCode = 404;
        res.end('not found');
        return;
    }
    res.setHeader('Content-Type', contentType(file));
    createReadStream(file).pipe(res);
}

export async function startCommand(bundleArg: string, opts: { port?: number } = {}): Promise<void> {
    const port = opts.port ?? 8080;
    const root = resolveBundleDir(bundleArg);
    const clientDir = path.join(root, 'client');
    const serverEntry = path.join(root, 'server', 'index.js');
    if (!existsSync(serverEntry)) throw new Error(`bundle has no server/index.js at ${serverEntry}`);

    const manifest = JSON.parse(readFileSync(path.join(root, 'bongle.json'), 'utf8')) as Manifest;
    const html = shellHtml(Boolean(manifest.client?.styles));

    // boot the server bundle: its default export is a ServerApp. Local drivers are
    // in-memory storage + the sample-avatar fallback (same as `bongle dev`).
    const mod = (await import(pathToFileURL(serverEntry).href)) as { default: ServerApp<unknown> };
    const app = mod.default;
    const avatars = createFallbackAvatarsDriver();
    const state = app.init({ options: {}, driver: { storage: createInMemoryStorageDriver(), avatars } });
    await app.load(state);
    console.log('  · Server loaded');

    // dress each joining client in a random sample avatar (absent ⇒ engine builtin).
    const avatarBatch: ResolvedAvatar[] = await avatars.sample();
    const resolveAvatar = () => (avatarBatch.length ? avatarBatch[Math.floor(Math.random() * avatarBatch.length)] : undefined);

    const httpServer: HttpServer = createServer((req, res) => handleRequest(req, res, clientDir, html));
    const transport = attachGameTransport({ httpServer, app, state, resolveAvatar });

    const timer = setInterval(() => {
        app.update(state, STEP_S);
        transport.flush();
    }, STEP_MS);

    await new Promise<void>((resolve) => httpServer.listen(port, resolve));
    console.log(`\nbongle start → http://localhost:${port}`);

    const shutdown = () => {
        console.log('\n[bongle start] shutting down…');
        clearInterval(timer);
        transport.close();
        app.dispose?.(state);
        httpServer.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
