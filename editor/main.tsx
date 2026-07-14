// editor/main.tsx — standalone entry. Mounts the editor (window manager) and
// wires the project session: engine externals (workspace source here; a CDN
// dist in the deployed website), the bundler, and flush→bake.

import { Code, Files, Hammer, MonitorPlay, Server } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import './editor.css';
import starterBbmodel from '../bongle-blockbench/starter/character.bbmodel?raw';
import { createClientHost } from './client/client-host';
import { seedEngineDist } from './engine-dist';
import { initEditor } from './entry';
import type { FsChange } from './fs';
import { openOpfsFilesystem } from './fs-opfs';
import { spawnPipelineWorker } from './pipeline/pipeline-host';
import { spawnServerWorker } from './server/server-host';
import { useClients } from './stores/clients';
import { MAIN_PANE, useEditor } from './stores/editor';
import { logger } from './stores/logs';
import { useSystemWindows } from './stores/system-windows';
import { useWindows } from './stores/windows';
import { CodePane } from './ui/components/CodePane';
import { Desktop, type WindowDef } from './ui/components/Desktop';
import { FileTree } from './ui/components/FileTree';
import { LogView } from './ui/components/LogView';

// the working copy is OPFS — shared across the main doc, server worker, and
// client iframes (same origin), so realms open it directly instead of syncing a
// snapshot. Top-level await: the whole editor waits on the fs.
const PROJECT = 'project';
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
    await editor.fs.write('manifest.json', JSON.stringify({ name: 'dev-sample', engineVersion: '0.0.0' }, null, 2));
    await editor.fs.write('src/index.ts', SAMPLE_INDEX);
    // a starter avatar source, openable in the blockbench app from the file tree.
    await editor.fs.write('character.bbmodel', starterBbmodel);
    // generated / non-source dirs; the tree grays (and collapses) gitignored entries.
    await editor.fs.write('.gitignore', 'node_modules/\ndist/\nresources/\n');
    // empty barrel so realms can import it before the first bake writes it (the
    // bake patches model/… handles with baked bin paths, mirroring the kit).
    await editor.fs.write('src/generated/models.ts', 'export {};\n');
    useEditor.getState().open(MAIN_PANE, 'src/index.ts'); // open it in the code window

    // seed the engine + first-party libs into the vfs so every realm's bundler
    // resolves `bongle` / `mathcat` / … from there.
    console.log('[main] seeding engine dist…');
    await seedEngineDist(editor.fs);
    console.log('[main] seed done; spawning workers');

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
    });
    // bake-then-run (mirrors the kit): wait for the first bake so every realm
    // fresh-imports the REAL generated barrel (baked model bin paths) at boot,
    // rather than racing an empty→real HMR that worker realms can't apply cleanly.
    await pipelineHost.ready;

    // the server, off-thread in its own realm (own registry). It opens the SAME
    // OPFS project directly — no snapshot.
    const serverLog = logger('server');
    const serverHost = spawnServerWorker({ connectRealm, projectName: PROJECT, log: serverLog });

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

    // open the first client once the server is live (join before the sim exists
    // would be dropped); the "+ client" button opens further windows. Default
    // layout: this client fills the screen (everything else starts closed).
    void serverHost.ready.then(() => {
        const id = useClients.getState().open();
        if (id) useWindows.getState().snapTo(id, 'full');
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
