/**
 * kit/edit.ts — `bongle edit` entrypoint (editor in dev mode).
 *
 * Orchestration is intentionally thin: prime the user's generated-stubs
 * barrels, then hand off to `startDevServer` (which owns the Vite dev
 * server, the gameServer env's runner, and — via the `bongle:pipeline`
 * plugin entry — both the Node-side asset pipeline and the
 * persistent-puppeteer page that renders icons). The dev server's HTML
 * shells (`/`, `/pipeline.html`) and every kit boot module are served as
 * virtuals by `bongle:virtual-entries`; nothing kit-side gets written to
 * `<project>/.bongle/` at startup beyond the user's own
 * `src/generated/*` barrels. No bun subprocess, no IPC, no manual src/
 * watcher: user-src edits propagate through Vite's HMR cascade and the
 * registry-dispatch flush handlers wire engine + pipeline updates
 * without a separate coordination layer.
 *
 * Play-mode dev was dropped — to smoke-test the prod bundle locally use
 * `bongle build` + `bongle start`.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startDevServer, type DevHandle } from './dev/start';
import { checkContent } from './migrations';
import { ensureGeneratedStubs, resetGeneratedBarrels } from './user-entry';

const CLIENT_PORT = 3002;

// ── pretty terminal chrome ────────────────────────────────────────

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const MAGENTA = '\x1b[35m';
const ORANGE = '\x1b[38;5;208m';

// ascii via https://patorjk.com/software/taag/#p=display&f=Modular&t=bongle
const BANNER = ` _______  _______  __    _  _______  ___      _______ 
|  _    ||       ||  |  | ||       ||   |    |       |
| |_|   ||   _   ||   |_| ||    ___||   |    |    ___|
|       ||  | |  ||       ||   | __ |   |    |   |___ 
|  _   | |  |_|  ||  _    ||   ||  ||   |___ |    ___|
| |_|   ||       || | |   ||   |_| ||       ||   |___ 
|_______||_______||_|  |__||_______||_______||_______|`;

function printBanner() {
    console.log(`\n${ORANGE}${BANNER}${RESET}\n`);
}

type StepHandle = {
    done(): void;
    fail(): void;
};

const SPINNER_FRAMES = ['|', '/', '-', '\\'];

function step(msg: string): StepHandle {
    const isTTY = !!process.stdout.isTTY;
    if (!isTTY) {
        console.log(`${DIM}›${RESET} ${msg}`);
        return { done() {}, fail() {} };
    }
    let i = 0;
    const render = () => {
        process.stdout.write(`\r${DIM}${SPINNER_FRAMES[i % SPINNER_FRAMES.length]}${RESET} ${msg}`);
        i++;
    };
    render();
    const tick = setInterval(render, 90);
    return {
        done() {
            clearInterval(tick);
            process.stdout.write(`\r${GREEN}✓${RESET} ${msg}\n`);
        },
        fail() {
            clearInterval(tick);
            process.stdout.write(`\r${MAGENTA}✗${RESET} ${msg}\n`);
        },
    };
}

function printReady(links: Array<{ label: string; url: string; note?: string }>) {
    const maxLabel = Math.max(...links.map((l) => l.label.length));
    const maxRight = Math.max(...links.map((l) => l.url.length + (l.note ? l.note.length + 3 : 0)));
    const inner = maxLabel + 2 + maxRight;
    const pad = 2;
    const width = inner + pad * 2;
    const top = `┌${'─'.repeat(width)}┐`;
    const mid = `├${'─'.repeat(width)}┤`;
    const bot = `└${'─'.repeat(width)}┘`;
    const title = 'started!';

    const line = (l: string, r: string) => {
        const visible = stripAnsi(l) + stripAnsi(r);
        const padRight = inner - visible.length;
        return `${GREEN}│${RESET}${' '.repeat(pad)}${l}${r}${' '.repeat(Math.max(0, padRight))}${' '.repeat(pad)}${GREEN}│${RESET}`;
    };

    console.log();
    console.log(`${GREEN}${top}${RESET}`);
    console.log(line(`${BOLD}${title}${RESET}`, ''));
    console.log(`${GREEN}${mid}${RESET}`);
    for (const { label, url, note } of links) {
        const left = `${DIM}${label.padEnd(maxLabel)}${RESET}  `;
        const right = `${CYAN}${url}${RESET}${note ? `   ${DIM}${note}${RESET}` : ''}`;
        console.log(line(left, right));
    }
    console.log(`${GREEN}${bot}${RESET}`);
    console.log();
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: intended
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
    return s.replace(ANSI_RE, '');
}

/** try to grab `preferred`; if it's busy, fall back to an os-assigned port. */
function getPort(preferred: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                srv.listen(0, () => {
                    const addr = srv.address();
                    const port = typeof addr === 'object' && addr ? addr.port : 0;
                    srv.close(() => resolve(port));
                });
            } else {
                reject(err);
            }
        });
        srv.listen(preferred, () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
    });
}

export type EditOptions = {
    /** reserved for future inspector wiring. The gameServer env's runner
     *  shares the parent node process, so attach via that process's
     *  inspector port (`--inspect` on the bongle cli launcher). */
    inspect?: boolean;
    /** expose the dev server publicly via a `cloudflared` tunnel. */
    share?: boolean;
};

export async function edit(projectDir: string, opts: EditOptions = {}) {
    const resolvedProjectDir = path.resolve(projectDir);

    if (!fs.existsSync(resolvedProjectDir)) {
        console.error(`Project directory does not exist: ${resolvedProjectDir}`);
        process.exit(1);
    }

    const bongleDir = path.join(resolvedProjectDir, '.bongle');
    fs.mkdirSync(bongleDir, { recursive: true });

    printBanner();
    console.log(`${DIM}› starting ${BOLD}edit${RESET}${DIM} mode in ${resolvedProjectDir}${RESET}`);

    // Refuse to boot if any content file is behind the latest schema.
    // Migration is an explicit user action via `bongle migrate`; the
    // runtime in lib/src/* assumes content is at latest.
    const behind = checkContent(resolvedProjectDir);
    if (behind.length > 0) {
        console.error(`\n[bongle] content out of date (${behind.length} file(s)):`);
        for (const m of behind) {
            console.error(`  ${path.relative(resolvedProjectDir, m.file)}: v${m.from} → v${m.to}`);
        }
        console.error('run `bongle migrate` to update.');
        process.exit(1);
    }

    // cold-start wipes. The block atlas's sidecar JSON doubles as a rebuild
    // cache marker; wiping ensures the first run does a full render. Models
    // are skipped — content-addressed with their own per-id cache + GC.
    // The trailing three are dead artifacts: prefab icons moved to per-file
    // PNGs under prefabs/, and the scene/prefab hash sidecars are gone (render
    // gating is in-memory). Unlink the orphans so they don't linger.
    const resourcesClientDir = path.join(resolvedProjectDir, 'resources', 'client');
    const coldStartWipes = [
        path.join(resourcesClientDir, 'voxels-atlas.json'),
        path.join(resourcesClientDir, 'voxels-atlas.png'),
        path.join(resourcesClientDir, 'voxels-icons.json'),
        path.join(resourcesClientDir, 'voxels-icons.png'),
        path.join(resourcesClientDir, 'prefabs-icons.json'),
        path.join(resourcesClientDir, 'prefabs-icons.png'),
        path.join(resourcesClientDir, 'scenes-icons.json'),
    ];
    for (const f of coldStartWipes) {
        try { fs.unlinkSync(f); } catch { /* missing is fine */ }
    }

    const port = await getPort(CLIENT_PORT);

    const stepEntries = step('code generation');
    ensureGeneratedStubs(resolvedProjectDir);
    resetGeneratedBarrels(resolvedProjectDir);
    stepEntries.done();

    let handle: DevHandle | null = null;

    const stepServer = step('starting dev server');
    try {
        handle = await startDevServer({
            projectDir: resolvedProjectDir,
            bongleDir,
            port,
        });
        stepServer.done();
    } catch (err) {
        stepServer.fail();
        console.error('[bongle] dev server failed to start:', err);
        process.exit(1);
    }

    const links: Array<{ label: string; url: string; note?: string }> = [
        { label: 'editor', url: `http://localhost:${port}` },
    ];

    let tunnel: ChildProcess | null = null;
    if (opts.share) {
        const stepTunnel = step('starting cloudflared tunnel');
        const result = await startCloudflaredTunnel(port);
        if (result.kind === 'ok') {
            stepTunnel.done();
            tunnel = result.child;
            links.push({ label: 'share', url: result.url });
        } else {
            stepTunnel.fail();
            console.error(`${DIM}  --share: ${result.message}${RESET}`);
        }
    }

    printReady(links);

    const cleanup = () => {
        try { tunnel?.kill('SIGTERM'); } catch { /* nothing to do */ }
        handle?.close().catch(() => {});
    };

    process.on('SIGINT', () => {
        console.log('\n[bongle] shutting down...');
        cleanup();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        cleanup();
        process.exit(0);
    });
    process.on('exit', cleanup);
}

// `cloudflared tunnel --url` prints the assigned `*.trycloudflare.com`
// URL into stderr along with a banner. Resolve once we see it; reject
// if the child exits first or ENOENTs (binary not installed).
type CloudflaredResult =
    | { kind: 'ok'; child: ChildProcess; url: string }
    | { kind: 'err'; message: string };

function startCloudflaredTunnel(port: number): Promise<CloudflaredResult> {
    return new Promise((resolve) => {
        const child = spawn(
            'cloudflared',
            [
                'tunnel',
                '--no-autoupdate',
                '--url', `http://localhost:${port}`,
                // rewrite the Host header on the way to the origin so vite's
                // built-in host-check passes without an explicit allowlist.
                '--http-host-header', `localhost:${port}`,
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );

        let settled = false;
        const settle = (r: CloudflaredResult) => {
            if (settled) return;
            settled = true;
            resolve(r);
        };

        const urlRe = /https?:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
        const onChunk = (buf: Buffer) => {
            const match = buf.toString().match(urlRe);
            if (match) settle({ kind: 'ok', child, url: match[0] });
        };
        child.stdout?.on('data', onChunk);
        child.stderr?.on('data', onChunk);

        child.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') {
                settle({
                    kind: 'err',
                    message: 'cloudflared not found on PATH (install: brew install cloudflared)',
                });
            } else {
                settle({ kind: 'err', message: err.message });
            }
        });
        child.on('exit', (code) => {
            settle({ kind: 'err', message: `cloudflared exited (code ${code}) before publishing a URL` });
        });
    });
}
