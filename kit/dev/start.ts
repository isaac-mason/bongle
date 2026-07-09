/**
 * kit/dev/start.ts — start the bongle dev server (editor).
 *
 * Composition:
 *   1. `createServer(defineBongleConfig(...))` builds a Vite dev server with
 *      three named envs (`client`, `server`, `pipeline`) and the `bongle()`
 *      plugin across them. The `pipeline` env's ModuleRunner runs in a
 *      worker_thread (see vite/pipeline-env.ts) — the asset pipeline lives
 *      there, off the editor's main thread.
 *   2. `server.listen()` brings up Vite's http server on the configured
 *      port. Listen first so `server.httpServer` is bound when the
 *      transport hooks `upgrade`.
 *   3. `initGameEnv` imports `virtual:bongle/edit-server` through the
 *      server runner (served by the bongle:virtual-entries plugin).
 *      The virtual's `boot()` calls into `runtime/edit-server.start()` which
 *      attaches `/game` upgrades to `server.httpServer`. Loading populates
 *      the server-local registries.
 *   4. `pipelineWorker.sendBoot()` kicks the pipeline worker now that its env
 *      is initialized; its first pass resolves the `firstPipelineRun` gate.
 *
 * Returns a handle whose `.close()` shuts everything down — closes the
 * Vite server (which closes the http server, which closes the WS via the
 * transport's `'close'` handler), tears down the server env, and
 * disposes the user's ServerApp.
 */

import { createServer, type RunnableDevEnvironment, type ViteDevServer } from 'vite';
import { defineBongleConfig } from '../vite/config';
import type { EngineRebootRef } from '../vite/plugin';
import { getPipelineWorkerHandle } from '../vite/pipeline-env';
import { type GameEnvBootResult, initGameEnv } from './game-env';

export type StartDevOptions = {
    projectDir: string;
    bongleDir: string;
    port: number;
};

export type DevHandle = {
    server: ViteDevServer;
    game: GameEnvBootResult<unknown>;
    /** Port the http server actually bound to. Vite's `strictPort` is off, so
     *  this can differ from the requested port if it was taken between the
     *  free-port probe and `listen()` — callers must log/tunnel this, not the
     *  requested value. */
    port: number;
    /** Resolves once the pipeline worker's first pass has settled on cold start
     *  (bake + first icon render done, worker warm). The CLI awaits this before
     *  its ready banner. Resolves even on a pipeline fault, so it never wedges
     *  startup. */
    firstPipelineRun: Promise<void>;
    /** Tear down the server env + the vite server. Idempotent. */
    close(): Promise<void>;
};

export async function startDevServer(opts: StartDevOptions): Promise<DevHandle> {
    const { projectDir, bongleDir, port } = opts;

    // Set below once the envs have booted; the bongle:engine-reboot plugin calls
    // the matching `request*` on an engine-source change (a file outside
    // projectDir), per env.
    const rebootRef: EngineRebootRef = { requestServer: null, requestPipeline: null };

    const server = await createServer(defineBongleConfig({ projectDir, bongleDir, port, engineReboot: rebootRef }));
    await server.listen();

    // Source of truth for the bound port: read it off the http server rather
    // than trusting `port`. With `strictPort` off, vite silently picks the
    // next free port if the requested one was grabbed after our probe.
    const address = server.httpServer?.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;

    // The transport attaches inside the server env's boot entry
    // (`virtual:bongle/edit-server` → `runtime/edit-server.start`), so the
    // http server must already be bound — `server.listen()` above
    // guarantees that. initGameEnv forwards server.httpServer into the
    // virtual's `boot(ctx)` call.
    let game = await initGameEnv({ server, projectDir, bongleDir });

    // Engine-source hot-reboot. `bongle:engine-reboot` calls `rebootRef.request()`
    // when engine/workspace code (outside projectDir) changes — that code has no
    // HMR accept boundary, so without this the server runner keeps running stale
    // modules while the client page-reloads to a new build, skewing the wire
    // format. We dispose the live game, reset the server runner's module cache
    // (vite@8 `ModuleRunner.clearCache()`), re-boot fresh, then reload connected
    // clients so they reconnect to the matched server. Re-entrancy is coalesced
    // (a change mid-reboot queues one more pass); design:
    // llm/plan-dev-server-engine-reboot.md.
    let rebooting = false;
    let rebootQueued = false;
    async function rebootGameEnv(): Promise<void> {
        if (rebooting) {
            rebootQueued = true;
            return;
        }
        rebooting = true;
        try {
            do {
                rebootQueued = false;
                try {
                    game.transport.close();
                } catch (err) {
                    console.warn('[dev/start] reboot: transport close failed:', err);
                }
                try {
                    game.app.dispose?.(game.state);
                } catch (err) {
                    console.warn('[dev/start] reboot: app dispose failed:', err);
                }
                (server.environments.server as RunnableDevEnvironment).runner.clearCache();
                game = await initGameEnv({ server, projectDir, bongleDir });
                server.environments.client.hot.send({ type: 'full-reload' });
                console.log('[dev/start] engine-source changed — server env rebooted; clients reloading');
            } while (rebootQueued);
        } catch (err) {
            console.error('[dev/start] engine reboot failed:', err);
        } finally {
            rebooting = false;
        }
    }
    let rebootDebounce: ReturnType<typeof setTimeout> | undefined;
    rebootRef.requestServer = () => {
        clearTimeout(rebootDebounce);
        rebootDebounce = setTimeout(() => void rebootGameEnv(), 60);
    };

    // Boot the asset-pipeline worker now that the server is listening (so the
    // pipeline env is initialized before the worker's first fetchModule). The
    // worker imports the user entry through its own runner and self-drives off
    // HMR; results flow back via the bongle:pipeline plugin's control listener,
    // which opens the editor-load gate. Independent of the engine server above.
    const pipelineWorker = getPipelineWorkerHandle();
    pipelineWorker?.sendBoot();

    // Respawn the pipeline worker on a pipeline-engine-source change (it runs
    // engine bake/render code). A fresh worker fetches the new code; the old
    // worker's pinned Dawn instance dies with its isolate, so we sidestep the
    // clearCache-would-GC-the-instance segfault. Coalesced like the server reboot.
    let pipelineRebooting = false;
    let pipelineRebootQueued = false;
    async function rebootPipeline(): Promise<void> {
        if (!pipelineWorker) return;
        if (pipelineRebooting) {
            pipelineRebootQueued = true;
            return;
        }
        pipelineRebooting = true;
        try {
            do {
                pipelineRebootQueued = false;
                await pipelineWorker.reboot();
                console.log('[dev/start] engine-source changed — pipeline worker respawned');
            } while (pipelineRebootQueued);
        } catch (err) {
            console.error('[dev/start] pipeline reboot failed:', err);
        } finally {
            pipelineRebooting = false;
        }
    }
    let pipelineRebootDebounce: ReturnType<typeof setTimeout> | undefined;
    rebootRef.requestPipeline = () => {
        clearTimeout(pipelineRebootDebounce);
        pipelineRebootDebounce = setTimeout(() => void rebootPipeline(), 60);
    };

    let closed = false;
    async function close(): Promise<void> {
        if (closed) return;
        closed = true;
        // Await the worker's clean self-exit before tearing down the rest —
        // a forced exit while Dawn's pump is live napi-FATALs the process.
        await pipelineWorker?.close();
        try {
            game.transport.close();
        } catch (err) {
            console.warn('[dev/start] transport close failed:', err);
        }
        try {
            game.app.dispose?.(game.state);
        } catch (err) {
            console.warn('[dev/start] app.dispose failed:', err);
        }
        try {
            await server.close();
        } catch (err) {
            console.warn('[dev/start] server close failed:', err);
        }
    }

    return {
        server,
        // getter, not a snapshot — `game` is reassigned on engine reboot.
        get game() {
            return game;
        },
        port: boundPort,
        firstPipelineRun: pipelineWorker?.firstRun ?? Promise.resolve(),
        close,
    };
}
