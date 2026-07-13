// editor/main.tsx — standalone entry. Mounts the editor (window manager) and
// wires the project session: engine externals (workspace source here; a CDN
// dist in the deployed website), the bundler, and flush→bake.

import { Boxes, Code, Files, MonitorPlay, Server } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import starterBbmodel from '../bongle-blockbench/starter/character.bbmodel?raw';
import * as bongle from '../src/index';
import * as bongleInternal from '../src/internal';
import * as bongleStarter from '../src/starter/index';
import { startBundler } from './bundler/bundler';
import type { Externals } from './bundler/runner';
import { initEditor, runPipeline } from './entry';
import { startEditorServer } from './server';
import { logger } from './stores/logs';
import { useOpenFile } from './stores/open-file';
import { usePipeline } from './stores/pipeline';
import { AtlasView } from './ui/components/AtlasView';
import { CodePane } from './ui/components/CodePane';
import { Desktop, type WindowDef } from './ui/components/Desktop';
import { FileTree } from './ui/components/FileTree';
import { LogView } from './ui/components/LogView';

const { __kit } = bongleInternal;
const externals: Externals = new Map<string, unknown>([
    ['bongle', bongle],
    ['bongle/internal', bongleInternal],
    ['bongle/starter', bongleStarter],
]);

const editor = initEditor();
const log = logger('pipeline');

// declarations settle → bake → refresh the atlas view. Registered on the
// shared engine __kit, so any user module's flush() runs this.
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
    useOpenFile.getState().open('src/index.ts'); // open it in the code window
    log('sample project written; starting bundler…');
    await startBundler({ fs: editor.fs, externals, entry: 'src/index.ts' });
    log('bundler running — edit src/index.ts then ⌘/ctrl+S to hot-reload.');

    // boot the server in this (main, server-env) realm — declarations are
    // registered now. Logs to the server window.
    const serverLog = logger('server');
    try {
        await startEditorServer({ fs: editor.fs, log: serverLog });
    } catch (err) {
        serverLog(`server boot failed: ${(err as Error).message}`);
        console.error(err);
    }

    __kit.flush(); // initial bake + registry apply (server flush handler is now registered).
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
    {
        id: 'client',
        title: 'client',
        glyph: <MonitorPlay size={18} />,
        initial: { x: 810, y: 514, w: 320, h: 160 },
        content: <div style={{ padding: 12, color: '#888' }}>client — arrives with #3 (server + client in the tab).</div>,
    },
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
