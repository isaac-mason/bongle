// editor/platform/actions.ts — the platform-facing actions (build / save project /
// save avatar), shared by the taskbar footer (standalone dev tool) and the
// in-editor "editing X" window (embedded). When embedded they hand payloads to
// the platform over the bridge; standalone they download.

import type { BuildRequest, BuildResponse } from '../build/build-worker';
import type { Filesystem } from '../fs';
import { PROJECT_NAME } from '../project';
import { downloadProjectSave, exportProjectSave, SAVE_MAX_BYTES, saveSizeBytes } from '../project-save';
import { useBuildMeta } from '../stores/build-meta';
import { useBuildProgress } from '../stores/build-progress';
import { logger } from '../stores/logs';
import { usePlatform } from '../stores/platform';

/** run the prod build in a Worker (@rolldown/browser's threaded wasm can't run
 *  on the main thread — Atomics.wait). Returns the zip; progress streams back. */
function buildInWorker(maxPlayers: number, onProgress: (label: string) => void): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('../build/build-worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (e: MessageEvent<BuildResponse>) => {
            const m = e.data;
            // handshake: send the request only once the worker is live (its heavy
            // module survived vite's dep-optimize/reload window).
            if (m.type === 'ready') {
                worker.postMessage({ projectName: PROJECT_NAME, maxPlayers } satisfies BuildRequest);
                return;
            }
            if (m.type === 'progress') onProgress(m.label);
            else if (m.type === 'done') {
                worker.terminate();
                resolve(m.zip);
            } else {
                worker.terminate();
                reject(new Error(m.message));
            }
        };
        worker.onerror = (e) => {
            console.error('[build] worker onerror', e.message, e.filename, e.lineno, e);
            worker.terminate();
            reject(new Error(e.message || 'build worker failed to load (see console)'));
        };
        worker.onmessageerror = (e) => console.error('[build] worker message error', e);
    });
}

/** build the prod bundle. Embedded → hand to the platform; standalone → download.
 *  Progress shows in the BuildModal; a summary lands in the build log. */
export async function runBuild(fs: Filesystem): Promise<void> {
    const progress = useBuildProgress.getState();
    const log = logger('build');
    const embedded = usePlatform.getState().embedded;
    progress.begin();
    try {
        const t0 = performance.now();
        const zip = await buildInWorker(useBuildMeta.getState().maxPlayers, (l) => useBuildProgress.getState().step(l));
        if (embedded) {
            // ship the source alongside the built bundle so the platform can
            // snapshot it as a project_version + record the build's provenance.
            const source = await exportProjectSave(fs);
            usePlatform.getState().send({ type: 'bongle:build', payload: zip, source });
        } else {
            const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = 'bundle.zip';
            a.click();
            URL.revokeObjectURL(url);
        }
        progress.finish(zip.length);
        log(
            `bundle.zip built in ${(performance.now() - t0).toFixed(0)}ms — ${(zip.length / 1024).toFixed(0)}KB, ${embedded ? 'sent to platform' : 'downloaded'}`,
        );
    } catch (err) {
        progress.fail((err as Error).message);
        log(`build failed: ${(err as Error).message}`);
        console.error(err);
    }
}

/** save the project source. Embedded → hand to the platform; standalone → download.
 *  Refuses over the size cap (the server enforces the same; this saves a
 *  round-trip + gives a clear, actionable message). */
export async function runSave(fs: Filesystem): Promise<void> {
    const size = await saveSizeBytes(fs);
    if (size > SAVE_MAX_BYTES) {
        const mb = (size / (1024 * 1024)).toFixed(1);
        const cap = Math.round(SAVE_MAX_BYTES / (1024 * 1024));
        alert(`Save is ${mb} MB, over the ${cap} MB limit. Trim assets under assets/ and try again.`);
        return;
    }
    if (usePlatform.getState().embedded) {
        // 'saving' the instant we hand off, so the button reflects it while the
        // platform uploads (or an anonymous first-save collects a name/team). The
        // platform's bongle:result flips it to saved/error; a cancelled first-save
        // sends a result too, so the button never sticks.
        const platform = usePlatform.getState();
        platform.beginSave();
        try {
            platform.send({ type: 'bongle:version', payload: await exportProjectSave(fs) });
        } catch (err) {
            platform.setResult({
                of: 'version',
                ok: false,
                message: err instanceof Error ? err.message : 'save failed',
            });
        }
    } else {
        await downloadProjectSave(fs);
    }
}

/** hand the edited avatar (Blockbench-compiled glb + bbmodel source) to the
 *  platform. Blockbench writes both to the fs on save (Ctrl+S); if it hasn't yet,
 *  the compiled glb is missing — tell the user locally rather than the platform. */
export async function saveAvatar(fs: Filesystem, name: string, canEdit = false): Promise<void> {
    let glb: Uint8Array;
    let bbmodel: string;
    try {
        bbmodel = await fs.readText('avatar.bbmodel');
        glb = await fs.read('avatar.glb');
    } catch {
        alert('Save your model in Blockbench first (Ctrl+S), then Save avatar to bongle.');
        return;
    }
    // editing an existing team avatar → save as a new version, prefilling a name
    // the user can tweak. `canEdit` is the platform's team-membership verdict.
    let outName = name;
    if (canEdit) {
        const v = window.prompt('Name this version', `new version of ${name}`);
        if (v === null) return; // cancelled
        outName = v.trim() || name;
    }
    usePlatform.getState().send({ type: 'bongle:avatar-export', glb, bbmodel, name: outName });
}

/** ask the platform to navigate back to bongle.io. The editor never navigates
 *  itself (it may be a cross-origin iframe), so it hands off over the bridge.
 *  Confirms first — leaving drops any unsaved editor state. */
export function backToBongle(): void {
    if (!window.confirm('Go back to bongle.io? Any unsaved changes will be lost — save first if you need them.')) return;
    usePlatform.getState().send({ type: 'bongle:exit' });
}
