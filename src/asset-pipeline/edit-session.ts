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

import type { Filesystem } from '../../os/interface';
import { registerFlushHandler } from '../core/capture/flush';
import { type Config, serverMaxPlayers } from '../core/config';
import { registry, reindexRegistry } from '../core/registry';
import { createBrowserRaster } from './bake/raster-browser';
import { createBrowserDecodeAudio } from './decode-audio-browser';
import * as Icons from './icons';
import { createBakeLoader, createClientResourceLoader } from './loader';
import * as AssetPipeline from './pipeline';

export type BakeReport = {
    /** atlas bytes moved this pass — the caller tells the live client to refresh. */
    atlasChanged: boolean;
    /** latest declared launch config (the build manifest reads this). null when
     *  the config revision hasn't produced a value this session yet. */
    config: Config | null;
    /** derived per-room player cap for compat — server config → its maxPlayers,
     *  standalone → 1, absent config → null. */
    maxPlayers: number | null;
};

/** compat per-room cap: server config → its maxPlayers, standalone → 1, no
 *  config observed yet → null. */
function deriveMaxPlayers(config: Config | null): number | null {
    if (!config) return null;
    return serverMaxPlayers(config) ?? 1;
}

export type Driver = {
    /** the editor project filesystem: sidecars read from it, baked outputs written into it. */
    fs: Filesystem;
    /** called after every bake pass (flush-driven or run()-driven) with the result. */
    onBaked: (report: BakeReport) => void;
    /** optional progress log surfaced to the editor. */
    log?: (msg: string) => void;
    /** optional STDERR surfaced to the editor — a bake or icon-render failure. Kept
     *  distinct from `log` so a failure reads as one in the editor's log panel
     *  instead of scrolling past as another progress line (a worker's `console.error`
     *  reaches nobody). */
    err?: (msg: string) => void;
};

export type Opts = {
    mode: 'edit' | 'play';
    cache: boolean;
    /** forced render backend for the icon bake, forwarded from the editor's
     *  `?renderer=` on the session (the worker's `self.location` can't carry it).
     *  Absent → the offline seam probes the adapter, as the live client does. */
    renderer?: 'webgpu' | 'webgl';
};

export type State = {
    driver: Driver;
    pipeline: AssetPipeline.State;
    iconLoader: ReturnType<typeof createClientResourceLoader>;
    /** consult the on-disk hashes and skip fresh work (see `Opts.cache`); the
     *  icon bake's gate reads it the same way the atlas builders do. */
    cache: boolean;
    unregisterFlush: () => void;
    /** forced render backend for icon baking (see `Opts.renderer`). */
    renderer: 'webgpu' | 'webgl' | undefined;
    // guards: a bake / icon render in flight COALESCES an overlapping trigger onto a
    // trailing re-run instead of dropping it. Dropping was the bug: the boot icon
    // render holds the GPU for seconds (device handshake + pipeline compiles), and the
    // first edit almost always lands inside that window — its blocks then had no icon
    // until some unrelated later edit happened to arrive while the realm was idle.
    baking: boolean;
    /** a `run` requested while one was in flight, replayed when it finishes. */
    queuedBake: { forceAll: boolean } | null;
    // headless GPU render context, lazily created on first icon render (device handshake +
    // pipeline compiles are expensive + atlas-independent). null until then; a failed
    // handshake stays null + retries.
    renderCtx: Awaited<ReturnType<typeof Icons.createHeadlessRenderContext>> | null;
    renderingIcons: boolean;
    /** an icon render requested while one was in flight, replayed when it finishes. */
    queuedIcons: { atlasHash: string | null } | null;
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
        cache: opts.cache,
        unregisterFlush: () => {},
        renderer: opts.renderer,
        baking: false,
        queuedBake: null,
        renderCtx: null,
        renderingIcons: false,
        queuedIcons: null,
    };
    // Re-bake when the user's declarations change (HMR re-eval → flush). This is the
    // definite "declarations settled" signal, fired at the tail of the re-eval; keeping
    // the registration here (engine-internal) is what lets the editor worker stay a thin
    // driver that never imports bongle/internal.
    state.unregisterFlush = registerFlushHandler(() => run(state));
    return state;
}

/** One bake pass: the data bake (atlas / sprites / models / scenes / audio) plus the GPU
 *  icon render, reported via `onBaked`. Idempotent; a call landing mid-pass is coalesced
 *  onto a trailing re-run rather than dropped, since the flush that arrives during a pass
 *  is the one carrying the newest declarations and nothing else would re-fire it.
 *
 *  `forceAll` bypasses the pass's registry-revision gate: an asset-file edit moves no
 *  registry revision, so the caller (the pipeline realm's fs.watch) must force the pass
 *  for the builders' content-hash gates to see the new bytes. The flush path (code edits)
 *  leaves it off — a re-declare already bumps the revisions. A queued `forceAll` sticks:
 *  the replay has to be at least as thorough as the request it stood in for. */
export async function run(state: State, opts: { forceAll?: boolean } = {}): Promise<void> {
    if (state.baking) {
        state.queuedBake = { forceAll: (state.queuedBake?.forceAll ?? false) || (opts.forceAll ?? false) };
        return;
    }
    state.baking = true;
    try {
        let next: { forceAll: boolean } | null = { forceAll: opts.forceAll ?? false };
        while (next) {
            const { forceAll } = next;
            state.queuedBake = null;
            let atlasHash: string | null = null;
            try {
                const t0 = performance.now();
                const r = await AssetPipeline.run(state.pipeline, { forceAll });
                atlasHash = r.atlasHash;
                state.driver.log?.(
                    `bake ${(performance.now() - t0).toFixed(0)}ms — atlas ${r.atlasChanged ? 'changed' : 'unchanged'}`,
                );
                state.driver.onBaked({ atlasChanged: r.atlasChanged, config: r.config, maxPlayers: deriveMaxPlayers(r.config) });
            } catch (err) {
                state.driver.err?.(`bake error: ${(err as Error).message}`);
            }
            // icons render after the bake — own error boundary, deliberately NOT awaited: a GPU
            // handshake shouldn't gate the bake result or the caller's initial-bake promise.
            void renderIcons(state, atlasHash);
            next = state.queuedBake;
        }
    } finally {
        state.baking = false;
        state.queuedBake = null;
    }
}

export function dispose(state: State): void {
    state.unregisterFlush();
    AssetPipeline.dispose(state.pipeline);
}

// ── icon rendering (moved out of the editor's pipeline-worker; GPU/headless, browser) ──
// Render block (and prefab) icons for the current registry + baked atlas, written as
// first-class client assets under resources/client/ (voxels-icons.png + sidecar json) —
// shipped alongside the atlas so gameplay (inventory/hotbar) and the editor both read them
// from the same place. Fully isolated: an icon failure goes to stderr and never disturbs
// the bake.
async function renderIcons(state: State, atlasHash: string | null): Promise<void> {
    if (state.renderingIcons) {
        state.queuedIcons = { atlasHash };
        return;
    }
    state.renderingIcons = true;
    try {
        let next: { atlasHash: string | null } | null = { atlasHash };
        while (next) {
            state.queuedIcons = null;
            await renderIconsPass(state, next.atlasHash);
            next = state.queuedIcons;
        }
    } finally {
        state.renderingIcons = false;
        state.queuedIcons = null;
    }
}

/** One icon-render pass: gate, then draw exactly what the gate found stale. Never
 *  throws — an icon failure is reported and the next pass retries. */
async function renderIconsPass(state: State, atlasHash: string | null): Promise<void> {
    const { fs, log, err: reportErr } = state.driver;
    try {
        // the gate reads the DERIVED block registry, and this worker never calls
        // engine-client.load(). `buildRenderDeps` reindexes too, but that now runs
        // after the gate, so do it here or the gate reads a null blockRegistry.
        reindexRegistry(registry);
        // gate BEFORE the device handshake + atlas upload: most passes change no
        // block and no prefab, and the artifacts on disk are already what we'd draw.
        const plan = await Icons.planIconBake(fs, { atlasHash, cache: state.cache });
        if (Icons.iconBakeIsNoop(plan)) {
            // the one outcome that used to be silent, and the one you need when an
            // icon is missing: it says the gate looked and found the artifacts on
            // disk already current, so a missing icon after THIS line is a consumer
            // problem, not a bake that never ran.
            log?.('icons: up to date');
            return;
        }

        if (!state.renderCtx) {
            log?.('icons: creating headless render context…');
            state.renderCtx = await Icons.createHeadlessRenderContext(undefined, state.renderer);
            log?.('icons: render context ready');
        }
        log?.('icons: building render deps…');
        const { deps, dispose } = await Icons.buildRenderDeps(state.renderCtx, state.iconLoader);
        try {
            log?.(`icons: rendering ${plan.blockAtlasStale ? 'block atlas + ' : ''}${plan.stalePrefabs.length} prefab icon(s)…`);
            const result = await Icons.runIconBake(deps, fs, plan, encodeRgbaPng);
            log?.(`icons: wrote ${result.blockAtlas ? 'block atlas, ' : ''}${result.prefabs} prefab icon(s)`);
        } finally {
            dispose();
        }
    } catch (err) {
        // the icon bake is the ONE part of a pass that can fail on its own (a GPU
        // handshake, a device-lost mid-render) while the data bake succeeded, so it
        // must be legible: without block icons the palette just renders empty.
        reportErr?.(`icons error: ${(err as Error).message}`);
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
