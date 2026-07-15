// editor/main.tsx — standalone entry. Mounts the editor (window manager) and
// wires the project session: engine externals (workspace source here; a CDN
// dist in the deployed website), the bundler, and flush→bake.

import { Code, Files, Hammer, MonitorPlay, Server } from 'bongle/icons';
import { createRoot } from 'react-dom/client';
import './editor.css';
import starterBbmodel from '../bongle-blockbench/starter/character.bbmodel?raw';
import { createClientHost } from './client/client-host';
import { exposeDevtools } from './devtools';
import { seedEngineDist } from './engine-dist';
import { PROJECT_NAME } from './project';
import { initEditor } from './entry';
import type { FsChange } from './fs';
import { openOpfsFilesystem } from './fs-opfs';
import { importGameSave } from './game-save';
import { joinGuestSession } from './net/guest-session';
import { spawnPipelineWorker } from './pipeline/pipeline-host';
import { createPlatformBridge } from './platform/bridge';
import { spawnServerWorker } from './server/server-host';
import { useBuildMeta } from './stores/build-meta';
import { useClients } from './stores/clients';
import { MAIN_PANE, useEditor } from './stores/editor';
import { useLaunched } from './stores/launched';
import { useMultiplayer } from './stores/multiplayer';
import { logger } from './stores/logs';
import { usePlatform } from './stores/platform';
import { useSystemWindows } from './stores/system-windows';
import { useWindows } from './stores/windows';
import { blockbenchApp, openPath } from './ui/apps';
import { CodePane } from './ui/components/CodePane';
import { Desktop, type WindowDef } from './ui/components/Desktop';
import { FileTree } from './ui/components/FileTree';
import { LogView } from './ui/components/LogView';
import { loadEngineTypes, syncProjectModels } from './ui/components/Monaco';
import { PLATFORM_WINDOW_ID } from './ui/components/PlatformWindow';
import { TASKBAR_W } from './ui/components/Taskbar';

// the working copy is OPFS — shared across the main doc, server worker, and
// client iframes (same origin), so realms open it directly instead of syncing a
// snapshot. Top-level await: the whole editor waits on the fs.
const PROJECT = PROJECT_NAME;
const fs = await openOpfsFilesystem(PROJECT);
const editor = initEditor({ fs });
// the 'build' log window shows both bundler (transform) errors and bake output.
const log = logger('build');

const SAMPLE_INDEX = `import { block, blockTexture, draw } from 'bongle';

const solid = (id: string, r: number, g: number, b: number) => {
    const tex = blockTexture(id, {
        src: draw(
            (c, _inputs, params) => {
                const p = params.rgb as number;
                c.fillStyle = \`rgb(\${(p >> 16) & 0xff}, \${(p >> 8) & 0xff}, \${p & 0xff})\`;
                c.fillRect(0, 0, 16, 16);
                c.fillStyle = 'rgba(0,0,0,0.25)';
                c.fillRect(0, 0, 16, 1);
                c.fillRect(0, 15, 16, 1);
            },
            { size: [16, 16], params: { rgb: (r << 16) | (g << 8) | b } },
        ),
    });
    return block(id, { model: () => ({ type: 'cube', textures: { all: { texture: tex } } }) });
};

solid('dev:red', 220, 60, 60);
solid('dev:green', 60, 200, 90);
solid('dev:blue', 70, 110, 230);
`;

async function boot(): Promise<void> {
    // what the embedding platform wants this session to do (null = standalone dev).
    const platform = createPlatformBridge();
    const intent = await platform.ready;
    usePlatform.getState().init(platform, intent);
    platform.onResult((r) => {
        usePlatform.getState().setResult(r);
        log(`platform ${r.of}: ${r.ok ? 'ok' : 'failed'}${r.message ? ` — ${r.message}` : ''}`);
    });

    // GUEST: joining someone else's session. Run ONLY a client iframe pointed at
    // the host over the relay — no server/bundler/pipeline workers, no local
    // project. The full-viewport client covers the (unused) desktop underneath.
    if (intent?.kind === 'joinEdit') {
        const guestLog = logger('client');
        log('joining a multiplayer edit session…');
        joinGuestSession({
            url: intent.url,
            clientPath: `${import.meta.env.BASE_URL}client/index.html`,
            log: (m) => guestLog(`[guest] ${m}`),
        });
        return; // skip the host stack entirely
    }

    // the avatar the local player wears in the running editor session (see
    // startEditorServer). avatar mode = the edited glb; game mode = our account
    // avatar; standalone = a random sample.
    let localAvatarUrl: string | undefined;

    // avatar intent: open the model in Blockbench AND run the game session so the
    // edited avatar previews live on the player. (Runs the full editor — it no
    // longer skips the realms.)
    if (intent?.kind === 'avatar') {
        if (intent.bbmodel) {
            await editor.fs.write('avatar.bbmodel', intent.bbmodel);
            openPath('avatar.bbmodel', MAIN_PANE); // launches blockbench AND opens the file in it
        } else {
            useLaunched.getState().launch(blockbenchApp, ''); // new avatar → blank Blockbench
        }
        // the "Save avatar" action lives in the in-editor platform window now
        // (editor-initiated — see ui/components/PlatformWindow).
        // wear the edited avatar (avatar.glb, written by Blockbench on save). Set
        // unconditionally: if the glb isn't there yet the engine shows a placeholder
        // rig, and the first save fires an fs-change → server.reloadAvatar swaps in
        // the compiled glb live (no re-join).
        localAvatarUrl = 'file:///avatar.glb';
    } else if (intent?.kind === 'game') {
        // a platform-supplied save replaces the project source before boot.
        if (intent.save) await importGameSave(editor.fs, intent.save);
        localAvatarUrl = intent.avatarUrl; // play/edit the game as ourselves
    }

    // OPFS is the persistent source of truth: seed the starter project ONLY on a
    // fresh project (no src/index.ts), so edits + loaded game saves survive a
    // reload instead of being clobbered by the sample every boot.
    if (!(await editor.fs.exists('src/index.ts'))) {
        // project metadata lives under a `bongle` key in package.json (idiomatic
        // npm-project home; a placeholder for name/engineVersion/etc. as we settle
        // what the build + platform actually need). Rides the game save as source.
        await editor.fs.write(
            'package.json',
            `${JSON.stringify({ name: 'dev-sample', private: true, bongle: { engineVersion: '0.0.0' } }, null, 2)}\n`,
        );
        await editor.fs.write('src/index.ts', SAMPLE_INDEX);
        // a starter avatar source, openable in the blockbench app from the file tree.
        await editor.fs.write('character.bbmodel', starterBbmodel);
    }
    // empty barrel so realms can import it before the first bake writes it (the
    // bake patches model/… handles with baked bin paths, mirroring the kit). Not
    // part of a game save (derived) — ensure it exists on every boot.
    if (!(await editor.fs.exists('src/generated/models.ts'))) {
        await editor.fs.write('src/generated/models.ts', 'export {};\n');
    }
    useEditor.getState().open(MAIN_PANE, 'src/index.ts'); // open it in the code window

    // seed the engine + first-party libs into the vfs so every realm's bundler
    // resolves `bongle` / `mathcat` / … from there.
    await seedEngineDist(editor.fs);

    // feed the seeded .d.ts into Monaco's TS worker (types/intellisense for user
    // code). Fire-and-forget — the code window may not be open yet, but the
    // typescript defaults are global, so it applies whenever an editor mounts.
    void loadEngineTypes(editor.fs);
    // model every src file (not just open tabs) so the TS worker resolves across
    // files — cross-file go-to-definition, find-references, project-wide types.
    void syncProjectModels(editor.fs);

    // the ONE dev server — DevServer + @rolldown transform — runs OFF the main
    // thread in the bundler worker (its WASM arena reaches multiple GB under
    // load). Every realm connects to it over a transferred MessagePort; the main
    // doc only brokers the connection + relays fs edits.
    const bundlerWorker = new Worker(new URL('./bundler/bundler-worker.ts', import.meta.url), { type: 'module' });
    bundlerWorker.onerror = (e) => console.error('[bundler-worker] load error', e.message);
    // messages posted to the worker before it's live get lost in vite's dep-
    // optimize/reload window, so we handshake: init on `worker-ready`, and queue
    // realm connections until `host-ready`, then flush them.
    let bundlerReady = false;
    const pendingConnects: Array<{ env: string; port: MessagePort }> = [];
    const connectRealm = (env: string, port: MessagePort) => {
        if (bundlerReady) bundlerWorker.postMessage({ type: 'connect-realm', env }, [port]);
        else pendingConnects.push({ env, port });
    };
    bundlerWorker.onmessage = (e: MessageEvent) => {
        const d = e.data as { __buildlog?: string; type?: string };
        if (d?.type === 'worker-ready') bundlerWorker.postMessage({ type: 'init', projectName: PROJECT });
        else if (d?.type === 'host-ready') {
            bundlerReady = true;
            for (const { env, port } of pendingConnects) bundlerWorker.postMessage({ type: 'connect-realm', env }, [port]);
            pendingConnects.length = 0;
        }
        // the worker reports transform / resolution failures back here → build log.
        else if (d?.__buildlog) log(d.__buildlog);
    };

    // pipeline realm — its own worker (bakes stay off the UI thread). Baked
    // outputs land in the shared OPFS for the client renderer; its log joins the
    // build stream.
    // relay the pipeline's bake writes to the realms (OPFS has no cross-context
    // events). Wired below once server/client exist — the FIRST bake fires during
    // `await pipelineHost.ready`, before they're spawned, and its outputs reach
    // the realms via their fresh barrel import at boot, so a no-op then is right.
    let relayBakeChange: (changes: FsChange[]) => void = () => {};
    const pipelineHost = spawnPipelineWorker({
        connectRealm,
        projectName: PROJECT,
        log,
        onFsChanged: (changes) => relayBakeChange(changes),
        // the prod build reads maxPlayers here (it can't evaluate user code itself).
        onMatchmaking: (maxPlayers) => useBuildMeta.getState().setMaxPlayers(maxPlayers),
    });
    // bake-then-run (mirrors the kit): wait for the first bake so every realm
    // fresh-imports the REAL generated barrel (baked model bin paths) at boot,
    // rather than racing an empty→real HMR that worker realms can't apply cleanly.
    await pipelineHost.ready;

    // the server, off-thread in its own realm (own registry). It opens the SAME
    // OPFS project directly — no snapshot.
    const serverLog = logger('server');
    const serverHost = spawnServerWorker({ connectRealm, projectName: PROJECT, log: serverLog, localAvatarUrl });

    // multiplayer editing (opt-in): wire the host subsystems so the "Open to
    // multiplayer" action can dial the relay and accept guests. Nothing connects
    // until the host presses the button.
    useMultiplayer.getState().init({ platform, serverHost, connectRealm, fs: editor.fs, log: (m) => serverLog(`[mp] ${m}`) });

    // client iframes: each its own realm, connected to the server worker; the
    // "+ client" button opens more (multiplayer-in-a-tab). They open OPFS too.
    const clientLog = logger('client');
    const clientHost = createClientHost({
        serverHost,
        connectRealm,
        projectName: PROJECT,
        log: (id, m) => clientLog(`[${id}] ${m}`),
    });
    useClients.getState().setHost(clientHost);
    log('realms booting — edit src/index.ts then ⌘/ctrl+S to hot-reload.');

    // DevTools automation surface: `bongle` in the editor console. fs + thin
    // vfs aliases for terse pasteable snippets, plus the realm hosts + UI stores.
    exposeDevtools('editor', {
        fs: editor.fs,
        ls: (dir = '') => editor.fs.list(dir, { recursive: true }),
        cat: (path: string) => editor.fs.readText(path),
        write: (path: string, data: string | Uint8Array) => editor.fs.write(path, data),
        rm: (path: string, recursive = false) => editor.fs.remove(path, { recursive }),
        hosts: { pipeline: pipelineHost, server: serverHost, client: clientHost, bundler: bundlerWorker },
        stores: { editor: useEditor, windows: useWindows, clients: useClients, systemWindows: useSystemWindows },
    });

    // fan a batch of fs changes out to the realms: the bundler re-transforms +
    // HMRs source/barrels; server/client re-read baked resources. Drives BOTH
    // main-doc edits (editor.fs.watch) and the pipeline's bake writes (relayed).
    const fanOutChange = (changes: FsChange[]) => {
        bundlerWorker.postMessage({ type: 'fs-change', changes });
        for (const c of changes) {
            if (c.type === 'deleted') continue;
            serverHost.relayFsChange(c.path);
            clientHost.relayFsChange(c.path);
        }
    };
    relayBakeChange = fanOutChange;
    editor.fs.watch(fanOutChange);

    // once the server is live (join before the sim exists would be dropped), lay
    // out the session. game/standalone opens a client that fills the screen.
    // avatar mode is Blockbench-only to start (no game preview) — center Blockbench
    // (~70%) with the platform widget kept visible top-right; open a client later
    // via the "+ client" button to preview the avatar on a player.
    void serverHost.ready.then(() => {
        const W = useWindows.getState();
        if (intent?.kind === 'avatar') {
            const deskW = window.innerWidth - TASKBAR_W;
            const w = Math.round(deskW * 0.7);
            const h = Math.round(window.innerHeight * 0.7);
            W.setBox('blockbench', TASKBAR_W + Math.round((deskW - w) / 2), Math.round((window.innerHeight - h) / 2), w, h);
            W.focus('blockbench');
            W.focus(PLATFORM_WINDOW_ID); // keep the platform widget on top / visible
            return;
        }
        const id = useClients.getState().open();
        if (id) W.snapTo(id, 'full');
    });
}

// the bottom log-window row (build + server), anchored to the viewport bottom
// with a small gap; falls back to y=24 on a very short viewport.
const BOTTOM_ROW_H = 190;
const BOTTOM_ROW_Y = Math.max(24, window.innerHeight - BOTTOM_ROW_H - 12);

const windows: WindowDef[] = [
    {
        id: 'files',
        title: 'files',
        glyph: <Files size={18} />,
        initial: { x: 60, y: 24, w: 220, h: 320 },
        content: <FileTree fs={editor.fs} pane={MAIN_PANE} />,
    },
    {
        id: 'code',
        title: 'code',
        glyph: <Code size={18} />,
        initial: { x: 300, y: 24, w: 1240, h: 920 },
        content: <CodePane fs={editor.fs} pane={MAIN_PANE} />,
    },
    // build + server + client are matching log windows, sat next to each other
    // in a row along the bottom-left (build flush to the left edge, under the
    // file tree). The row is anchored to the viewport bottom so it lands on-screen
    // at any height.
    {
        id: 'build',
        title: 'build logs',
        glyph: <Hammer size={18} />,
        initial: { x: 60, y: BOTTOM_ROW_Y, w: 310, h: BOTTOM_ROW_H },
        content: <LogView stream="build" />,
    },
    {
        id: 'server',
        title: 'server logs',
        glyph: <Server size={18} />,
        initial: { x: 380, y: BOTTOM_ROW_Y, w: 310, h: BOTTOM_ROW_H },
        content: <LogView stream="server" />,
    },
    {
        id: 'client',
        title: 'client logs',
        glyph: <MonitorPlay size={18} />,
        initial: { x: 700, y: BOTTOM_ROW_Y, w: 310, h: BOTTOM_ROW_H },
        content: <LogView stream="client" />,
    },
    // client windows are dynamic (opened by the "+ client" button, one iframe
    // realm each) — see stores/clients + Desktop.
];

// default layout: boot straight into the game client (snapped full once the
// server is live). Every fixed panel starts closed — reopen from the taskbar.
for (const w of windows) useSystemWindows.getState().close(w.id);

// keep the browser from zooming the whole page — the desktop is a fixed-scale
// surface, and apps (e.g. the paint canvas) own their own zoom. Blocks trackpad
// pinch / ctrl+wheel, Safari gesture zoom, and ⌘/ctrl +/-/0.
window.addEventListener(
    'wheel',
    (e) => {
        if (e.ctrlKey || e.metaKey) e.preventDefault();
    },
    { passive: false },
);
window.addEventListener('gesturestart', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['=', '-', '+', '0'].includes(e.key)) e.preventDefault();
});

createRoot(document.getElementById('root')!).render(<Desktop windows={windows} fs={editor.fs} />);
void boot();
