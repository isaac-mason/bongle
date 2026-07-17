/// <reference types="vite/client" />
// cli/realms/server/play-server.ts — boot EngineServer inside the `server` Vite
// env (a RunnableDevEnvironment in the node process). Imported through
// virtual:bongle/play-server by start.ts; noExternal bundles bongle into this env's
// graph, so EngineServer/__bongle/env are the SAME instance the user code (userEntry)
// registered into. Sets env → evaluates user code → inits + loads EngineServer →
// attaches the /game WS transport → runs the 60Hz sim loop.

import { readdir, readFile } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import path from 'node:path';
import { createInMemoryStorageDriver, EngineServer } from 'bongle/engine-server';
import { env } from 'bongle/env';
import { __bongle } from 'bongle/internal';
import { initZstd, zstdCompress } from '../../../zstd-wasm';
import type { Client, JsonValue, ResolvedAvatar, ServerApp, User } from '../../../interface/index';
import { attachGameTransport, type GameTransport } from './transport';

const SCENES_DIR = 'content/scenes';
const SCENE_EXT = '.scene.json';

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

/** recursively read content/scenes/**.scene.json → { id: json } (ids are the path
 *  under content/scenes/ with the extension stripped). */
async function seedScenes(scenesDir: string): Promise<Record<string, string>> {
    const scenes: Record<string, string> = {};
    const walk = async (dir: string, prefix: string): Promise<void> => {
        for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full, `${prefix}${e.name}/`);
            else if (e.name.endsWith(SCENE_EXT)) scenes[`${prefix}${e.name.slice(0, -SCENE_EXT.length)}`] = await readFile(full, 'utf8');
        }
    };
    await walk(scenesDir, '');
    return scenes;
}

export async function start(opts: StartServerOptions): Promise<ServerBootResult> {
    const { httpServer, projectDir, userEntry } = opts;

    // env BEFORE user code — top-level declarations may branch on it.
    env.client = false;
    env.server = true;
    env.editor = false;
    await userEntry();

    await initZstd();
    const scenes = await seedScenes(path.join(projectDir, SCENES_DIR));
    console.log(`[dev:server] seeded ${Object.keys(scenes).length} scene(s)`);

    const state = EngineServer.init({
        mode: 'play',
        content: {
            scenes,
            persist: {
                write: () => {}, // dev play server is read-only for scene content
                delete: () => {},
            },
        },
        resourcesDir: 'resources/server',
        loadResource: async (p) => {
            if (p.startsWith('http:') || p.startsWith('https:')) {
                const r = await fetch(p);
                if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`);
                return new Uint8Array(await r.arrayBuffer());
            }
            if (p.startsWith('file:')) return new Uint8Array(await readFile(new URL(p)));
            return new Uint8Array(await readFile(path.join(projectDir, p)));
        },
        compressChunk: (payload) => zstdCompress(payload, 3),
        options: {},
        // node dev: no sample-avatar pool (joins get the builtin avatar).
        driver: { storage: createInMemoryStorageDriver(), avatars: { sample: async () => [] } },
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
        getInbox: (s) => s.net.inbox,
        getOutbox: (s) => s.net.outbox,
        clearOutbox: (s) => s.net.outbox.clear(),
    };

    const transport = attachGameTransport({ httpServer, app, state });

    let last = performance.now();
    const timer = setInterval(() => {
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;
        EngineServer.update(state, dt);
        transport.flush();
    }, 1000 / 60);

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
