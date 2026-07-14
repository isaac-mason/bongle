// editor/platform/actions.ts — the platform-facing actions (build / save game /
// save avatar), shared by the taskbar footer (standalone dev tool) and the
// in-editor "editing X" window (embedded). When embedded they hand payloads to
// the platform over the bridge; standalone they download.

import { buildBundle, downloadBundle } from '../build/build';
import type { Filesystem } from '../fs';
import { downloadGameSave, exportGameSave } from '../game-save';
import { useBuildMeta } from '../stores/build-meta';
import { useBuildProgress } from '../stores/build-progress';
import { logger } from '../stores/logs';
import { usePlatform } from '../stores/platform';

/** build the prod bundle. Embedded → hand to the platform; standalone → download.
 *  Progress shows in the BuildModal; a summary lands in the build log. */
export async function runBuild(fs: Filesystem): Promise<void> {
    const progress = useBuildProgress.getState();
    const log = logger('build');
    const embedded = usePlatform.getState().embedded;
    progress.begin();
    try {
        const t0 = performance.now();
        const opts = { maxPlayers: useBuildMeta.getState().maxPlayers, onProgress: (l: string) => useBuildProgress.getState().step(l) };
        let size: number;
        if (embedded) {
            const zip = await buildBundle(fs, opts);
            usePlatform.getState().send({ type: 'bongle:build', payload: zip });
            size = zip.length;
        } else {
            size = await downloadBundle(fs, opts);
        }
        progress.finish(size);
        log(`bundle.zip built in ${(performance.now() - t0).toFixed(0)}ms — ${(size / 1024).toFixed(0)}KB, ${embedded ? 'sent to platform' : 'downloaded'}`);
    } catch (err) {
        progress.fail((err as Error).message);
        log(`build failed: ${(err as Error).message}`);
        console.error(err);
    }
}

/** save the game source. Embedded → hand to the platform; standalone → download. */
export async function runSave(fs: Filesystem): Promise<void> {
    if (usePlatform.getState().embedded) usePlatform.getState().send({ type: 'bongle:save', payload: await exportGameSave(fs) });
    else await downloadGameSave(fs);
}

/** hand the edited avatar (Blockbench-compiled glb + bbmodel source) to the
 *  platform. Blockbench writes both to the fs on save (Ctrl+S); if it hasn't yet,
 *  the compiled glb is missing — tell the user locally rather than the platform. */
export async function saveAvatar(fs: Filesystem, name: string): Promise<void> {
    let glb: Uint8Array;
    let bbmodel: string;
    try {
        bbmodel = await fs.readText('avatar.bbmodel');
        glb = await fs.read('avatar.glb');
    } catch {
        alert('Save your model in Blockbench first (Ctrl+S), then Save avatar to bongle.');
        return;
    }
    usePlatform.getState().send({ type: 'bongle:avatar-export', glb, bbmodel, name });
}

/** ask the platform to navigate back to bongle.io. The editor never navigates
 *  itself (it may be a cross-origin iframe), so it hands off over the bridge.
 *  Confirms first — leaving drops any unsaved editor state. */
export function backToBongle(): void {
    if (!window.confirm('Go back to bongle.io? Any unsaved changes will be lost — save first if you need them.')) return;
    usePlatform.getState().send({ type: 'bongle:exit' });
}
