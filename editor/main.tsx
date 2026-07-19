// editor/main.tsx — standalone entry. Mounts the editor (window manager) and
// wires the project session: engine externals (workspace source here; a CDN
// dist in the deployed website), the bundler, and flush→bake.

import { Code, Files, Hammer, MonitorPlay, Server } from 'bongle/icons';
import { createRoot } from 'react-dom/client';
import './editor.css';
import { createBootTimer } from './boot-timing';
import { createClientHost } from './realms/client/client-host';
import { exposeDevtools } from './devtools';
import { seedEngineDist } from './engine-dist';
import { initEditor } from './entry';
import type { FsChange } from './fs';
import { openOpfsFilesystem } from './fs-opfs';
import { importProjectSave } from './project-save';
import { joinGuestSession } from './net/guest-session';
import { spawnPipelineWorker } from './realms/pipeline/pipeline-host';
import { initAutosave } from './platform/autosave';
import { createPlatformBridge } from './platform/bridge';
import { PROJECT_NAME } from './project';
import { registerProjectFsWorker } from './project-url';
import { spawnServerWorker } from './realms/server/server-host';
import { useBoot } from './stores/boot';
import { useBuildMeta } from './stores/build-meta';
import { useClients } from './stores/clients';
import { MAIN_PANE, useEditor } from './stores/editor';
import { logger } from './stores/logs';
import { useMultiplayer } from './stores/multiplayer';
import { usePlatform } from './stores/platform';
import { useSystemWindows } from './stores/system-windows';
import { useWindows } from './stores/windows';
import { openPath } from './ui/apps';
import { CodePane } from './ui/components/CodePane';
import { BootScreen } from './ui/components/BootScreen';
import { Desktop, type WindowDef } from './ui/components/Desktop';
import { FileTree } from './ui/components/FileTree';
import { LogView } from './ui/components/LogView';
import { loadEngineTypes, syncProjectModels } from './ui/components/Monaco';
import { PLATFORM_WINDOW_ID } from './ui/components/PlatformWindow';
import { TASKBAR_W } from './ui/components/Taskbar';

// the starter humanoid seeded for a NEW avatar (no platform-supplied source) so
// Blockbench opens on an editable character rig, not an empty scene. `?raw`
// inlines the .bbmodel JSON into the editor bundle.
import starterCharacterBbmodel from '../blockbench/starter/character.bbmodel?raw';

// the working copy is OPFS — shared across the main doc, server worker, and
// client iframes (same origin), so realms open it directly instead of syncing a
// snapshot. Top-level await: the whole editor waits on the fs.
// serves the OPFS working copy at <base>@project/… for <img>/?url/new URL.
registerProjectFsWorker();

// boot instrumentation — 'start' anchors at this module's eval; every bootLog
// step below is a timed phase boundary. See boot-timing.ts.
const bootTimer = createBootTimer('main');

const PROJECT = PROJECT_NAME;
const fs = await openOpfsFilesystem(PROJECT);
bootTimer.mark('opfs open');
const editor = initEditor({ fs });
// the 'build' log window shows both bundler (transform) errors and bake output.
const log = logger('build');

const SAMPLE_INDEX = `import { system, onJoin, setPosition, blockTopCenter, use, getTrait, TransformTrait, setEnvironment, ENVIRONMENT_OVERWORLD } from 'bongle';
import { blocks } from 'bongle/kit';
import { vec3 } from 'mathcat';

use(blocks);

const SPAWN = blockTopCenter(vec3.create(), 0, 5, 0);

system('environment', (ctx) => {
    setEnvironment(ctx, ENVIRONMENT_OVERWORLD);
}, { editor: true });

system('setup', (ctx) => {
    onJoin(ctx, (e) => {
        const transform = getTrait(e.playerNode, TransformTrait)!;
        setPosition(transform, SPAWN);
    });
});
`;

// boot progress → both the console (with +delta/total timing) and the BootScreen
// terminal log (each step shows its own delta).
const bootLog = (msg: string): void => {
    const delta = bootTimer.mark(msg);
    useBoot.getState().log(`${msg}  ${delta}`);
};

async function boot(): Promise<void> {
    bootLog('booting dev environment…');
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
        bootLog('joining a multiplayer edit session…');
        joinGuestSession({
            url: intent.url,
            clientPath: `${import.meta.env.BASE_URL}realms/client/index.html`,
            log: (m) => guestLog(`[guest] ${m}`),
        });
        useBoot.getState().setReady(); // guest client covers the viewport itself
        bootTimer.summary();
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
        // seed the model to edit: a platform-supplied source (edit an owned avatar
        // or remix another's), or — for a brand-new avatar — the starter character
        // rig so Blockbench opens on an editable humanoid rather than an empty scene.
        await editor.fs.write('avatar.bbmodel', intent.bbmodel ?? starterCharacterBbmodel);
        openPath('avatar.bbmodel', MAIN_PANE); // launches blockbench AND opens the file in it
        // the "Save avatar" action lives in the in-editor platform window now
        // (editor-initiated — see ui/components/PlatformWindow).
        // wear the edited avatar (avatar.glb, written by Blockbench on save). Set
        // unconditionally: if the glb isn't there yet the engine shows a placeholder
        // rig, and the first save fires an fs-change → server.reloadAvatar swaps in
        // the compiled glb live (no re-join).
        localAvatarUrl = 'file:///avatar.glb';
    } else if (intent?.kind === 'project') {
        // a platform-supplied save replaces the project source before boot.
        if (intent.save) await importProjectSave(editor.fs, intent.save);
        localAvatarUrl = intent.avatarUrl; // play/edit the project as ourselves
    }

    // OPFS is the persistent source of truth: seed the starter project ONLY on a
    // fresh project (no src/index.ts), so edits + loaded project saves survive a
    // reload instead of being clobbered by the sample every boot.
    if (!(await editor.fs.exists('src/index.ts'))) {
        // project metadata lives under a `bongle` key in package.json (idiomatic
        // npm-project home; a placeholder for name/engineVersion/etc. as we settle
        // what the build + platform actually need). Rides the project save as source.
        await editor.fs.write(
            'package.json',
            `${JSON.stringify({ name: 'dev-sample', private: true, bongle: { engineVersion: '0.0.0' } }, null, 2)}\n`,
        );
        await editor.fs.write('src/index.ts', SAMPLE_INDEX);
    }
    // empty barrel so realms can import it before the first bake writes it (the
    // bake patches model/… handles with baked bin paths, mirroring the build). Not
    // part of a project save (derived), ensure it exists on every boot.
    if (!(await editor.fs.exists('src/generated/models.ts'))) {
        await editor.fs.write('src/generated/models.ts', 'export {};\n');
    }
    useEditor.getState().open(MAIN_PANE, 'src/index.ts'); // open it in the code window

    // seed the engine + first-party libs into the vfs so every realm's bundler
    // resolves `bongle` / `mathcat` / … from there. Kick it off but DON'T block
    // yet: the bundler worker's heavy @rolldown WASM compile (below) can run
    // concurrently, and only the pipeline's first transform actually reads
    // node_modules. We await the seed just before spawning the pipeline.
    bootLog('seeding engine…');
    const seedStart = performance.now();
    const seedDone = seedEngineDist(editor.fs).then(() => {
        console.log(`[boot:main] seedEngineDist ${(performance.now() - seedStart).toFixed(0)}ms`);
        bootLog('engine ready');
    });

    // the ONE dev server — DevServer + @rolldown transform — runs OFF the main
    // thread in the bundler worker (its WASM arena reaches multiple GB under
    // load). Every realm connects to it over a transferred MessagePort; the main
    // doc only brokers the connection + relays fs edits. Spawned NOW (before the
    // seed resolves) so its WASM compile overlaps the seed writes.
    const bundlerWorker = new Worker(new URL('./dev/bundler-worker.ts', import.meta.url), { type: 'module' });
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
    bootLog('starting bundler…');
    bundlerWorker.onmessage = (e: MessageEvent) => {
        const d = e.data as { __buildlog?: string; type?: string };
        if (d?.type === 'worker-ready') {
            bundlerWorker.postMessage({ type: 'init', projectName: PROJECT });
        } else if (d?.type === 'host-ready') {
            bootLog('bundler ready');
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

    // the pipeline realm is the first to request transforms (its engine-graph
    // import resolves `bongle` from the seeded node_modules), so the seed MUST be
    // complete before it spawns. This is where the overlap collapses back: by now
    // the bundler's WASM compile has been running alongside the seed.
    await seedDone;
    // feed the seeded .d.ts into Monaco's TS worker (types/intellisense for user
    // code) + model every src file for cross-file resolution. Fire-and-forget —
    // the code window may not be open yet, but the TS defaults are global.
    void loadEngineTypes(editor.fs);
    void syncProjectModels(editor.fs);

    bootLog('baking assets…');
    const pipelineHost = spawnPipelineWorker({
        connectRealm,
        projectName: PROJECT,
        log,
        onFsChanged: (changes) => relayBakeChange(changes),
        // the prod build reads maxPlayers here (it can't evaluate user code itself).
        onMatchmaking: (maxPlayers) => useBuildMeta.getState().setMaxPlayers(maxPlayers),
    });
    // bake-then-run (mirrors the build): wait for the first bake so every realm
    // fresh-imports the REAL generated barrel (baked model bin paths) at boot,
    // rather than racing an empty→real HMR that worker realms can't apply cleanly.
    await pipelineHost.ready;
    bootLog('assets baked');
    bootLog('starting server…');

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

    // autosave: genuine edits (this same fs change stream) arm a throttled
    // `bongle:draft` hand-back. Wired AFTER load/seed so those writes never
    // arm it. No-op when standalone or non-project.
    initAutosave(editor.fs, platform, intent);

    // once the server is live (join before the sim exists would be dropped), lay
    // out the session. game/standalone opens a client that fills the screen.
    // avatar mode is Blockbench-only to start (no game preview) — center Blockbench
    // (~70%) with the platform widget kept visible top-right; open a client later
    // via the "+ client" button to preview the avatar on a player.
    void serverHost.ready.then(() => {
        bootLog('server ready');
        const W = useWindows.getState();
        if (intent?.kind === 'avatar') {
            const deskW = window.innerWidth - TASKBAR_W;
            const w = Math.round(deskW * 0.7);
            const h = Math.round(window.innerHeight * 0.7);
            W.setBox('blockbench', TASKBAR_W + Math.round((deskW - w) / 2), Math.round((window.innerHeight - h) / 2), w, h);
            W.focus('blockbench');
            W.focus(PLATFORM_WINDOW_ID); // keep the platform widget on top / visible
            useBoot.getState().setReady();
            bootTimer.summary();
            return;
        }
        bootLog('opening client…');
        const id = useClients.getState().open();
        if (id) W.snapTo(id, 'full');
        useBoot.getState().setReady();
        bootTimer.summary();
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

createRoot(document.getElementById('root')!).render(
    <>
        <Desktop windows={windows} fs={editor.fs} />
        <BootScreen />
    </>,
);
void boot();
