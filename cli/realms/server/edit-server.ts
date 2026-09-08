/// <reference types="vite/client" />
// cli/realms/server/edit-server.ts — boot EngineServer in mode:'edit' inside the
// `server` Vite env (a RunnableDevEnvironment in node) for `bongle dev`. Same shape
// as play-server.ts, but edit mode + scene persist writes back to disk (so the
// in-project editor's scene edits save). noExternal gives one shared bongle instance
// with the user code (userEntry).

import type { Server as HttpServer } from 'node:http';
import * as api from 'bongle';
import { createInMemoryStorageDriver, EngineServer, SERVER_TICK_HZ } from 'bongle/engine-server';
import * as EngineServerEditor from 'bongle/engine-server-editor';
import { env } from 'bongle/env';
import type { Channel, Client, JsonValue, ResolvedAvatar, ServerApp, User } from '../../../interface/index';
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
    // matches the client's — without it models stay cold-start placeholders.
    // @ts-expect-error — a Vite resolve.alias (→ <projectDir>/src/generated/models.ts), not resolvable by tsgo.
    await import('bongle-project-models');

    await initZstd();

    // node fallback avatars: the sample pool (lib/avatars). A join gets a random
    // pick (resolveAvatar below) so it wears a real avatar, not the builtin.
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

    // importing bongle/engine-server-editor registered the editor's server
    // declarations; load builds the derived indexes over them. expose state + api
    // on globalThis for ad-hoc inspection via `bun --inspect` / devtools.
    const g = globalThis as unknown as { _state: ServerState; _api: typeof api };
    g._state = state;
    g._api = api;
    await EngineServer.load(state);
    console.log('[dev:server] loaded');
    EngineServerEditor.watchRegistry(state);

    // random sample avatar per join → onClientJoin (via the transport), so clients
    // wear a real avatar instead of the failing builtin fallback.
    let avatarPool: ResolvedAvatar[] = [];
    try {
        avatarPool = await avatars.sample();
    } catch {}
    const resolveAvatar = (): ResolvedAvatar | undefined =>
        avatarPool.length > 0 ? avatarPool[Math.floor(Math.random() * avatarPool.length)] : undefined;

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

    const transport = attachGameTransport({ httpServer, app, state, sink, resolveAvatar });

    let last = performance.now();
    const timer = setInterval(() => {
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;
        EngineServer.update(state, dt);
    }, 1000 / SERVER_TICK_HZ);

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
