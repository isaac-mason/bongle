// src/asset-pipeline/edit-session.ts — the EDIT-MODE pipeline session (browser).
//
// The editor's pipeline realm drives this instead of orchestrating the baker by hand.
// `init({ fs, onBaked }, { mode, cache })`:
//   - wires the browser bake capabilities (raster / decodeAudio / loader) so the caller
//     provides only `fs` (the host-neutral AssetPipeline core stays injectable — node
//     bake uses it directly with node caps),
//   - registers the flush so a user re-declare (HMR) re-bakes — ENGINE-INTERNAL, so
//     `bongle/internal` / `registerFlush` never leave the engine (the old pipeline-worker
//     reached into them across the boundary; it no longer does),
//   - owns the bake loop + the GPU icon render.
// `run(state)` = one bake pass (data + icons), reported via `onBaked`.
//
// The editor owns WHEN to run() for asset-file edits (its own fs.watch) + the initial
// bake; the flush drives re-bakes on code edits. Browser-only (OffscreenCanvas + the
// headless GPU icon render) — kept out of the host-neutral `pipeline.ts` core.

import { registerFlushHandler } from '../core/capture/flush';
import { createBrowserRaster } from './bake/raster-browser';
import { createBrowserDecodeAudio } from './decode-audio-browser';
import type { Filesystem } from './filesystem';
import * as Icons from './icons';
import { createBakeLoader, createClientResourceLoader } from './loader';
import * as AssetPipeline from './pipeline';

export type BakeReport = {
    /** atlas bytes moved this pass — the caller tells the live client to refresh. */
    atlasChanged: boolean;
    /** latest declared matchmaking maxPlayers (the build manifest reads this). */
    maxPlayers: number | null;
};

export type Driver = {
    /** the editor project filesystem: sidecars read from it, baked outputs written into it. */
    fs: Filesystem;
    /** called after every bake pass (flush-driven or run()-driven) with the result. */
    onBaked: (report: BakeReport) => void;
    /** optional progress/error log surfaced to the editor. */
    log?: (msg: string) => void;
};

export type Opts = {
    mode: 'edit' | 'play';
    cache: boolean;
    /** forced render backend for the icon bake, forwarded from the editor's
     *  `?renderer=` (the worker's `self.location` can't carry it). Absent → the
     *  offline seam's `selectBackend()` default. */
    renderer?: 'webgpu' | 'webgl';
};

export type State = {
    driver: Driver;
    pipeline: AssetPipeline.State;
    iconLoader: ReturnType<typeof createClientResourceLoader>;
    unregisterFlush: () => void;
    /** forced render backend for icon baking (see `Opts.renderer`). */
    renderer: 'webgpu' | 'webgl' | undefined;
    // guards: a bake / icon render in flight drops overlapping triggers (a later edit re-fires).
    baking: boolean;
    // headless GPU render context, lazily created on first icon render (device handshake +
    // pipeline compiles are expensive + atlas-independent). null until then; a failed
    // handshake stays null + retries.
    renderCtx: Awaited<ReturnType<typeof Icons.createHeadlessRenderContext>> | null;
    renderingIcons: boolean;
};

export function init(driver: Driver, opts: Opts): State {
    const { fs } = driver;
    const pipeline = AssetPipeline.init({
        mode: opts.mode,
        cache: opts.cache,
        fs,
        loader: createBakeLoader(fs),
        decodeAudio: createBrowserDecodeAudio(),
        raster: createBrowserRaster(),
    });
    const state: State = {
        driver,
        pipeline,
        iconLoader: createClientResourceLoader(fs),
        unregisterFlush: () => {},
        renderer: opts.renderer,
        baking: false,
        renderCtx: null,
        renderingIcons: false,
    };
    // Re-bake when the user's declarations change (HMR re-eval → flush). This is the
    // definite "declarations settled" signal, fired at the tail of the re-eval; keeping
    // the registration here (engine-internal) is what lets the editor worker stay a thin
    // driver that never imports bongle/internal.
    state.unregisterFlush = registerFlushHandler(() => run(state));
    return state;
}

/** One bake pass: the data bake (atlas / sprites / models / scenes / audio) plus the GPU
 *  icon render, reported via `onBaked`. Idempotent + guarded; coalescing / when-to-fire
 *  for asset edits is the caller's concern (the flush drives code edits). */
export async function run(state: State): Promise<void> {
    if (state.baking) return;
    state.baking = true;
    let atlasChanged = false;
    try {
        const t0 = performance.now();
        const r = await AssetPipeline.run(state.pipeline);
        atlasChanged = r.atlasChanged;
        state.driver.log?.(`bake ${(performance.now() - t0).toFixed(0)}ms — atlas ${r.atlasChanged ? 'changed' : 'unchanged'}`);
        state.driver.onBaked({ atlasChanged: r.atlasChanged, maxPlayers: r.matchmakingConfig?.maxPlayers ?? null });
    } catch (err) {
        state.driver.log?.(`bake error: ${(err as Error).message}`);
    } finally {
        state.baking = false;
    }
    // icons render after the bake — own error boundary, deliberately NOT awaited: a GPU
    // handshake shouldn't gate the bake result or the caller's initial-bake promise.
    void renderIcons(state, atlasChanged);
}

export function dispose(state: State): void {
    state.unregisterFlush();
    AssetPipeline.dispose(state.pipeline);
}

// ── icon rendering (moved out of the editor's pipeline-worker; GPU/headless, browser) ──
// Render block (and prefab) icons for the current registry + baked atlas, written as
// first-class client assets under resources/client/ (voxels-icons.png + sidecar json) —
// shipped alongside the atlas so gameplay (inventory/hotbar) and the editor both read them
// from the same place. Fully isolated: an icon failure logs and never disturbs the bake.
async function renderIcons(state: State, atlasChanged: boolean): Promise<void> {
    if (state.renderingIcons) return;
    state.renderingIcons = true;
    const { fs, log } = state.driver;
    try {
        if (!state.renderCtx) {
            log?.('icons: creating headless render context…');
            state.renderCtx = await Icons.createHeadlessRenderContext(undefined, state.renderer);
            log?.('icons: render context ready');
        }
        log?.('icons: building render deps…');
        const { deps, dispose } = await Icons.buildRenderDeps(state.renderCtx, state.iconLoader);
        try {
            log?.('icons: rendering block atlas…');
            const atlas = await Icons.renderBlockIconAtlas(deps);
            if (atlas.atlasWidth > 0 && atlas.atlasHeight > 0) {
                log?.(`icons: encoding ${atlas.atlasWidth}x${atlas.atlasHeight} atlas → png…`);
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
                log?.(`icons: wrote resources/client/voxels-icons.png (${(png.byteLength / 1024).toFixed(0)}KB)`);
            } else {
                log?.('icons: empty block atlas (no renderable blocks)');
            }
            const prefabCount = await Icons.bakePrefabIcons(deps, fs, atlasChanged, encodeRgbaPng);
            if (prefabCount > 0) log?.(`icons: rendered ${prefabCount} prefab icon(s)`);
        } finally {
            dispose();
        }
    } catch (err) {
        log?.(`icons error: ${(err as Error).message}`);
        console.error('[edit-pipeline] icon render failed', err);
    } finally {
        state.renderingIcons = false;
    }
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
