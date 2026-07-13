/**
 * kit/dev/start.ts — start the bongle dev server (editor).
 *
 * Composition:
 *   1. `createServer(defineBongleConfig(...))` builds a Vite dev server with
 *      two named envs (`client`, `server`) and the `bongle()` plugin across
 *      them. NO pipeline env: the asset pipeline is editor-resident and
 *      browser-only (clean break 2026-07-13); kit dev serves whatever baked
 *      outputs already exist under resources/.
 *   2. `server.listen()` brings up Vite's http server on the configured
 *      port. Listen first so `server.httpServer` is bound when the
 *      transport hooks `upgrade`.
 *   3. `initGameEnv` imports `virtual:bongle/edit-server` through the
 *      server runner (served by the bongle:virtual-entries plugin).
 *      The virtual's `boot()` calls into `runtime/edit-server.start()` which
 *      attaches `/game` upgrades to `server.httpServer`. Loading populates
 *      the server-local registries.
 *
 * Returns a handle whose `.close()` shuts everything down — closes the
 * Vite server (which closes the http server, which closes the WS via the
 * transport's `'close'` handler), tears down the server env, and
 * disposes the user's ServerApp.
 */

import { createServer, type RunnableDevEnvironment, type ViteDevServer } from 'vite';
import { defineBongleConfig } from '../vite/config';
import type { EngineRebootRef } from '../vite/plugin';
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
    /** Tear down the server env + the vite server. Idempotent. */
    close(): Promise<void>;
};

export async function startDevServer(opts: StartDevOptions): Promise<DevHandle> {
    const { projectDir, bongleDir, port } = opts;

    // Set below once the envs have booted; the bongle:engine-reboot plugin calls
    // the matching `request*` on an engine-source change (a file outside
    // projectDir), per env.
    const rebootRef: EngineRebootRef = { requestServer: null };

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

    let closed = false;
    async function close(): Promise<void> {
        if (closed) return;
        closed = true;
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
        close,
    };
}
