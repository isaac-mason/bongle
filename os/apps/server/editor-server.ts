// os/apps/server/editor-server.ts — boot EngineServer inside the server app's
// realm. The user's code has been evaluated by the realm's runner (registry
// populated), so this seeds content from the project fs, wires the browser
// drivers (in-memory storage, zstd-wasm compressor, fs resource loader), and
// loads. It does NOT own timing or transport: it returns a ServerApp adapter +
// avatar picker, and the server app composes the tick loop and the MessagePort
// transport (transport-server.ts) around them — exactly the shape the deployed
// game-room composes around the WS transport.

import { RIG_TYPE_6BONE } from 'bongle/avatar';
import type { Client, Filesystem as ServerFilesystem, JsonValue, ResolvedAvatar, ServerApp, ServerDriver, User } from 'bongle/interface';
import { initZstd, zstdCompress } from 'bongle/zstd-wasm';
import type { Filesystem } from '../../interface';

// The editor server's `ServerDriver.avatars`, the artifact counterpart to
// src/server/avatars-fallback.ts (node-gated). The engine's example avatars ship
// raw in the package (avatars/), so in the editor they sit in the project vfs at
// node_modules/bongle/avatars/ (seeded) — referenced as `file://` URLs both
// engine loaders resolve through the project fs. Same runtime-avatar path as
// prod: plain `.glb`, fetched + gltfUnpack'd. Excludes `base` (the builtin
// fallback, not a sample to dress NPCs in).
const AVATAR_SAMPLES: Record<string, string> = {
    boy: 'avatar:boy',
    girl: 'avatar:girl',
    blindfoldedpenguin: 'avatar:penguin',
    pigeon: 'avatar:pigeon',
};

function createEditorAvatarsDriver(): ServerDriver['avatars'] {
    const batch: ResolvedAvatar[] = Object.entries(AVATAR_SAMPLES).map(([dir, modelId]) => {
        const url = `file:///node_modules/bongle/avatars/${dir}/${dir}.glb`;
        return { source: 'runtime', modelId, clientUrl: url, serverUrl: url, rigType: RIG_TYPE_6BONE };
    });
    return { sample: async () => batch };
}

// type-only: the RUNTIME EngineServer + EngineServerEditor come from the runner (the
// realm's bundled engine instance the user code registered into), passed in via opts.
// Typed off the public `bongle/*` surfaces, matching how the rest of `bongle`
// resolves, rather than reaching into engine source directly.
// `bongle/engine-server` wraps its api under `export * as EngineServer` (the
// runner-imported value the app destructures), so reach into that namespace.
type EngineServerApi = (typeof import('bongle/engine-server'))['EngineServer'];
type EngineServerEditorApi = typeof import('bongle/engine-server-editor');
type ServerState = ReturnType<EngineServerApi['init']>;

export type EditorServer = {
    state: ServerState;
    /** ServerApp adapter over the EngineServer module — the transport drives
     *  join/leave/inbox/outbox/update through this, same contract game-room
     *  and the cli dev transport use. */
    app: ServerApp<ServerState>;
    /** Synchronous per-join avatar pick (random from the sample pool), mirroring
     *  the deployed matchmaker path so runtime-avatar load is exercised. */
    resolveAvatar: () => ResolvedAvatar | undefined;
    /** re-apply the (edited) local-player avatar to every connected client —
     *  live preview after a Blockbench save rewrites avatar.glb. No-op unless a
     *  localAvatarUrl was set (avatar/game intent with an avatar). */
    reloadAvatar: () => void;
    /** graceful teardown: flush the final dirty-room save, WAIT for those OPFS
     *  writes to land, then dispose the engine. Async because persist writes are
     *  fire-and-forget — a restart reloads from disk, so unflushed bytes would be
     *  lost if we tore down before they settled. Resolves once disk is current. */
    stop: () => Promise<void>;
};

export type StartEditorServerOptions = {
    fs: Filesystem;
    /** the realm's bundled engine + its editor composition, from `runner.import` —
     *  the SAME instance the user code registered its declarations into. */
    EngineServer: EngineServerApi;
    EngineServerEditor: EngineServerEditorApi;
    /** the storage driver, from the same runner-imported `bongle/engine-server`
     *  (createInMemoryStorageDriver) — the app must not static-import engine
     *  runtime, and storage belongs to the realm's engine instance. */
    storage: ServerDriver['storage'];
    log?: (msg: string) => void;
    /** a specific avatar for the local player (the edited avatar in avatar mode,
     *  or our account avatar when editing a game as ourselves). The URL feeds
     *  clientUrl/serverUrl: `file://…` reads the edited glb from OPFS, `http(s)`
     *  fetches the account avatar. When absent, joins get a random sample. */
    localAvatarUrl?: string;
};

export async function startEditorServer(opts: StartEditorServerOptions): Promise<EditorServer> {
    const { fs, EngineServer, EngineServerEditor, log = () => {} } = opts;

    // zstd compressor for the voxel wire codec (client decodes with fzstd).
    await initZstd();

    // in-flight OPFS persist writes. content-manager's persist hook is
    // fire-and-forget (it never awaits, so the async fs never leaks into the sync
    // engine), so we track each write here and expose a drain: a graceful stop
    // flushes then waits for these to land before the realm is torn down.
    const pendingWrites = new Set<Promise<unknown>>();
    const track = <T>(p: Promise<T>): Promise<T> => {
        pendingWrites.add(p);
        void p.catch(() => {}).finally(() => pendingWrites.delete(p));
        return p;
    };
    const drainWrites = async (): Promise<void> => {
        while (pendingWrites.size > 0) await Promise.allSettled([...pendingWrites]);
    };

    // the engine issues scene persists (edit mode) via fs.write/remove and reads
    // scenes + baked resources + the local player's avatar (a file:// edited glb in
    // OPFS or an http account avatar, both resolved by the engine's loader) via
    // fs.read. Wrap write/remove so a graceful stop can drain in-flight OPFS writes
    // before teardown; reads pass through. (Cross-origin http avatar fetches need
    // CORS on the avatar CDN under the realm's COEP.)
    // delegate explicitly — NOT `{ ...fs }`, which drops the concrete fs's prototype
    // methods (list/read live on the class, not as own props). The engine uses only
    // read/list/write/remove; wrap write/remove so stop() drains in-flight OPFS writes.
    const trackedFs: ServerFilesystem = {
        read: (path) => fs.read(path),
        list: (dir, opts) => fs.list(dir, opts),
        write: (path, data) => track(fs.write(path, data)),
        remove: (path) => track(fs.remove(path)),
    };

    // the engine's example avatars (shipped in the package, seeded into the vfs).
    // Held so the avatar picker below can pre-fetch its sample pool.
    const avatars = createEditorAvatarsDriver();

    const state = EngineServer.init({
        mode: 'edit',
        fs: trackedFs,
        zstd: { compress: zstdCompress },
        options: {},
        driver: {
            storage: opts.storage,
            avatars,
        },
    });

    // register the editor's server commands BEFORE load (mirrors the client's
    // EngineClientEditor.setup) so they're in the registry when load builds the
    // derived indexes.
    await EngineServerEditor.setup(state);
    await EngineServer.load(state);
    log('server loaded');

    // watch the registry: re-apply on each settled flush (the realm's runner
    // flushes after evaluating user code / an HMR cascade; this updates the live
    // world in place) plus an initial apply.
    const unregister = EngineServerEditor.watchRegistry(state);

    // ServerApp adapter — the transport (transport-server.ts) drives the engine
    // through this exactly like game-room/edit-server drive it through the WS
    // transport. getInbox/getOutbox expose the per-Client frame maps.
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
        stop: async () => {
            unregister();
            // dispose runs the final flushDirty, which enqueues the last save via
            // the engine's (fire-and-forget) fs.write persist — trackedFs captured
            // those, so drain now waits for the bytes to actually reach OPFS before we
            // let the realm die and a fresh one reload from disk.
            EngineServer.dispose(state);
            await drainWrites();
        },
    };
}
