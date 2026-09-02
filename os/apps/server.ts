import { SERVER_TICK_HZ } from 'bongle/engine-server';
import { exposeDevtools } from '../devtools';
import type { App, EditorSession } from '../interface';
import { type EditorServer, startEditorServer } from './server/editor-server';
import { type ClientMeta, createPortTransport } from './server/transport-server';

// The server app. Waits for the bake, boots EngineServer through the runner,
// runs the 60Hz sim, and serves "game": each connection is a client-join.
// Flushes to disk on shutdown (awaited).
//
// Engine RUNTIME is reached only via env.runner.import (env flags must be set
// before engine modules evaluate); statics are leaf utilities bundled into this
// entry at engine build.
const server: App = async (env) => {
    const cfg = env.init as EditorSession;

    // wait for the pipeline's first bake (src/generated/* exists) before booting.
    env.progress('waiting for bake');
    await env.connect('pipeline');
    env.progress('loading');

    const fs = env.fs;
    const runner = env.runner;

    const { env: rt } = await runner.import('bongle/env');
    rt.client = false;
    rt.server = true;
    rt.editor = true;
    await runner.import(cfg.entry ?? 'src/index.ts');
    await runner.import('src/generated/models.ts');
    const engineServerModule = await runner.import('bongle/engine-server');
    const { EngineServer } = engineServerModule;
    const EngineServerEditor = await runner.import('bongle/engine-server-editor');

    const srv: EditorServer = await startEditorServer({
        fs,
        log: (m: string) => env.log(m),
        EngineServer,
        EngineServerEditor,
        storage: engineServerModule.createInMemoryStorageDriver(),
        localAvatarUrl: cfg.avatarUrl,
    });
    exposeDevtools('server', { fs, server: EngineServer, state: srv.state, app: srv.app, editor: EngineServerEditor });

    const transport = createPortTransport(srv.app, srv.state, srv.resolveAvatar);

    let last = performance.now();
    const timer = setInterval(() => {
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;
        try {
            srv.app.update(srv.state, dt);
            transport.flush();
        } catch (err) {
            env.err('tick error:', String((err as Error).message));
        }
    }, 1000 / SERVER_TICK_HZ);

    // graceful shutdown: stop the loop, drain the transport, flush dirty rooms to
    // disk — AWAITED, so the OS holds teardown until saves land.
    env.onDispose(async () => {
        clearInterval(timer);
        transport.close();
        await srv.stop();
    });

    // avatar live-swap on edit.
    env.fs.watch((changes) => {
        if (changes.some((c) => c.path === 'avatar.glb')) srv.reloadAvatar();
    });

    // clients join over "game". The account identity lives on the CLIENT (its
    // driver); the server sees the meta's user when the dialer carries one (a
    // relay guest) and a synthesized dev meta otherwise.
    let nextConn = 1;
    env.listen('game', (conn, meta) => {
        const connectionId = nextConn++;
        const clientMeta: ClientMeta = {
            user: meta.user ?? { id: `dev-${meta.pid}`, username: `guest-${meta.pid}` },
            joinData: {},
        };
        // adapt the OS Channel to the MessagePort shape the transport drives — it
        // uses postMessage + onmessage + close (the transport's detach closes it).
        const port = {
            postMessage: (data: unknown) => conn.send(data),
            onmessage: null as ((e: { data: unknown }) => void) | null,
            close: () => conn.close(),
        };
        transport.acceptClient(connectionId, port as unknown as MessagePort, clientMeta);
        void conn.closed.then(() => transport.leaveClient(connectionId));
        env.log(`client ${connectionId} joined`);
        return (m) => port.onmessage?.({ data: m });
    });

    env.log('game server up; listening on "game"');
    env.progress('ready');
};

export default server;
