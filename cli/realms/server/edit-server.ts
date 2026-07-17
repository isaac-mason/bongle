/// <reference types="vite/client" />
// cli/realms/server/edit-server.ts — boot EngineServer in mode:'edit' inside the
// `server` Vite env (a RunnableDevEnvironment in node) for `bongle dev`. Same shape
// as play-server.ts, but edit mode + scene persist writes back to disk (so the
// in-project editor's scene edits save). noExternal gives one shared bongle instance
// with the user code (userEntry).

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import path from 'node:path';
import { createInMemoryStorageDriver, EngineServer } from 'bongle/engine-server';
import { createFallbackAvatarsDriver } from 'bongle/engine-server-node';
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
    userEntry: () => Promise<unknown>;
};

type ServerState = ReturnType<typeof EngineServer.init>;
export type ServerBootResult = {
    app: ServerApp<ServerState>;
    state: ServerState;
    transport: GameTransport;
    stop: () => void;
};

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

    env.client = false;
    env.server = true;
    env.editor = true;
    await userEntry();

    await initZstd();
    const scenesDir = path.join(projectDir, SCENES_DIR);
    const scenes = await seedScenes(scenesDir);
    console.log(`[dev:server] seeded ${Object.keys(scenes).length} scene(s)`);

    // node fallback avatars: the sample pool (lib/avatars). A join gets a random
    // pick (resolveAvatar below) so it wears a real avatar, not the builtin.
    const avatars = createFallbackAvatarsDriver();

    const state = EngineServer.init({
        mode: 'edit',
        content: {
            scenes,
            persist: {
                write: (sceneId, content) => {
                    const file = path.join(scenesDir, `${sceneId}${SCENE_EXT}`);
                    void mkdir(path.dirname(file), { recursive: true }).then(() => writeFile(file, content));
                },
                delete: (sceneId) => void rm(path.join(scenesDir, `${sceneId}${SCENE_EXT}`), { force: true }),
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
            // absolute path = a sample-avatar serverUrl (lib/avatars); read directly.
            if (p.startsWith('/')) return new Uint8Array(await readFile(p));
            return new Uint8Array(await readFile(path.join(projectDir, p)));
        },
        zstd: { compress: zstdCompress },
        options: {},
        driver: { storage: createInMemoryStorageDriver(), avatars },
    });

    await EngineServer.load(state);
    console.log('[dev:server] loaded');
    __bongle.registerFlush(() => EngineServer.applyRegistryChanges(state));

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
        getInbox: (s) => s.net.inbox,
        getOutbox: (s) => s.net.outbox,
        clearOutbox: (s) => s.net.outbox.clear(),
    };

    const transport = attachGameTransport({ httpServer, app, state, resolveAvatar });

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
