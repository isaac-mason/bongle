/**
 * kit/dev/game-env.ts — boot the `gameServer` Vite environment.
 *
 * The gameServer env is a `RunnableDevEnvironment` declared in
 * `kit/vite/config.ts`. Its runner evaluates user + engine code in the
 * same node process as Vite, but isolated through Vite's module runner
 * (its own module graph, its own HMR boundary). We import the virtual
 * boot entry `virtual:bongle/edit-server` (served by the
 * `bongle:virtual-entries` plugin) through the runner so that:
 *
 *   1. Every transformed user module goes through the `bongle()` plugin —
 *      the capture transform runs in this env's pipeline too, so
 *      registry upserts in the env see correct owningModule().
 *   2. HMR for the server env routes through the runner's HMR (Vite's
 *      runnerOptions HMR) and the injected `hot.accept` boundaries.
 *   3. `applyRegistryChanges(state)` registered via `__kit.registerFlush`
 *      drains the env-local registries — separate from the client's.
 *
 * The virtual entry exports `boot(ctx)`. We grab the runner module, call
 * `boot({ httpServer, projectDir, bongleDir })`, and return the
 * `{ app, state, transport }` it constructs.
 */

import type { ServerApp } from 'bongle/interface';
import type { RunnableDevEnvironment, ViteDevServer } from 'vite';

export type GameEnvBootContext = {
    /** Vite's HTTP server — boot template attaches the `/game` WS here. */
    httpServer: import('node:http').Server;
    /** abs path to .bongle/ — boot template uses for any sidecar lookups. */
    bongleDir: string;
    /** abs path to project root. */
    projectDir: string;
};

export type GameEnvBootResult<S = unknown> = {
    app: ServerApp<S>;
    state: S;
    transport: { flush(): void; close(): void };
};

export type InitGameEnvOptions = {
    server: ViteDevServer;
    projectDir: string;
    bongleDir: string;
};

const BOOT_ID = 'virtual:bongle/edit-server';

export async function initGameEnv(opts: InitGameEnvOptions): Promise<GameEnvBootResult<unknown>> {
    const { server, projectDir, bongleDir } = opts;

    const env = server.environments.gameServer as RunnableDevEnvironment | undefined;
    if (!env) {
        throw new Error('[game-env] gameServer environment not configured — check vite config');
    }
    if (!server.httpServer) {
        throw new Error('[game-env] vite httpServer not initialized — call server.listen() first');
    }

    const mod = (await env.runner.import(BOOT_ID)) as {
        boot?: (ctx: GameEnvBootContext) => Promise<GameEnvBootResult<unknown>>;
    };
    if (typeof mod.boot !== 'function') {
        throw new Error(
            `[game-env] ${BOOT_ID} did not export \`boot(ctx)\` — ` +
                `check kit/vite/virtual-entries.ts`,
        );
    }

    return await mod.boot({
        httpServer: server.httpServer,
        projectDir,
        bongleDir,
    });
}
