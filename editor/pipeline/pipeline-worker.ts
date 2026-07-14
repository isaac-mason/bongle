// editor/pipeline-worker.ts — the asset-pipeline realm, off the main thread.
//
// Bakes get heavy (atlas packing, audio encode) — running here keeps the UI
// responsive. Mirrors server-worker.ts: opens the shared OPFS project, evaluates
// the user code via a ModuleRunner bridged to the bundler worker, then runs the
// AssetPipeline the user declarations registered into. HMR re-evals re-fire the
// flush → re-bake; results post back to the main doc for the atlas view + logs.

import { createBrowserDecodeAudio } from '../../src/asset-pipeline/decode-audio-browser';
import { createBakeLoader } from '../../src/asset-pipeline/loader';
import { createPortBridge } from '../bundler/port-bridge';
import { makeRunner } from '../bundler/runner';
import { openOpfsFilesystem } from '../fs-opfs';

type InitMsg = { type: 'init'; projectName: string };

const post = (msg: unknown) => self.postMessage(msg);
const log = (m: string) => post({ type: 'log', msg: m });

async function boot(projectName: string, bundlerPort: MessagePort): Promise<void> {
    // shared OPFS project (same origin) — baked outputs land here for the main
    // doc's atlas view to re-read; no snapshot.
    const fs = await openOpfsFilesystem(projectName);

    // the bake writes through THIS fs handle; OPFS has no cross-context change
    // events, so relay those writes to the main doc, which HMRs the generated
    // barrel (bin paths → server/client) + refreshes baked resources.
    fs.watch((changes) => post({ type: 'fs-changed', changes }));

    // evaluate user code via a ModuleRunner bridged to the bundler worker (it
    // transforms; this realm evaluates → its own engine registry).
    const runner = makeRunner(createPortBridge(bundlerPort));
    // runtime env flags before user/engine eval (mirrors the kit entry).
    const { env } = await runner.import('bongle/env');
    env.client = false;
    env.server = true;
    env.editor = true;
    console.log('[pipeline-worker] importing src/index.ts…');
    await runner.import('src/index.ts'); // user declarations register into this realm's engine
    console.log('[pipeline-worker] src/index.ts done');
    const { __kit } = await runner.import('bongle/internal');
    // engine-asset-pipeline wraps its api under `export * as AssetPipeline`.
    const { AssetPipeline } = await runner.import('bongle/engine-asset-pipeline');
    console.log('[pipeline-worker] engine imported');

    // the baker reads inputs through the loader (project-relative → fs, absolute
    // + file:// → fetch/vfs) and decodes audio via OfflineAudioContext.
    const loader = createBakeLoader(fs);
    const decodeAudio = createBrowserDecodeAudio();
    const pipeline = AssetPipeline.init({ mode: 'edit', cache: true, fs, loader, decodeAudio });

    // declarations settle → bake. Registered on THIS realm's __kit, so its flush
    // (initial + every HMR re-eval) runs the bake against the registry the user
    // code populated.
    let baking = false;
    __kit.registerFlush(() => {
        if (baking) return;
        baking = true;
        void (async () => {
            try {
                const t0 = performance.now();
                const r = await AssetPipeline.run(pipeline, {});
                log(`bake ${(performance.now() - t0).toFixed(0)}ms — atlas ${r.atlasChanged ? 'changed' : 'unchanged'}`);
                post({ type: 'baked', atlasChanged: r.atlasChanged });
            } catch (err) {
                log(`bake error: ${(err as Error).message}`);
            } finally {
                baking = false;
            }
        })();
    });
    __kit.flush(); // initial bake + registry apply
    post({ type: 'ready' });
}

console.log('[pipeline-worker] script loaded');

let booted = false;
self.addEventListener('message', (e: MessageEvent) => {
    const msg = e.data as InitMsg;
    console.log('[pipeline-worker] message', msg?.type);
    if (msg?.type !== 'init' || booted) return;
    booted = true;
    const bundlerPort = e.ports[0]; // the bundler conduit (→ bundler worker)
    if (!bundlerPort) throw new Error('pipeline init needs a bundler port');
    void boot(msg.projectName, bundlerPort).catch((err) => {
        log(`pipeline boot failed: ${(err as Error).message}`);
        console.error(err);
    });
});
