// editor/main.tsx — standalone entry. Mounts the editor (window manager) and
// wires the project session: engine externals (workspace source here; a CDN
// dist in the deployed website), the bundler, and flush→bake.

import { Boxes, Code, Files, Server } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import starterBbmodel from '../bongle-blockbench/starter/character.bbmodel?raw';
import { createBundlerHost } from './bundler/host';
import { createClientHost } from './client-host';
import { seedEngineDist } from './engine-dist';
import { initEditor, initPipeline, runPipeline } from './entry';
import { spawnServerWorker } from './server-host';
import { useClients } from './stores/clients';
import { logger } from './stores/logs';
import { useOpenFile } from './stores/open-file';
import { usePipeline } from './stores/pipeline';
import { AtlasView } from './ui/components/AtlasView';
import { CodePane } from './ui/components/CodePane';
import { Desktop, type WindowDef } from './ui/components/Desktop';
import { FileTree } from './ui/components/FileTree';
import { LogView } from './ui/components/LogView';

const editor = initEditor();
const log = logger('pipeline');

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
    // baked pipeline outputs aren't source; the tree grays gitignored entries.
    await editor.fs.write('.gitignore', 'resources/\n');
    useOpenFile.getState().open('src/index.ts'); // open it in the code window

    // seed the prebundled engine dist into the vfs so the bundler resolves
    // `bongle*` from there (bundled in, not external).
    await seedEngineDist(editor.fs);

    // the ONE dev server. Every realm's user-code transform + HMR flow from it;
    // realms only evaluate. The pipeline lives in this document → a local
    // runner; the server worker + client iframes attach over bundler ports.
    const host = createBundlerHost(editor.fs);

    log('evaluating project (pipeline realm)…');
    const pipeline = host.createLocalRunner('pipeline');
    await pipeline.import('src/index.ts'); // user declarations register into the pipeline realm's engine
    // __kit from the SAME runner instance the declarations registered into.
    const { __kit } = await pipeline.import('bongle/internal');
    // the baker, ALSO from this runner, so it reads the registry the user
    // declarations just populated (a native AssetPipeline would read a different,
    // empty one).
    const AssetPipeline = await pipeline.import('bongle/engine-asset-pipeline');
    initPipeline(editor, AssetPipeline);
    log('bundler running — edit src/index.ts then ⌘/ctrl+S to hot-reload.');

    // declarations settle → bake → refresh the atlas view. Registered on the
    // pipeline realm's __kit, so its flush runs the bake.
    let baking = false;
    __kit.registerFlush(() => {
        if (baking) return;
        baking = true;
        void (async () => {
            try {
                const t0 = performance.now();
                const r = await runPipeline(editor);
                log(`bake ${(performance.now() - t0).toFixed(0)}ms — atlas ${r.atlasChanged ? 'changed' : 'unchanged'}`);
                usePipeline.getState().baked();
            } catch (err) {
                log(`bake error: ${(err as Error).message}`);
            } finally {
                baking = false;
            }
        })();
    });

    // the server, off-thread in its own realm (own registry), fed by the host.
    const serverLog = logger('server');
    const serverHost = spawnServerWorker({ fs: editor.fs, host, log: serverLog });

    // client iframes: each its own realm, connected to the server worker; the
    // "+ client" button opens more (multiplayer-in-a-tab).
    const clientLog = logger('client');
    const clientHost = createClientHost({ serverHost, host, fs: editor.fs, log: (id, m) => clientLog(`[${id}] ${m}`) });
    useClients.getState().setHost(clientHost);

    // fs edits fan out: the host re-transforms + pushes HMR to every realm, and
    // each worker/iframe fs mirror is updated so its resource/scene reads see
    // the change (baked outputs, scenes).
    editor.fs.watch((changes) => {
        host.onFsChange(changes);
        for (const c of changes) {
            if (c.type === 'deleted') continue;
            void editor.fs
                .read(c.path)
                .then((bytes) => {
                    serverHost.relayFsChange(c.path, bytes);
                    clientHost.relayFsChange(c.path, bytes);
                })
                .catch(() => {});
        }
    });

    __kit.flush(); // initial bake + registry apply (pipeline realm).

    // open the first client once the server is live (join before the sim exists
    // would be dropped); the "+ client" button opens further windows.
    void serverHost.ready.then(() => useClients.getState().open());
}

const windows: WindowDef[] = [
    {
        id: 'files',
        title: 'files',
        glyph: <Files size={18} />,
        initial: { x: 60, y: 24, w: 220, h: 320 },
        content: <FileTree fs={editor.fs} />,
    },
    {
        id: 'code',
        title: 'code',
        glyph: <Code size={18} />,
        initial: { x: 300, y: 24, w: 620, h: 460 },
        content: <CodePane fs={editor.fs} />,
    },
    {
        id: 'pipeline',
        title: 'pipeline',
        glyph: <Boxes size={18} />,
        initial: { x: 810, y: 24, w: 320, h: 470 },
        content: (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <AtlasView fs={editor.fs} />
                <div style={{ borderTop: '1px solid #000', flex: 1, minHeight: 0 }}>
                    <LogView stream="pipeline" />
                </div>
            </div>
        ),
    },
    {
        id: 'server',
        title: 'server',
        glyph: <Server size={18} />,
        initial: { x: 320, y: 484, w: 470, h: 190 },
        content: <LogView stream="server" />,
    },
    // client windows are dynamic (opened by the "+ client" button, one iframe
    // realm each) — see stores/clients + Desktop.
];

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
