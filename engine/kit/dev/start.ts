/**
 * kit/dev/start.ts — start the bongle dev server (editor).
 *
 * Composition:
 *   1. `createServer(defineBongleConfig(...))` builds a Vite dev server
 *      with the two named envs (`client`, `gameServer`) and the `bongle()`
 *      plugin in both. The plugin's `bongle:pipeline` entry registers an
 *      asset-pipeline flush handler against the gameServer env during
 *      `configureServer`, so there's no separate pipeline env to boot.
 *   2. `server.listen()` brings up Vite's http server on the configured
 *      port. Listen first so `server.httpServer` is bound when the
 *      transport hooks `upgrade`.
 *   3. `initGameEnv` imports `virtual:bongle/edit-server` through the
 *      gameServer runner (served by the bongle:virtual-entries plugin).
 *      The virtual's `boot()` calls into `runtime/edit-server.start()` which
 *      attaches `/game` upgrades to `server.httpServer`. Loading populates
 *      the gameServer-local registries; the initial `__kit.flush()`
 *      issued by `start()` drives the first pipeline pass alongside the
 *      engine's server-side dispatch.
 *
 * Returns a handle whose `.close()` shuts everything down — closes the
 * Vite server (which closes the http server, which closes the WS via the
 * transport's `'close'` handler), tears down the gameServer env, and
 * disposes the user's ServerApp.
 */

import { createServer, type ViteDevServer } from 'vite';
import { initGameEnv, type GameEnvBootResult } from './game-env';
import { defineBongleConfig } from '../vite/config';

export type StartDevOptions = {
    projectDir: string;
    bongleDir: string;
    port: number;
};

export type DevHandle = {
    server: ViteDevServer;
    game: GameEnvBootResult<unknown>;
    /** Tear down the gameServer env + the vite server. Idempotent. */
    close(): Promise<void>;
};

export async function startDevServer(opts: StartDevOptions): Promise<DevHandle> {
    const { projectDir, bongleDir, port } = opts;

    const server = await createServer(
        defineBongleConfig({ projectDir, bongleDir, port }),
    );
    await server.listen();

    // The transport attaches inside the gameServer env's boot entry
    // (`virtual:bongle/edit-server` → `runtime/edit-server.start`), so the
    // http server must already be bound — `server.listen()` above
    // guarantees that. initGameEnv forwards server.httpServer into the
    // virtual's `boot(ctx)` call.
    const game = await initGameEnv({ server, projectDir, bongleDir });

    let closed = false;
    async function close(): Promise<void> {
        if (closed) return;
        closed = true;
        try { game.transport.close(); } catch (err) { console.warn('[dev/start] transport close failed:', err); }
        try { game.app.dispose?.(game.state); } catch (err) { console.warn('[dev/start] app.dispose failed:', err); }
        try { await server.close(); } catch (err) { console.warn('[dev/start] server close failed:', err); }
    }

    return { server, game, close };
}
