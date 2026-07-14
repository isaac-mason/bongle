// editor/server.ts — boot EngineServer inside the server WORKER realm
// (server-env). The user's code has been evaluated by the worker's bundler
// (registry populated), so this seeds content from the project fs, wires the
// browser drivers (in-memory storage, zstd-wasm compressor, fs resource
// loader), and loads. It does NOT own timing or transport: it returns a
// ServerApp adapter + avatar picker, and the worker composes the tick loop and
// the in-tab MessagePort transport (editor/transport-server.ts) around them —
// exactly the shape the deployed game-room composes around the WS transport.

// import the engine-server MODULE directly, not the `bongle/engine-server`
// entry — the entry re-exports the node-only avatars-fallback (node:fs), which
// would break the browser bundle.
import type { Client, JsonValue, ResolvedAvatar, ServerApp, User } from '../../interface/index';
import type * as InternalNS from '../../src/internal';
// type-only: the RUNTIME EngineServer + __kit come from the runner (the realm's
// bundled engine instance the user code registered into), passed in via opts.
import { RIG_TYPE_6BONE } from '../../src/core/avatar/rig';
import type * as EngineServerNS from '../../src/server/engine-server';
import { createInMemoryStorageDriver } from '../../src/server/storage-in-memory';
import { initZstd, zstdCompress } from '../../zstd-wasm';
import type { Filesystem } from '../fs';
import { createEditorAvatarsDriver } from './avatars';

const SCENES_DIR = 'content/scenes';
const SCENE_EXT = '.scene.json';

type EngineServerApi = typeof EngineServerNS;
type Kit = typeof InternalNS.__kit;
type ServerState = ReturnType<EngineServerApi['init']>;

export type EditorServer = {
    state: ServerState;
    /** ServerApp adapter over the EngineServer module — the transport drives
     *  join/leave/inbox/outbox/update through this, same contract game-room
     *  and the kit dev transport use. */
    app: ServerApp<ServerState>;
    /** Synchronous per-join avatar pick (random from the sample pool), mirroring
     *  the deployed matchmaker path so runtime-avatar load is exercised. */
    resolveAvatar: () => ResolvedAvatar | undefined;
    /** re-apply the (edited) local-player avatar to every connected client —
     *  live preview after a Blockbench save rewrites avatar.glb. No-op unless a
     *  localAvatarUrl was set (avatar/game intent with an avatar). */
    reloadAvatar: () => void;
    stop: () => void;
};

export type StartEditorServerOptions = {
    fs: Filesystem;
    /** the realm's bundled engine + __kit, from `runner.import` — the SAME
     *  instance the user code registered its declarations into. */
    EngineServer: EngineServerApi;
    __kit: Kit;
    log?: (msg: string) => void;
    /** a specific avatar for the local player (the edited avatar in avatar mode,
     *  or our account avatar when editing a game as ourselves). The URL feeds
     *  clientUrl/serverUrl: `file://…` reads the edited glb from OPFS, `http(s)`
     *  fetches the account avatar. When absent, joins get a random sample. */
    localAvatarUrl?: string;
};

export async function startEditorServer(opts: StartEditorServerOptions): Promise<EditorServer> {
    const { fs, EngineServer, __kit, log = () => {} } = opts;

    // zstd compressor for the voxel wire codec (client decodes with fzstd).
    await initZstd();

    // seed the scene store from the project fs (content-manager is in-memory
    // sync; the host does the async read).
    const scenes: Record<string, string> = {};
    for (const entry of await fs.list(SCENES_DIR, { recursive: true })) {
        if (entry.kind !== 'file' || !entry.path.endsWith(SCENE_EXT)) continue;
        const sceneId = entry.path.slice(SCENES_DIR.length + 1, -SCENE_EXT.length);
        scenes[sceneId] = await fs.readText(entry.path);
    }
    log(`seeded ${Object.keys(scenes).length} scene(s)`);

    // the engine's example avatars (lib/avatars), served by vite. Held so the
    // avatar picker below can pre-fetch its sample pool.
    const avatars = createEditorAvatarsDriver();

    const state = EngineServer.init({
        mode: 'edit',
        content: {
            scenes,
            persist: {
                write: (sceneId, content) => void fs.write(`${SCENES_DIR}/${sceneId}${SCENE_EXT}`, content),
                delete: (sceneId) => void fs.remove(`${SCENES_DIR}/${sceneId}${SCENE_EXT}`),
            },
        },
        resourcesDir: 'resources/server',
        // baked server resources read from OPFS by path; a platform avatar's
        // clientUrl/serverUrl can also be file:// (edited glb in OPFS) or http(s)
        // (our account avatar on the CDN) — mirror the client loader so the local
        // player's avatar resolves server-side too. (Cross-origin http needs CORS
        // on the avatar CDN under the worker's COEP.)
        loadResource: async (path) => {
            if (path.startsWith('http:') || path.startsWith('https:')) {
                const r = await fetch(path);
                if (!r.ok) throw new Error(`fetch ${path}: ${r.status}`);
                return new Uint8Array(await r.arrayBuffer());
            }
            if (path.startsWith('file:')) return fs.read(new URL(path).pathname.replace(/^\/+/, ''));
            return fs.read(path);
        },
        compressChunk: (payload) => zstdCompress(payload, 3),
        options: {},
        driver: {
            storage: createInMemoryStorageDriver(),
            avatars,
        },
    });

    await EngineServer.load(state);
    log('server loaded');

    // apply registry changes to the running server on each settled flush (the
    // worker's bundler flushes after evaluating user code / an HMR cascade;
    // this updates the live world in place).
    const unregister = __kit.registerFlush(() => {
        EngineServer.applyRegistryChanges(state);
    });

    // ServerApp adapter — the transport (editor/transport-server.ts) drives the
    // engine through this exactly like game-room/edit-server drive it through
    // the WS transport. getInbox/getOutbox expose the per-Client frame maps.
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

    // pre-fetch the sample pool once; picker yields a random avatar per join.
    let avatarPool: ResolvedAvatar[] = [];
    try {
        avatarPool = await avatars.sample();
    } catch {
        // empty pool → picker returns undefined → engine uses the builtin.
    }
    // a platform-supplied avatar (edited avatar / our account avatar) overrides
    // the random pick so the local player wears it; extra test clients fall back
    // to the random sample only when no specific avatar is set. The modelId
    // carries a version so a live swap (reloadAvatar) mints a FRESH id — the same
    // id would be a CharacterTrait reconciler no-op.
    let avatarVersion = 0;
    const makeLocalAvatar = (): ResolvedAvatar | undefined =>
        opts.localAvatarUrl
            ? {
                  source: 'runtime',
                  modelId: `local-player-avatar@${avatarVersion}`,
                  clientUrl: opts.localAvatarUrl,
                  serverUrl: opts.localAvatarUrl,
                  rigType: RIG_TYPE_6BONE,
              }
            : undefined;
    let localAvatar = makeLocalAvatar();
    const resolveAvatar = () =>
        localAvatar ?? (avatarPool.length > 0 ? avatarPool[Math.floor(Math.random() * avatarPool.length)] : undefined);

    // live avatar preview: the edited glb was rewritten (Blockbench save) at the
    // SAME url, so mint a fresh modelId + re-register/re-stamp every connected
    // client — the CharacterTrait reconciler unmounts the old rig + mounts the new
    // one, no re-join. New joins pick up the fresh id too (localAvatar updated).
    const reloadAvatar = () => {
        avatarVersion++;
        localAvatar = makeLocalAvatar();
        if (!localAvatar) return;
        for (const client of state.clients.connected.keys()) {
            EngineServer.reloadClientAvatar(state, client, localAvatar);
        }
        log(`avatar reloaded → ${localAvatar.modelId}`);
    };

    return {
        state,
        app,
        resolveAvatar,
        reloadAvatar,
        stop: () => {
            unregister();
            EngineServer.dispose(state);
        },
    };
}
