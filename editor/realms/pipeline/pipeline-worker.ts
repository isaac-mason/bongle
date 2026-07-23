// editor/realms/pipeline/pipeline-worker.ts — the asset-pipeline realm, off the main thread.
//
// Bakes get heavy (atlas packing, audio encode) — running here keeps the UI
// responsive. Mirrors server-worker.ts: opens the shared OPFS project, evaluates
// the user code via a ModuleRunner bridged to the bundler worker, then runs the
// AssetPipeline the user declarations registered into. HMR re-evals re-fire the
// flush → re-bake; results post back to the main doc for the atlas view + logs.

import { createPortBridge } from '../../../build';
import { createBrowserRaster } from '../../../src/asset-pipeline/bake/raster-browser';
import { createBrowserDecodeAudio } from '../../../src/asset-pipeline/decode-audio-browser';
import { createBakeLoader, createClientResourceLoader } from '../../../src/asset-pipeline/loader';
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
    // shared OPFS project (same origin) — baked outputs land here for the main
    // doc's atlas view to re-read; no snapshot.
    const fs = await openProjectFilesystem(projectName);
    bt.mark('opfs open');

    // the bake's writes reach the main doc (barrel HMR + baked-resource refresh) via
    // the OPFS cross-context mirror — no explicit relay from here.

    // evaluate user code via a ModuleRunner bridged to the bundler worker (it
    // transforms; this realm evaluates → its own engine registry).
    const runner = makeRunner(createPortBridge(bundlerPort));
    // runtime env flags before user/engine eval. NOT env.client: this is a bake +
    // icon-render worker with no document/window. The icon render stack is
    // canvas-less (headless-render builds OffscreenCanvas directly, with no
    // env.client gate), so it doesn't need it — and env.client=true would make user
    // scripts' `if (!env.client) return` gameplay guards PASS, running DOM-assuming
    // gameplay here → it throws. Matches the cli pipeline realm.
    bt.mark('runner built');
    const { env } = await runner.import('bongle/env'); // first bundler fetch
    bt.mark('import bongle/env');
    env.client = false;
    env.server = true;
    env.editor = true;
    // Resilience: a user module that throws at eval (unguarded top-level DOM, or
    // gameplay that assumes a running engine) must NOT abort the bake — the atlas /
    // models / audio still generate from whatever registered before the throw.
    try {
        await runner.import('src/index.ts'); // user declarations register into this realm's engine (full graph)
    } catch (err) {
        log(`user code threw at eval — baking what registered so far: ${(err as Error).message}`);
        console.error('[pipeline-worker] user eval failed', err);
    }
    bt.mark('import src/index.ts (full graph)');
    // registry is populated by the import above — the prod build reads matchmaking
    // off it (see below), since the build itself never evaluates user code.
    const { __bongle, registry } = await runner.import('bongle/internal');
    // engine-asset-pipeline exposes the data baker (`AssetPipeline`) and the
    // post-bake icon render step (`Icons`). Both run in THIS realm, so they see
    // the registry the user declarations populated (a static worker import would
    // get a different, empty engine instance). Same JS realm → plain calls, no
    // serialization: `loader` goes in, atlas pixels come back.
    const { AssetPipeline, Icons } = await runner.import('bongle/engine-asset-pipeline');
    bt.mark('import engine barrels');

    // the baker reads inputs through the loader (project-relative → fs, absolute
    // + file:// → fetch/vfs) and decodes audio via mediabunny + WebCodecs (worker-
    // safe, unlike OfflineAudioContext — see decode-audio-browser.ts).
    const loader = createBakeLoader(fs);
    // icons read baked client assets (atlas, model bins) back out of the fs; those
    // live under resources/client/, not at the project root the bake loader reads.
    const iconLoader = createClientResourceLoader(fs);
    const decodeAudio = createBrowserDecodeAudio();
    const raster = createBrowserRaster();
    const pipeline = AssetPipeline.init({ mode: 'edit', cache: true, fs, loader, decodeAudio, raster });

    // in-worker icon rendering: a headless GPU render stack, lazily created on
    // first use (device handshake + pipeline compiles are expensive and atlas-
    // independent). null until then; a failed handshake stays null and we retry.
    let renderCtx: Awaited<ReturnType<typeof Icons.createHeadlessRenderContext>> | null = null;
    let renderingIcons = false;

    // Render block (and later prefab) icons for the current registry + baked
    // atlas and write them as first-class client assets under resources/client/
    // (voxels-icons.png + sidecar json) — shipped alongside the atlas so gameplay
    // (inventory/hotbar) and the editor both read them from the same place. Fully
    // isolated: an icon failure logs and never disturbs the bake. Instrumented
    // per step so a break in the worker render path is pinpointable.
    async function renderIcons(): Promise<void> {
        if (renderingIcons) return;
        renderingIcons = true;
        try {
            if (!renderCtx) {
                log('icons: creating headless render context…');
                renderCtx = await Icons.createHeadlessRenderContext();
                log('icons: render context ready');
            }
            log('icons: building render deps…');
            const { deps, dispose } = await Icons.buildRenderDeps(renderCtx, iconLoader);
            try {
                log('icons: rendering block atlas…');
                const atlas = await Icons.renderBlockIconAtlas(deps);
                if (atlas.atlasWidth === 0 || atlas.atlasHeight === 0) {
                    log('icons: empty atlas (no renderable blocks) — nothing to write');
                    return;
                }
                log(`icons: encoding ${atlas.atlasWidth}x${atlas.atlasHeight} atlas → png…`);
                const png = await encodeRgbaPng(atlas.pixels, atlas.atlasWidth, atlas.atlasHeight);
                await fs.write('resources/client/voxels-icons.png', png);
                await fs.write(
                    'resources/client/voxels-icons.json',
                    new TextEncoder().encode(
                        JSON.stringify({
                            coords: atlas.coords,
                            cols: atlas.cols,
                            rows: atlas.rows,
                            iconPx: atlas.iconPx,
                            atlasWidth: atlas.atlasWidth,
                            atlasHeight: atlas.atlasHeight,
                        }),
                    ),
                );
                log(`icons: wrote resources/client/voxels-icons.png (${(png.byteLength / 1024).toFixed(0)}KB)`);
            } finally {
                dispose();
            }
        } catch (err) {
            log(`icons error: ${(err as Error).message}`);
            console.error('[pipeline-worker] icon render failed', err);
        } finally {
            renderingIcons = false;
        }
    }

    // one bake pass against the current registry + asset bytes. Resolves when the
    // outputs (atlas / manifest / generated barrels) are written — boot awaits the
    // first one (bake-then-run) so the realms don't read a missing audio-manifest.json
    // etc. The `baking` guard drops triggers that land mid-bake; a later edit re-bakes.
    let baking = false;
    const runBake = async (): Promise<void> => {
        if (baking) return;
        baking = true;
        try {
            const t0 = performance.now();
            const r = await AssetPipeline.run(pipeline, {});
            log(`bake ${(performance.now() - t0).toFixed(0)}ms — atlas ${r.atlasChanged ? 'changed' : 'unchanged'}`);
            // report matchmaking (singleton id 'main') so the prod build has a current
            // maxPlayers without evaluating user code itself.
            const maxPlayers = registry.matchmaking.byId.get('main')?.payload?.maxPlayers;
            post({ type: 'baked', atlasChanged: r.atlasChanged, maxPlayers });
        } catch (err) {
            log(`bake error: ${(err as Error).message}`);
        } finally {
            baking = false;
        }
        // icons render after the bake — own error boundary, and deliberately NOT awaited:
        // a GPU handshake shouldn't gate the bake result or `ready`.
        void renderIcons();
    };
    // declarations settle → bake. Registered on THIS realm's __bongle, so its flush
    // (initial + every HMR re-eval) runs the bake against the registry the user
    // code populated.
    __bongle.registerFlush(runBake);
    // asset-file edits don't re-eval code, so no flush fires — watch for them (from
    // any context; the fs is cross-context) and rebake, mirroring the CLI's node
    // asset watcher (cli/dev/start.ts). Exclude the derived dirs: our own bake outputs
    // (resources/*.png|flac) match ASSET_RE, and would otherwise re-trigger us.
    const ASSET_RE = /\.(png|jpe?g|glb|gltf|ogg|wav|mp3|flac)$/i;
    let bakeTimer: ReturnType<typeof setTimeout> | undefined;
    fs.watch((changes) => {
        const hit = changes.some((c) => ASSET_RE.test(c.path) && !/(^|\/)(resources|node_modules|dist)(\/|$)/.test(c.path));
        if (!hit) return;
        clearTimeout(bakeTimer);
        bakeTimer = setTimeout(() => void runBake(), 150);
    });
    bt.mark('pipeline init');
    // the first bake, awaited (bake-then-run): its outputs must exist before the realms
    // boot. registerFlush drives later HMR re-evals, but the flush event is microtask-
    // debounced (core/capture/flush.ts), so run the first bake directly for a promise to
    // await — __bongle.flush() would return before the bake even starts.
    await runBake();
    bt.mark('initial bake done');
    bt.summary();
    post({ type: 'ready' });
}

/** RGBA8 pixels → PNG bytes via OffscreenCanvas (worker-safe; no DOM canvas). */
async function encodeRgbaPng(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
    // copy into a fresh ArrayBuffer-backed view (ImageData rejects a possibly-
    // SharedArrayBuffer-backed one).
    const clamped = new Uint8ClampedArray(pixels);
    ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
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
    });
});

// handshake (mirrors bundler-worker): announce we're live so the host posts init
// (with the transferred bundler port) only now. A blind init at spawn is dropped
// in vite's dep-optimize/reload window — this module often finishes eval AFTER it.
console.log('[boot] pipeline-worker: module eval complete, posting worker-ready');
self.postMessage({ type: 'worker-ready' });
