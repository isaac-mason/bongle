/// <reference types="vite/client" />
// cli/realms/server/play-server.ts, boot EngineServer inside the `server` Vite env (a
// RunnableDevEnvironment in the node process) for `bongle dev`. Imported through
// virtual:bongle/play-server by start.ts; noExternal bundles bongle into this env's
// graph, so EngineServer and env are the SAME instance the user code (userEntry)
// registered into. Sets env, evaluates user code, inits + loads EngineServer,
// attaches the /game WS transport, runs the 60Hz sim.

import type { Server as HttpServer } from 'node:http';
import { createInMemoryStorageDriver, EngineServer, SERVER_TICK_HZ } from 'bongle/engine-server';
import { env } from 'bongle/env';
import { createClientTable, serverTick } from '../../../build';
import type { ServerApp } from '../../../interface/index';
import { initZstd, zstdCompress } from '../../../zstd-wasm';
import { openNodeFs } from '../../node-fs';
import { attachGameTransport, type GameTransport } from './transport';

export type StartServerOptions = {
    httpServer: HttpServer;
    projectDir: string;
    /** dynamic import of the user src (side-effect registers declarations). */
    userEntry: () => Promise<unknown>;
};

type ServerState = ReturnType<typeof EngineServer.init>;
export type ServerBootResult = {
    app: ServerApp<ServerState>;
    state: ServerState;
    transport: GameTransport;
    stop: () => void;
};

export async function start(opts: StartServerOptions): Promise<ServerBootResult> {
    const { httpServer, projectDir, userEntry } = opts;

    // env BEFORE user code: top-level declarations may branch on it.
    env.client = false;
    env.server = true;
    env.editor = false;
    await userEntry();

    await initZstd();

    // the client table exists before the engine: the engine's `send` closes over it.
    const clients = createClientTable();
    const state = EngineServer.init({
        mode: 'play',
        fs: openNodeFs(projectDir),
        zstd: { compress: zstdCompress },
        options: {},
        // node dev: no sample-avatar pool (joins get the builtin avatar).
        driver: { storage: createInMemoryStorageDriver(), avatars: { sample: async () => [] } },
        send: clients.send,
    });
    await EngineServer.load(state);
    console.log('[dev:server] loaded');
    EngineServer.watchRegistry(state);

    const app = EngineServer.app('play');
    const transport = attachGameTransport({ httpServer, app, state, clients });
    const stopTick = serverTick((dt) => app.update(state, dt), SERVER_TICK_HZ);

    return {
        app,
        state,
        transport,
        stop: () => {
            stopTick();
            transport.close();
            EngineServer.dispose(state);
        },
    };
}
