/// <reference types="vite/client" />
// cli/realms/server/play-server.ts — boot EngineServer inside the `server` Vite
// env (a RunnableDevEnvironment in the node process). Imported through
// virtual:bongle/play-server by start.ts; noExternal bundles bongle into this env's
// graph, so EngineServer/__bongle/env are the SAME instance the user code (userEntry)
// registered into. Sets env → evaluates user code → inits + loads EngineServer →
// attaches the /game WS transport → runs the 60Hz sim loop.

import type { Server as HttpServer } from 'node:http';
import { createInMemoryStorageDriver, EngineServer, SERVER_TICK_HZ } from 'bongle/engine-server';
import { env } from 'bongle/env';
import { __bongle } from 'bongle/internal';
import type { Channel, Client, JsonValue, ResolvedAvatar, ServerApp, User } from '../../../interface/index';
import { initZstd, zstdCompress } from '../../../zstd-wasm';
import { openNodeFs } from '../../node-fs';
import { attachGameTransport, createSocketSink, type GameTransport } from './transport';

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

    // env BEFORE user code — top-level declarations may branch on it.
    env.client = false;
    env.server = true;
    env.editor = false;
    await userEntry();

    await initZstd();

    // the socket map exists before the engine: the engine's `send` closes over it.
    const sink = createSocketSink();
    const state = EngineServer.init({
        mode: 'play',
        fs: openNodeFs(projectDir),
        zstd: { compress: zstdCompress },
        options: {},
        // node dev: no sample-avatar pool (joins get the builtin avatar).
        driver: { storage: createInMemoryStorageDriver(), avatars: { sample: async () => [] } },
        send: sink.send,
    });

    await EngineServer.load(state);
    console.log('[dev:server] loaded');
    __bongle.registerFlush(() => EngineServer.applyRegistryChanges(state));

    const app: ServerApp<ServerState> = {
        init: () => state,
        load: async () => {},
        update: (s, dt) => EngineServer.update(s, dt),
        dispose: (s) => EngineServer.dispose(s),
        onClientJoin: (s, client: Client, user: User, joinData: Record<string, JsonValue>, avatar?: ResolvedAvatar) =>
            EngineServer.onClientJoin(s, client, user, joinData, avatar),
        onClientLeave: (s, client: Client) => EngineServer.onClientLeave(s, client),
        receive: (s, client: Client, channel: Channel, bytes: Uint8Array) => EngineServer.receive(s, client, channel, bytes),
    };

    const transport = attachGameTransport({ httpServer, app, state, sink });

    let last = performance.now();
    const timer = setInterval(() => {
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;
        EngineServer.update(state, dt);
    }, 1000 / SERVER_TICK_HZ);

    __bongle.flush();

    return {
        app,
        state,
        transport,
        stop: () => {
            clearInterval(timer);
            transport.close();
            EngineServer.dispose(state);
        },
    };
}
