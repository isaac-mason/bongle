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

import { createServer, type ViteDevServer } from 'vite';
import { defineBongleConfig } from '../vite/config';
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

    const server = await createServer(defineBongleConfig({ projectDir, bongleDir, port }));
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
    const game = await initGameEnv({ server, projectDir, bongleDir });

    // Boot the asset-pipeline worker now that the server is listening (so the
    // pipeline env is initialized before the worker's first fetchModule). The
    // worker imports the user entry through its own runner and self-drives off
    // HMR; results flow back via the bongle:pipeline plugin's control listener,
    // which opens the editor-load gate. Independent of the engine server above.
    const pipelineWorker = getPipelineWorkerHandle();
    pipelineWorker?.sendBoot();

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
        game,
        port: boundPort,
        firstPipelineRun: pipelineWorker?.firstRun ?? Promise.resolve(),
        close,
    };
}
