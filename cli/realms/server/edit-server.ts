/// <reference types="vite/client" />
// cli/realms/server/edit-server.ts, boot EngineServer in mode:'edit' inside the
// `server` Vite env (a RunnableDevEnvironment in node) for `bongle dev`. Same shape
// as play-server.ts, plus the editor: its declarations register when this module
// imports bongle/engine-server-editor, and it writes scene edits back to disk.
// noExternal gives one shared bongle instance with the user code (userEntry).

import type { Server as HttpServer } from 'node:http';
import * as api from 'bongle';
import { createInMemoryStorageDriver, EngineServer, SERVER_TICK_HZ } from 'bongle/engine-server';
import 'bongle/engine-server-editor';
import { env } from 'bongle/env';
import { avatarPicker, serverTick } from '../../../build';
import type { ServerApp } from '../../../interface/index';
import { createFallbackAvatarsDriver } from '../../../src/node/sample-avatars-driver';
import { initZstd, zstdCompress } from '../../../zstd-wasm';
import { openNodeFs } from '../../node-fs';
import { attachGameTransport, createSocketSink, type GameTransport } from './transport';

export type StartServerOptions = {
    httpServer: HttpServer;
    projectDir: string;
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

    env.client = false;
    env.server = true;
    env.editor = true;
    await userEntry();
    // the baked barrel patches model handles with their bin paths (mirrors the
    // editor realm importing src/generated/models.ts) so the server registry
    // matches the client's; without it models stay cold-start placeholders.
    // @ts-expect-error a Vite resolve.alias (<projectDir>/src/generated/models.ts), not resolvable by tsgo.
    await import('bongle-project-models');

    await initZstd();

    // node fallback avatars: the sample pool (lib/avatars), so a join wears a real
    // avatar instead of the builtin.
    const avatars = createFallbackAvatarsDriver();

    // the socket map exists before the engine: the engine's `send` closes over it.
    const sink = createSocketSink();
    const state = EngineServer.init({
        mode: 'edit',
        fs: openNodeFs(projectDir),
        zstd: { compress: zstdCompress },
        options: {},
        driver: { storage: createInMemoryStorageDriver(), avatars },
        send: sink.send,
    });
    // expose state + api on globalThis for ad-hoc inspection via `bun --inspect` / devtools.
    const g = globalThis as unknown as { _state: ServerState; _api: typeof api };
    g._state = state;
    g._api = api;
    await EngineServer.load(state);
    console.log('[dev:server] loaded');
    EngineServer.watchRegistry(state);

    const app = EngineServer.app('edit');
    const picker = await avatarPicker(avatars);
    const transport = attachGameTransport({ httpServer, app, state, sink, resolveAvatar: picker.resolve });
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
