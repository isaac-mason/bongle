import { RIG_TYPE_6BONE } from 'bongle/avatar';
import type { ResolvedAvatar, ServerDriver } from 'bongle/interface';
import { initZstd, zstdCompress } from 'bongle/zstd-wasm';
import { avatarPicker, closeClients, createClientTable, joinClient } from '../../build/dev/host';
import { bootMarks } from '../boot-marks';
import { exposeDevtools } from '../devtools';
import type { App, AppInit } from '../interface';
import { importEngine } from './engine';

// The server app: the edit server inside its realm. Waits for the bake, boots
// EngineServer through the runner, runs the 60Hz sim, and serves "game": each
// connection is one client in the client table (build/dev/host.ts), which drives
// the engine's own ServerApp exactly like the play room drives it over WS. Several
// windows are several clients on the one server: multiplayer-in-a-tab. Scene edits
// land on disk through the editor; the stop drains them (awaited) so the OS holds
// teardown until the bytes are in OPFS.
//
// Engine RUNTIME is reached only via the runner (engine.ts); statics are leaf
// utilities bundled at engine build.

type EngineServerModule = typeof import('bongle/engine-server');
type EngineServerEditorApi = typeof import('bongle/engine-server-editor');

// The editor server's `ServerDriver.avatars`, the artifact counterpart to the node
// sample-avatars driver. The engine's example avatars ship raw in the package
// (avatars/), so in the editor they sit in the project vfs at
// node_modules/bongle/avatars/ (seeded), referenced as `file://` URLs both engine
// loaders resolve through the project fs. Same runtime-avatar path as prod: plain
// `.glb`, fetched + gltfUnpack'd. Excludes `base` (the builtin fallback, not a
// sample to dress NPCs in).
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

const toU8 = (frame: unknown): Uint8Array => (frame instanceof ArrayBuffer ? new Uint8Array(frame) : (frame as Uint8Array));

const server: App<AppInit> = async (env) => {
    const cfg = env.init;
    const { fs, runner } = env;
    const mark = bootMarks('server');
    mark('realm up');

    // Everything that needs no bake output loads while the pipeline bakes: the
    // engine, the user entry (a project that imports its generated barrel gets the
    // empty one the shell seeds, and the bake's rewrite reaches it through HMR like
    // any other edit). Importing bongle/engine-server-editor registers the editor's
    // server declarations; `load` builds the derived indexes over them.
    env.progress('loading');
    await importEngine(runner, 'server', cfg.entry ?? 'src/index.ts');
    const { EngineServer, createInMemoryStorageDriver } = (await runner.import('bongle/engine-server')) as EngineServerModule;
    const EngineServerEditor = (await runner.import('bongle/engine-server-editor')) as EngineServerEditorApi;
    mark('engine + user entry imported');

    // the pipeline serves once its first bake is done: from here on src/generated/*
    // and resources/server/* are the real ones.
    env.progress('waiting for bake');
    await env.served('pipeline');
    mark('bake ready');
    env.progress('starting');
    await runner.import('src/generated/models.ts');

    // zstd compressor for the voxel wire codec (client decodes with fzstd).
    await initZstd();

    // the engine reads scenes + baked resources + the local player's avatar (a
    // file:// edited glb in OPFS or an http account avatar) via fs.read; the editor
    // writes scene files through the same handle. `fs` passes straight through.
    // (Cross-origin http avatar fetches need CORS on the avatar CDN under the
    // realm's COEP.) The client table exists before the engine: the engine's
    // `send` closes over it.
    const avatars = createEditorAvatarsDriver();
    const clients = createClientTable();
    const state = EngineServer.init({
        mode: 'edit',
        fs,
        zstd: { compress: zstdCompress },
        options: {},
        driver: { storage: createInMemoryStorageDriver(), avatars },
        send: clients.send,
    });
    await EngineServer.load(state);
    env.log('server loaded');
    // re-apply on each settled flush (the realm's runner flushes after evaluating
    // user code / an HMR cascade; this updates the live world in place).
    const unwatch = EngineServer.watchRegistry(state);
    mark('server started');

    // a platform-supplied avatar (the edited avatar / our account avatar) overrides
    // the random sample so the local player wears it.
    const picker = await avatarPicker(avatars, { local: cfg.avatarUrl });
    const app = EngineServer.app('edit');
    exposeDevtools('server', { fs, server: EngineServer, state, app, editor: EngineServerEditor });

    app.start(state);

    // graceful shutdown: dispose (stops the loop; the rooms'
    // leave hooks flush the last edits), then wait for those bytes to reach OPFS
    // before the realm dies and a fresh one reloads from disk. AWAITED, so the OS
    // holds teardown until the writes land.
    env.onDispose(async () => {
        // dispose stops the loop and runs the rooms' leave hooks; everything after it
        // would otherwise be racing a live tick against a closed client table.
        await EngineServer.dispose(state);
        closeClients(clients);
        unwatch();
        await EngineServerEditor.drainWrites();
    });

    // live avatar preview: the edited glb was rewritten (a Blockbench save) at the
    // SAME url, so mint a fresh modelId and re-stamp every connected client; the
    // CharacterTrait reconciler unmounts the old rig and mounts the new one, no
    // re-join. New joins pick up the fresh id too.
    env.fs.watch((changes) => {
        if (!changes.some((c) => c.path === 'avatar.glb')) return;
        const avatar = picker.reload();
        if (!avatar) return;
        for (const client of state.clients.connected.keys()) EngineServer.reloadClientAvatar(state, client, avatar);
        env.log(`avatar reloaded: ${avatar.modelId}`);
    });

    // clients join over "game". The account identity lives on the CLIENT (its
    // driver); the server sees the meta's user when the dialer carries one (a
    // relay guest) and a synthesized dev meta otherwise.
    mark('game served');
    env.listen('game', (conn, meta) => {
        const user = meta.user ?? { id: `dev-${meta.pid}`, username: `guest-${meta.pid}` };
        const member = joinClient(clients, app, state, conn, user, {}, picker.resolve());
        if (!member) return;
        // the channel's `closed` is the leave signal. a channel closed by the shutdown
        // above is already out of the table, so that fires no leave.
        void conn.closed.then(member.leave);
        env.log(`client ${member.clientId} joined`);
        return (frame) => member.receive(toU8(frame));
    });

    env.log('game server up; listening on "game"');
    env.progress('ready');
};

export default server;
