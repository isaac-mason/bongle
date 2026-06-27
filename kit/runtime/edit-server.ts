/// <reference types="vite/client" />
/**
 * kit/runtime/edit-server.ts — boot module for the dev server Vite env.
 *
 * Invoked through the `virtual:bongle/edit-server` virtual module (served
 * by `kit/vite/virtual-entries.ts`). The kit's `dev/game-env.ts` imports
 * that virtual through the env's runner and calls its `boot(ctx)` export,
 * which in turn calls `start(opts)` below with an HttpServer + project dirs.
 *
 * Flow:
 *  1. Set env flags BEFORE awaiting user-entry. Top-level
 *     `model()/block()/script()/...` calls in user code may branch on env.
 *  2. Await `opts.userEntry()` so registries populate before
 *     `EngineServer.load()` snapshots them.
 *  3. Init + load EngineServer with the storage/avatars drivers.
 *  4. Register server-side `applyRegistryChanges` as a flush handler. The
 *     bongle:pipeline plugin entry has already registered its Node-side
 *     pipeline handler against this env's `bongle/internal` — both fire
 *     on each settled HMR cascade.
 *  5. Attach `/game` WS transport (the runtime transport.ts).
 *  6. 60Hz frame loop.
 *  7. Kick the initial `__kit.flush()` — dispatch is no-op on clean boot;
 *     the pipeline handler is the meaningful consumer (atlas + models +
 *     scenes + matchmaking config on pipeline state).
 */

import type { Server as HttpServer } from 'node:http';
import path from 'node:path';
import { env } from 'bongle';
import { createFallbackAvatarsDriver, createInMemoryStorageDriver, EngineServer } from 'bongle/engine-server';
import { __kit } from 'bongle/internal';
import { attachGameTransport } from 'bongle/kit/runtime/transport';

export type StartOptions = {
    httpServer: HttpServer;
    projectDir: string;
    bongleDir: string;
    /** Dynamic import of `virtual:bongle/user-src` — side-effect imports
     *  the user's src/generated + src/index. Awaited AFTER env is set so
     *  user-code top-level declarations see the right env. */
    userEntry: () => Promise<unknown>;
};

export async function start(opts: StartOptions) {
    const { httpServer, bongleDir, userEntry } = opts;

    env.client = false;
    env.server = true;
    env.editor = true;

    // content/ + resources/server/ live alongside .bongle/. Anchor via the
    // bongleDir passed in — never falls back to process.cwd().
    const contentDir = path.join(bongleDir, '..', 'content');
    const resourcesDir = path.join(bongleDir, '..', 'resources', 'server');

    await userEntry();

    const state = EngineServer.init({
        mode: 'edit',
        contentDir,
        resourcesDir,
        options: {},
        driver: {
            storage: createInMemoryStorageDriver(),
            avatars: createFallbackAvatarsDriver(),
        },
    });

    await EngineServer.load(state);

    __kit.registerFlush(() => {
        EngineServer.applyRegistryChanges(state);
    });

    // scene HMR — symmetric to the client. parses the raw JSON event payload
    // and stamps the authored payload onto the matching SceneHandle, then
    // re-populates scene state via Content.populateScene. ids without a
    // matching scene() declaration are ignored inside applyScenePayload.
    if (import.meta.hot) {
        import.meta.hot.on('bongle:scene-update', (msg: { id: string; scene: string }) => {
            const file = JSON.parse(msg.scene);
            const voxels = file.chunks ? { chunks: file.chunks } : null;
            EngineServer.applyScenePayload(state, msg.id, { nodes: file.nodes, voxels });
        });
        import.meta.hot.on('bongle:scene-clear', (msg: { id: string }) => {
            EngineServer.clearScene(state, msg.id);
        });
    }

    const app = {
        init: (_d: unknown) => state,
        load: async () => {},
        update: (s: typeof state, dt: number) => EngineServer.update(s, dt),
        dispose: (s: typeof state) => {
            clearInterval(timer);
            EngineServer.dispose(s);
        },
        onClientJoin: (s: typeof state, c: number, u: unknown, j: unknown) =>
            EngineServer.onClientJoin(s, c as never, u as never, j as never),
        onClientLeave: (s: typeof state, c: number) => EngineServer.onClientLeave(s, c as never),
        getInbox: (s: typeof state) => s.net.inbox,
        getOutbox: (s: typeof state) => s.net.outbox,
        clearOutbox: (s: typeof state) => {
            s.net.outbox.clear();
        },
    };

    const transport = attachGameTransport({ httpServer, app, state });

    const TICK_MS = 1000 / 60;
    let last = performance.now();
    const timer = setInterval(() => {
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;
        EngineServer.update(state, dt);
        transport.flush();
    }, TICK_MS);

    __kit.flush();

    return { app, state, transport };
}
