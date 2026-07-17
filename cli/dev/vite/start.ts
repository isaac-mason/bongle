// cli/dev/vite/start.ts — `bongle dev`: the Vite Environments dev server.
//
// Resurrected from the pre-pivot kit/dev/start.ts (commit 0ca35db):
//   1. createServer(defineBongleDevConfig) — client + server envs, bongle() plugin.
//   2. server.listen() — Vite's http server (so /game can hook `upgrade`).
//   3. boot the server env: import virtual:bongle/play-server through the server
//      runner, call boot({ httpServer }) → EngineServer + /game WS + sim loop.
//   4. engine-source hot-reboot: engine/workspace code (outside the project) has no
//      HMR boundary, so on change we clearCache + re-boot the server env and
//      full-reload clients (start.ts owns this; the plugin just requests it).
// User-code edits HMR through the bongle() plugin's capture self-accept.

import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type RunnableDevEnvironment, type ViteDevServer } from 'vite';
import type { EngineRebootRef } from './bongle-plugin';
import { defineBongleDevConfig } from './config';

const SHELL_DIR = fileURLToPath(new URL('./shell/', import.meta.url));
const BONGLE_BIN = fileURLToPath(new URL('../../bongle.mjs', import.meta.url));
const SERVER_BOOT_ID = 'virtual:bongle/edit-server';
const PIPELINE_BOOT_ID = 'virtual:bongle/pipeline';

type PipelineGame = { rebake: () => Promise<void>; stop: () => void };
type PipelineBootModule = { boot: (ctx: { onBaked: () => void }) => Promise<PipelineGame> };

/** Run the asset bake in a short-lived CHILD process (`bongle bake <root>`) — the
 *  icon render's Dawn instance segfaults a long-lived host, so it must exit right
 *  after (see project_node_bake_skia_not_node_canvas). Writes resources/ to disk;
 *  the play client + server read them back. */
function bakeInChild(projectDir: string): Promise<void> {
    return new Promise((res, rej) => {
        const child = spawn(process.execPath, [BONGLE_BIN, 'bake', projectDir], { cwd: projectDir, stdio: 'inherit' });
        child.on('error', rej);
        child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`bake exited with code ${code}`))));
    });
}

type ServerGame = { stop: () => void };
type ServerBootModule = { boot: (ctx: { httpServer: import('node:http').Server }) => Promise<ServerGame> };

export type DevHandle = {
    server: ViteDevServer;
    url: string;
    port: number;
    close: () => Promise<void>;
};

export async function startDevServer(opts: { projectDir: string; port?: number }): Promise<DevHandle> {
    const { projectDir } = opts;
    const port = opts.port ?? 5566;

    const rebootRef: EngineRebootRef = { requestServer: null, requestPipeline: null };
    const server = await createServer(defineBongleDevConfig({ projectDir, rootDir: SHELL_DIR, port, engineReboot: rebootRef }));
    await server.listen();

    const address = server.httpServer?.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    const serverEnv = server.environments.server as RunnableDevEnvironment;

    // boot the server env through its runner (so user code goes through the bongle()
    // capture transform + the server registry populates in this env's graph).
    const bootServer = async (): Promise<ServerGame> => {
        if (!server.httpServer) throw new Error('[bongle dev] vite httpServer not initialized');
        const mod = (await serverEnv.runner.import(SERVER_BOOT_ID)) as ServerBootModule;
        // vite types httpServer as http.Server | http2 — it's a node http.Server at
        // runtime in dev; narrow for the transport's `upgrade` hook.
        return mod.boot({ httpServer: server.httpServer as unknown as import('node:http').Server });
    };
    let game = await bootServer();

    // pipeline realm: evaluates user code + re-bakes on the SAME __kit flush HMR
    // fires (so a code edit re-bakes) and on asset-file change (the watcher below).
    // onBaked fans the client HMR refresh events the edit-client listens for.
    const pipelineEnv = server.environments.pipeline as RunnableDevEnvironment;
    const refreshResources = (): void => {
        for (const ev of ['bongle:block-texture-atlas-updated', 'bongle:sprite-atlas-updated', 'bongle:audio-atlas-updated']) {
            server.environments.client.hot.send(ev, {});
        }
    };
    const bootPipeline = async (): Promise<PipelineGame> => {
        const mod = (await pipelineEnv.runner.import(PIPELINE_BOOT_ID)) as PipelineBootModule;
        return mod.boot({ onBaked: refreshResources });
    };
    let pipeline = await bootPipeline();

    // engine-source hot-reboot (coalesced). The server + pipeline realms run engine
    // code, which has no HMR accept boundary — so an engine change without a reboot
    // runs stale code while clients reload. clearCache + re-boot both, reload clients.
    let rebooting = false;
    let queued = false;
    const reboot = async (): Promise<void> => {
        if (rebooting) {
            queued = true;
            return;
        }
        rebooting = true;
        try {
            do {
                queued = false;
                try {
                    game.stop();
                } catch (err) {
                    console.warn('[bongle dev] reboot: server stop failed:', err);
                }
                try {
                    pipeline.stop();
                } catch {}
                serverEnv.runner.clearCache();
                pipelineEnv.runner.clearCache();
                game = await bootServer();
                pipeline = await bootPipeline();
                server.environments.client.hot.send({ type: 'full-reload' });
                console.log('[bongle dev] engine-source changed — server + pipeline rebooted; clients reloading');
            } while (queued);
        } catch (err) {
            console.error('[bongle dev] engine reboot failed:', err);
        } finally {
            rebooting = false;
        }
    };
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const requestReboot = () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => void reboot(), 60);
    };
    rebootRef.requestServer = requestReboot;
    rebootRef.requestPipeline = requestReboot;

    // asset-file changes (texture / model / audio) → the pipeline realm's rebake
    // (the same bake its flush drives for code changes; onBaked fans HMR refresh).
    const ASSET_RE = /\.(png|jpe?g|glb|gltf|ogg|wav|mp3|flac)$/i;
    let bakeTimer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(projectDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const p = filename.toString().split(sep).join('/');
        if (/(^|\/)(resources|node_modules|dist|\.vite)(\/|$)/.test(p) || !ASSET_RE.test(p)) return;
        clearTimeout(bakeTimer);
        bakeTimer = setTimeout(() => {
            console.log(`[bongle dev] asset changed (${p}) → re-baking`);
            void pipeline.rebake();
        }, 150);
    });

    let closed = false;
    return {
        server,
        url: `http://localhost:${boundPort}`,
        port: boundPort,
        close: async () => {
            if (closed) return;
            closed = true;
            clearTimeout(debounce);
            clearTimeout(bakeTimer);
            watcher.close();
            try {
                game.stop();
            } catch {}
            try {
                pipeline.stop();
            } catch {}
            await server.close();
        },
    };
}

/** `bongle dev <project>` — bake once (child), start the Vite dev server, keep it
 *  alive until Ctrl-C. */
export async function devCommand(projectDir: string, opts: { port?: number } = {}): Promise<void> {
    const root = resolve(projectDir);
    try {
        await bakeInChild(root);
        console.log('[bongle dev] initial bake complete');
    } catch (err) {
        console.error(`[bongle dev] initial bake failed: ${(err as Error).message}`);
    }
    const handle = await startDevServer({ projectDir: root, port: opts.port });
    console.log(`bongle dev → ${handle.url}`);
    const shutdown = () => {
        console.log('\n[bongle dev] shutting down…');
        void handle.close().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
