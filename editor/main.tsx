// editor/main.tsx — standalone entry. Mounts the editor (window manager) and
// wires the project session: engine externals (workspace source here; a CDN
// dist in the deployed website), the bundler, and flush→bake.

import { createRoot } from 'react-dom/client';
import { Code, Files, Hammer, MonitorPlay, Server } from '../icons';
import './editor.css';

// the starter humanoid seeded for a NEW avatar (no platform-supplied source) so
// Blockbench opens on an editable character rig, not an empty scene. `?raw`
// inlines the .bbmodel JSON into the editor bundle.
import starterCharacterBbmodel from '../blockbench/starter/character.bbmodel?raw';
import { useSession } from './backend';
import { createBootTimer } from './boot-timing';
import { exposeDevtools } from './devtools';
import { seedEngineDist } from './engine-dist';
import { initEditor } from './entry';
import type { Filesystem, FsChange } from './fs';
import { openProjectFilesystem } from './fs-open';
import { createGuestSession } from './net/guest-session';
import { runSave, saveAvatar } from './platform/actions';
import { initAutosave } from './platform/autosave';
import { createPlatformBridge } from './platform/bridge';
import { PROJECT_NAME } from './project';
import { importProjectSave } from './project-save';
import { registerProjectFsWorker } from './project-url';
import { createClientHost, localConnector } from './realms/client/client-host';
import { spawnPipelineWorker } from './realms/pipeline/pipeline-host';
import { createServerManager } from './realms/server/server-manager';
import { connectViaPort } from './sync/folder-sync';
import { useBoot } from './stores/boot';
import { useBuildMeta } from './stores/build-meta';
import { useClients } from './stores/clients';
import { MAIN_PANE, useEditor } from './stores/editor';
import { useLaunched } from './stores/launched';
import { logger } from './stores/logs';
import { useMultiplayer } from './stores/multiplayer';
import { usePlatform } from './stores/platform';
import { useServer } from './stores/server';
import { useSync } from './stores/sync';
import { useSystemWindows } from './stores/system-windows';
import { useWindows } from './stores/windows';
import { blockbenchApp, openPath } from './ui/apps';
import { BootScreen } from './ui/components/BootScreen';
import { CodePane } from './ui/components/CodePane';
import { Desktop, type WindowDef } from './ui/components/Desktop';
import { FileTree } from './ui/components/FileTree';
import { LogView } from './ui/components/LogView';
import { loadEngineTypes, syncProjectModels } from './ui/components/Monaco';
import { PLATFORM_WINDOW_ID } from './ui/components/PlatformWindow';
import { ServerPanel } from './ui/components/ServerPanel';
import { TASKBAR_W } from './ui/components/Taskbar';

// the working copy is OPFS — shared across the main doc, server worker, and
// client iframes (same origin), so realms open it directly instead of syncing a
// snapshot. Top-level await: the whole editor waits on the fs.
// serves the OPFS working copy at <base>@project/… for <img>/?url/new URL.
registerProjectFsWorker();

// boot instrumentation — 'start' anchors at this module's eval; every bootLog
// step below is a timed phase boundary. See boot-timing.ts.
const bootTimer = createBootTimer('main');

const PROJECT = PROJECT_NAME;
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

// Seeded so a folder-sync'd copy on disk is git-ready. The mirror includes
// node_modules (engine seed) + resources (bake output) so external tooling resolves,
// but those are derived — git shouldn't track them. Display-ignored + save-excluded
// (see ignored.ts / project-save.ts), but folder-sync mirrors it like any managed file.
const GITIGNORE = 'node_modules\nresources\ndist\n';

// boot progress → both the console (with +delta/total timing) and the BootScreen
// terminal log (each step shows its own delta).
const bootLog = (msg: string): void => {
    const delta = bootTimer.mark(msg);
    useBoot.getState().log(`${msg}  ${delta}`);
};

// ── Phase 0 — start every boot long-pole at t=0 ────────────────────────────────
// Nothing here awaits anything above it. We paint the boot screen, then kick the
// tasks that GATE boot but DEPEND on almost nothing, so their latency overlaps
// instead of stacking behind the platform handshake / fs writes as it used to.

// Paint immediately (before OPFS even opens). The Desktop swaps in underneath via
// renderApp once boot knows the session fs.
const root = createRoot(document.getElementById('root')!);
root.render(<BootScreen />);

// (1) The bundler worker. Its ~10MB @rolldown WASM compile is the single dominant
// boot cost, and it needs only the project NAME — so spawn it FIRST, before OPFS,
// the platform handshake, or the engine seed, so that compile runs UNDER all of
// them. A guest session has no local bundler and terminates it (see boot()).
let bundlerReady = false;
const pendingConnects: Array<{ env: string; port: MessagePort }> = [];
const bundlerWorker = new Worker(new URL('./dev/bundler-worker.ts', import.meta.url), { type: 'module' });
bundlerWorker.onerror = (e) => console.error('[bundler-worker] load error', e.message);
// handshake: init on `worker-ready`, queue realm connections until `host-ready`,
// then flush them (a message posted into vite's dep-optimize/reload window is lost).
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
// realms hand us a MessagePort to reach the bundler; queue until it's live.
const connectRealm = (env: string, port: MessagePort) => {
    if (bundlerReady) bundlerWorker.postMessage({ type: 'connect-realm', env }, [port]);
    else pendingConnects.push({ env, port });
};

// (2) Open the main-doc OPFS working copy + editor state (the bundler opens its own).
const editorReady = openProjectFilesystem(PROJECT).then((projectFs) => {
    bootTimer.mark('opfs open');
    return initEditor({ fs: projectFs });
});

// (3) Seed the engine + first-party libs into the vfs the instant the fs is up — it
// only needs the fs, so it overlaps the platform handshake + the intent fs writes
// downstream. The pipeline (which resolves `bongle` from here) awaits this before it
// bakes; nothing else does.
const seedReady = editorReady.then(async (editor) => {
    bootLog('seeding engine…');
    const seedStart = performance.now();
    await seedEngineDist(editor.fs);
    console.log(`[boot:main] seedEngineDist ${(performance.now() - seedStart).toFixed(0)}ms`);
    // git-ready seed for a folder-sync'd disk copy (idempotent).
    await editor.fs.writeIfChanged('.gitignore', GITIGNORE);
    bootLog('engine ready');
});

// (4) The platform handshake — created now so the parent's intent is already in
// flight while (1)-(3) run.
const platform = createPlatformBridge();

async function boot(): Promise<void> {
    bootLog('booting dev environment…');
    // platform bridge + editor (OPFS) were kicked at module load (Phase 0) so their
    // latency overlapped the bundler's WASM compile; collect them now. `intent` is
    // what the embedding platform wants this session to do (null = standalone dev).
    const [intent, editor] = await Promise.all([platform.ready, editorReady]);
    usePlatform.getState().init(platform, intent);
    platform.onResult((r) => {
        usePlatform.getState().setResult(r);
        log(`platform ${r.of}: ${r.ok ? 'ok' : 'failed'}${r.message ? ` — ${r.message}` : ''}`);
    });

    // GUEST: joining someone else's session. Run the FULL editor against the host's
    // project over the relay — no local server/bundler/pipeline workers. The editor's
    // fs is the host's tree (remote fs); the play-preview window rides the relay too.
    if (intent?.kind === 'joinEdit') {
        // guest: the host owns the realms over the relay, so the bundler we
        // speculatively spawned in Phase 0 is dead weight here — reclaim it.
        bundlerWorker.terminate();
        const guestLog = logger('client');
        bootLog('joining a multiplayer edit session…');
        const session = createGuestSession({ url: intent.url, log: (m) => guestLog(`[guest] ${m}`) });
        useSession.getState().setHost(false); // gate off host-only actions
        const clientHost = createClientHost({
            connector: session.connector,
            projectName: PROJECT,
            log: (id, m) => guestLog(`[${id}] ${m}`),
        });
        useClients.getState().setHost(clientHost);
        renderApp(session.fs); // same Desktop, guest fs
        // Monaco: whole-project models + types over the relay fs, and the fs.watch
        // reconciler that reloads a file when another participant saves it (unless
        // this guest has unsaved edits — last-writer-wins). Same code as the host.
        void loadEngineTypes(session.fs);
        void syncProjectModels(session.fs);
        // one play-preview window (the relay lanes are singular), snapped full.
        const id = useClients.getState().open();
        if (id) useWindows.getState().snapTo(id, 'full');
        useBoot.getState().setReady();
        bootTimer.summary();
        return; // skip the host stack entirely
    }

    // HOST: mount the Desktop on the local OPFS project (BootScreen still covers it
    // until the session's primary surface is up). host is the default session mode.
    renderApp(editor.fs);

    // Folder sync when embedded: the editor can't open the file picker (cross-origin
    // iframe), so the host picks a folder and serves it over a MessagePort. Drive the
    // sync loop against it; a dismiss/failure just updates the status. Standalone dev
    // never fires these (no parent) — it picks locally via connect() instead.
    platform.onSyncPort((port, direction, folderName) => {
        void connectViaPort(editor.fs, port, direction, folderName, () => platform.notifySyncStopped());
    });
    platform.onSyncResult((r) => {
        if (r.cancelled) useSync.getState().reset();
        else useSync.getState().fail(r.message ?? 'could not start folder sync');
    });

    // the avatar the local player wears once the preview runs (see startEditorServer):
    // the edited glb (avatar), our account avatar (project), or a sample (standalone).
    // Captured now; read when the realm stack actually starts (which may be deferred).
    let localAvatarUrl: string | undefined;
    // avatar name for the Save dialog; arrives with the source (see below).
    let avatarName = intent?.kind === 'avatar' ? intent.name : undefined;

    if (intent?.kind === 'avatar') {
        // wear the edited avatar (avatar.glb, written by Blockbench on save) once a
        // preview runs. Set unconditionally: no glb yet → the engine shows a placeholder
        // and the first save's fs-change swaps in the compiled glb live (no re-join).
        localAvatarUrl = 'file:///avatar.glb';
    } else if (intent?.kind === 'project') {
        // a platform-supplied save replaces the project source before boot.
        if (intent.save) await importProjectSave(editor.fs, intent.save);
        localAvatarUrl = intent.avatarUrl; // play/edit the project as ourselves
    }

    // OPFS is the persistent source of truth: seed the starter project ONLY on a fresh
    // project (no src/index.ts). It's the world the preview runs, for BOTH modes — an
    // avatar previews on the sample game's player — so seed it regardless of mode.
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

    // realm-INDEPENDENT wiring (both modes, no preview needed): autosave arms a
    // throttled `bongle:draft` hand-back off genuine edits; onRequestSave runs the
    // session's save action from a platform CTA (avatar export vs project version).
    initAutosave(editor.fs, platform, intent);
    platform.onRequestSave(() => {
        if (intent?.kind === 'avatar') void saveAvatar(editor.fs, avatarName ?? 'avatar', intent.canEdit ?? false);
        else void runSave(editor.fs);
    });

    // ── The realm stack (bundler → pipeline bake → server → clients) as a lazily
    // started, idempotent unit. Project mode starts it at boot (the running game IS the
    // surface); avatar mode starts it on demand (first "+ client" / "Start server"), so
    // Blockbench is usable in seconds instead of waiting on the ~10MB bundler wasm.
    // The bundler worker (Phase 0) has been warming since module load either way, so a
    // deferred first preview is still fast.
    let realmsPromise: Promise<void> | null = null;
    const startRealms = (): Promise<void> => {
        if (!realmsPromise) {
            realmsPromise = (async () => {
                await seedReady; // the pipeline resolves `bongle` from the seeded node_modules
                // feed the seeded .d.ts into Monaco (types) + model every src file. Fire-
                // and-forget — the TS defaults are global even if the code window is closed.
                void loadEngineTypes(editor.fs);
                void syncProjectModels(editor.fs);

                // the worker bakes into the SAME OPFS project; its writes reach the main doc
                // via the OPFS cross-context mirror (editor.fs.watch), so no relay is wired.
                bootLog('baking assets…');
                const pipelineHost = spawnPipelineWorker({
                    connectRealm,
                    projectName: PROJECT,
                    log,
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
                // OPFS project directly — no snapshot. A manager (not a bare host) wraps the
                // worker in a stable facade and can reboot it in place (Restart action).
                const serverLog = logger('server');
                const serverHost = createServerManager({ connectRealm, projectName: PROJECT, log: serverLog, localAvatarUrl });
                useServer.getState().init(serverHost);

                // multiplayer editing (opt-in): wire the host subsystems so "Open to
                // multiplayer" can dial the relay. Nothing connects until the host asks.
                useMultiplayer
                    .getState()
                    .init({ platform, serverHost, connectRealm, fs: editor.fs, log: (m) => serverLog(`[mp] ${m}`) });

                // client iframes: each its own realm, connected to the server worker; the
                // "+ client" button opens more (multiplayer-in-a-tab). They open OPFS too.
                const clientLog = logger('client');
                const clientHost = createClientHost({
                    connector: localConnector(serverHost, connectRealm),
                    projectName: PROJECT,
                    log: (id, m) => clientLog(`[${id}] ${m}`),
                });
                useClients.getState().setHost(clientHost);
                log('realms live — edit src/index.ts then ⌘/ctrl+S to hot-reload.');

                // DevTools automation surface: `bongle` in the editor console.
                exposeDevtools('editor', {
                    fs: editor.fs,
                    ls: (dir = '') => editor.fs.list(dir, { recursive: true }),
                    cat: (path: string) => editor.fs.readText(path),
                    write: (path: string, data: string | Uint8Array) => editor.fs.write(path, data),
                    rm: (path: string, recursive = false) => editor.fs.remove(path, { recursive }),
                    hosts: { pipeline: pipelineHost, server: serverHost, client: clientHost, bundler: bundlerWorker },
                    stores: { editor: useEditor, windows: useWindows, clients: useClients, systemWindows: useSystemWindows },
                });

                // fan fs changes to the realms: bundler re-transforms + HMRs source/barrels;
                // server/client re-read baked resources. Fires for main-doc edits AND, via the
                // OPFS cross-context mirror, the worker's bake outputs — which is how those
                // reach the realms.
                const fanOutChange = (changes: FsChange[]) => {
                    bundlerWorker.postMessage({ type: 'fs-change', changes });
                    for (const c of changes) {
                        if (c.type === 'deleted') continue;
                        serverHost.relayFsChange(c.path);
                        clientHost.relayFsChange(c.path);
                    }
                };
                editor.fs.watch(fanOutChange);

                await serverHost.ready;
                bootLog('server ready');
            })().catch((e) => {
                realmsPromise = null; // let a later "Start server" retry a failed boot
                throw e;
            });
        }
        return realmsPromise;
    };
    useServer.getState().setStarter(startRealms);

    if (intent?.kind === 'avatar') {
        // Blockbench is usable NOW — frame it and mark the boot done. The realm stack
        // (game preview) starts only when asked (Start server / "+ client"). The source
        // arrives out-of-band (bongle:source) so a slow download never blocks reaching
        // Blockbench; the model pops in when it lands.
        useLaunched.getState().launch(blockbenchApp, 'avatar.bbmodel'); // frames the window (empty)
        const W = useWindows.getState();
        const deskW = window.innerWidth - TASKBAR_W;
        const w = Math.round(deskW * 0.7);
        const h = Math.round(window.innerHeight * 0.7);
        W.setBox('blockbench', TASKBAR_W + Math.round((deskW - w) / 2), Math.round((window.innerHeight - h) / 2), w, h);
        W.focus('blockbench');
        W.focus(PLATFORM_WINDOW_ID); // keep the platform widget on top / visible
        useBoot.getState().setReady();
        bootTimer.summary();

        // load the model when the platform resolves it (a local draft resolves fast, a
        // remixed/edited version after a download). null → the bundled starter rig.
        platform.onSource((bbmodel, name) => {
            if (name) avatarName = name;
            void editor.fs
                .write('avatar.bbmodel', bbmodel ?? starterCharacterBbmodel)
                .then(() => openPath('avatar.bbmodel', MAIN_PANE)); // idempotent launch + load
        });
        return;
    }

    // PROJECT (or standalone): the running game IS the surface, so boot the realms now
    // and open the play client full-screen.
    bootLog('booting realms…');
    await useServer.getState().start();
    bootLog('opening client…');
    const id = useClients.getState().open();
    if (id) useWindows.getState().snapTo(id, 'full');
    useBoot.getState().setReady();
    bootTimer.summary();
}

// the bottom log-window row (build + server), anchored to the viewport bottom
// with a small gap; falls back to y=24 on a very short viewport.
const BOTTOM_ROW_H = 190;
const BOTTOM_ROW_Y = Math.max(24, window.innerHeight - BOTTOM_ROW_H - 12);

// the fixed windows, built against the session's Filesystem (OPFS for the host, the
// remote fs for a guest) — so a guest's file tree + code editor drive the host's
// project over the relay, same components, no fork.
function buildWindows(fs: Filesystem): WindowDef[] {
    return [
        {
            id: 'files',
            title: 'files',
            glyph: <Files size={18} />,
            initial: { x: 60, y: 24, w: 220, h: 320 },
            content: <FileTree fs={fs} pane={MAIN_PANE} />,
        },
        {
            id: 'code',
            title: 'code',
            glyph: <Code size={18} />,
            initial: { x: 300, y: 24, w: 1240, h: 920 },
            content: <CodePane fs={fs} pane={MAIN_PANE} />,
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
            title: 'server',
            glyph: <Server size={18} />,
            initial: { x: 380, y: BOTTOM_ROW_Y, w: 310, h: BOTTOM_ROW_H },
            content: <ServerPanel />,
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
}

// mount the Desktop once boot knows the session fs (host OPFS | guest remote fs).
// The BootScreen was rendered in Phase 0 (at module load); this swaps in the Desktop
// underneath it.
function renderApp(fs: Filesystem): void {
    const windows = buildWindows(fs);
    // default layout: every fixed panel starts closed — reopen from the taskbar.
    for (const w of windows) useSystemWindows.getState().close(w.id);
    root.render(
        <>
            <Desktop windows={windows} fs={fs} />
            <BootScreen />
        </>,
    );
}

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

void boot().catch((err) => {
    // Boot can't proceed without a working fs (e.g. storage fully blocked). Surface
    // it in the boot log the user is looking at rather than hanging silently.
    console.error('[boot] fatal', err);
    useBoot.getState().log(err instanceof Error ? err.message : 'boot failed');
});
