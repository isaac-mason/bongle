/**
 * kit/start.ts — `bongle start` entrypoint.
 *
 * Serves the prod bundle (produced by `bongle build`) locally so it can
 * be smoke-tested without uploading to the platform. The actual host
 * lives in `start-host.ts` — this file just resolves paths, picks a
 * port, and dispatches.
 *
 * This is NOT the platform host (platform/game-room). That's a separate
 * service running uploaded bundles in prod; coupling the engine repo to
 * it would entangle concerns. The local host here is intentionally
 * minimal — enough to verify that a built `dist/` actually works.
 */

import fs from 'node:fs';
import path from 'node:path';
import { startHost } from './start-host';

export type StartOptions = {
    /** Override the listen port (default 3002). If busy, falls back to an
     *  OS-assigned port. */
    port?: number;
};

const DEFAULT_PORT = 3002;

export async function start(projectDir: string, opts: StartOptions = {}) {
    const resolvedProjectDir = path.resolve(projectDir);
    const distDir = path.join(resolvedProjectDir, 'dist');
    const distClient = path.join(distDir, 'client');
    const distServer = path.join(distDir, 'server');
    const serverEntry = path.join(distServer, 'index.js');
    const clientEntry = path.join(distClient, 'index.js');

    if (!fs.existsSync(distDir)) {
        console.error(`[bongle] no dist/ at ${distDir}. Run \`bongle build\` first.`);
        process.exit(1);
    }
    if (!fs.existsSync(serverEntry) || !fs.existsSync(clientEntry)) {
        console.error(`[bongle] dist/ is incomplete (missing client/index.js or server/index.js). Run \`bongle build\`.`);
        process.exit(1);
    }

    const handle = await startHost({
        distDir,
        distClient,
        serverEntry,
        port: opts.port ?? DEFAULT_PORT,
    });

    console.log(`[bongle] start: serving ${distDir} on http://localhost:${handle.port}`);

    const cleanup = () => { handle.close().catch(() => {}); };
    process.on('SIGINT', () => { console.log('\n[bongle] shutting down...'); cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}
