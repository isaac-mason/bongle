// editor/realms/pipeline/pipeline-worker.ts — the asset-pipeline realm, off the main thread.
//
// A THIN DRIVER. Bakes get heavy (atlas packing, audio encode, GPU icon render), so they
// run here to keep the UI responsive — but the orchestration lives in the engine now. This
// worker: opens the shared OPFS project, evaluates the user code via a ModuleRunner bridged
// to the bundler, then hands the engine's `EditPipeline` session the fs + an `onBaked`
// callback. The engine owns the bake loop, the icon render, and re-bake-on-re-declare (it
// registers the flush internally — this worker never touches `bongle/internal`). The worker
// only drives asset-file re-bakes (its own fs.watch) + the initial bake, and pumps the
// message protocol. Mirrors server-worker.ts.

import { createPortBridge } from '../../../build';
import { createBootTimer } from '../../boot-timing';
import { makeRunner } from '../../dev/runner';
import { openProjectFilesystem } from '../../fs-open';

const bt = createBootTimer('pipeline');

type InitMsg = { type: 'init'; projectName: string };
type WorkerMsg = InitMsg | { type: 'dispose' };

const post = (msg: unknown) => self.postMessage(msg);
const log = (m: string) => post({ type: 'log', msg: m });

async function boot(projectName: string, bundlerPort: MessagePort): Promise<void> {
    bt.mark('boot() start');
    // shared OPFS project (same origin) — baked outputs land here for the main doc's atlas
    // view to re-read via the OPFS cross-context mirror; no snapshot, no explicit relay.
    const fs = await openProjectFilesystem(projectName);
    bt.mark('opfs open');

    // evaluate user code via a ModuleRunner bridged to the bundler worker (it transforms;
    // this realm evaluates → its own engine registry).
    const runner = makeRunner(createPortBridge(bundlerPort));
    bt.mark('runner built');
    // runtime env flags before user/engine eval. NOT env.client: this is a bake + icon-render
    // worker with no document/window; env.client=true would make user gameplay guards pass and
    // run DOM-assuming code here. Matches the cli pipeline realm.
    const { env } = await runner.import('bongle/env'); // first bundler fetch
    bt.mark('import bongle/env');
    env.client = false;
    env.server = true;
    env.editor = true;
    // Resilience: a user module that throws at eval must NOT abort the bake — bake what
    // registered before the throw.
    try {
        await runner.import('src/index.ts'); // user declarations register into this realm's engine (full graph)
    } catch (err) {
        log(`user code threw at eval — baking what registered so far: ${(err as Error).message}`);
        console.error('[pipeline-worker] user eval failed', err);
    }
    bt.mark('import src/index.ts (full graph)');

    // The engine's edit-session owns the data bake + GPU icon render, and registers the flush
    // internally (re-bake when the user re-declares). We provide only the fs + an onBaked
    // callback (post the result to the main doc), and drive asset-edit re-bakes below.
    const { EditPipeline } = await runner.import('bongle/engine-asset-pipeline');
    const session = EditPipeline.init(
        { fs, onBaked: (r: { atlasChanged: boolean; maxPlayers: number | null }) => post({ type: 'baked', ...r }), log },
        { mode: 'edit', cache: true },
    );
    bt.mark('edit-pipeline init');

    // asset-file edits don't re-eval code (so no flush fires) — watch for them and re-bake,
    // mirroring the CLI's node asset watcher. Exclude the derived dirs: our own bake outputs
    // (resources/*.png|flac) match ASSET_RE and would otherwise re-trigger us.
    const ASSET_RE = /\.(png|jpe?g|glb|gltf|ogg|wav|mp3|flac)$/i;
    let bakeTimer: ReturnType<typeof setTimeout> | undefined;
    fs.watch((changes) => {
        const hit = changes.some((c) => ASSET_RE.test(c.path) && !/(^|\/)(resources|node_modules|dist)(\/|$)/.test(c.path));
        if (!hit) return;
        clearTimeout(bakeTimer);
        bakeTimer = setTimeout(() => void EditPipeline.run(session), 150);
    });
    bt.mark('pipeline init');

    // the first bake, awaited (bake-then-run): its outputs must exist before the realms boot.
    // Later re-bakes come from the engine's flush (code edits) or the fs.watch above (assets).
    await EditPipeline.run(session);
    bt.mark('initial bake done');
    bt.summary();
    post({ type: 'ready' });
}

let booted = false;
self.addEventListener('message', (e: MessageEvent) => {
    const msg = e.data as WorkerMsg;
    console.log('[boot] pipeline-worker: message received:', msg?.type);
    if (msg?.type !== 'init' || booted) return;
    booted = true;
    const bundlerPort = e.ports[0]; // the bundler conduit (→ bundler worker)
    if (!bundlerPort) throw new Error('pipeline init needs a bundler port');
    void boot(msg.projectName, bundlerPort).catch((err) => {
        log(`pipeline boot failed: ${(err as Error).message}`);
        console.error(err);
        // report it so the host rejects `ready` instead of hanging. A USER-code error can't
        // reach here — boot() try/catches the user import — so this is a real infra failure.
        self.postMessage({ type: 'boot-error', message: (err as Error).message });
    });
});

// handshake (mirrors bundler-worker): announce we're live so the host posts init (with the
// transferred bundler port) only now. A blind init at spawn is dropped in vite's
// dep-optimize/reload window — this module often finishes eval AFTER it.
console.log('[boot] pipeline-worker: module eval complete, posting worker-ready');
self.postMessage({ type: 'worker-ready' });
