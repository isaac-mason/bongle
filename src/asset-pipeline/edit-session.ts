import type { BakedArtifacts, Filesystem } from '../../os/interface';
import { registerFlushHandler } from '../core/capture/flush';
import { type Config, serverMaxPlayers } from '../core/config';
import { registry, reindexRegistry } from '../core/registry';
import { createBrowserRaster } from './bake/raster-browser';
import { createBrowserDecodeAudio } from './decode-audio-browser';
import * as Icons from './icons';
import { createBakeLoader, createClientResourceLoader } from './loader';
import * as AssetPipeline from './pipeline';

export type BakeReport = {
    /** what this session has left in `resources/`, so consumers re-read exactly
     *  what moved instead of watching the fs for it. */
    artifacts: BakedArtifacts;
    /** latest declared launch config (the build manifest reads this). null when
     *  the config revision hasn't produced a value this session yet. */
    config: Config | null;
    /** derived per-room player cap for compat: server config gives its maxPlayers,
     *  standalone gives 1, absent config gives null. */
    maxPlayers: number | null;
};

/** compat per-room cap: server config gives its maxPlayers, standalone gives 1, no
 *  config observed yet gives null. */
function deriveMaxPlayers(config: Config | null): number | null {
    if (!config) return null;
    return serverMaxPlayers(config) ?? 1;
}

export type Driver = {
    /** the editor project filesystem: sidecars read from it, baked outputs written into it. */
    fs: Filesystem;
    /** called with the session's artifacts every time they move. Fires more than
     *  once per pass: the icon render lands after the data bake (deliberately not
     *  awaited), so it reports again when it settles. */
    onBaked: (report: BakeReport) => void;
    /** optional progress log surfaced to the editor. */
    log?: (msg: string) => void;
    /** optional error stream surfaced to the editor for a bake or icon-render failure, kept
     *  distinct from `log` so a failure reads as one in the editor's log panel rather than
     *  scrolling past as another progress line. */
    err?: (msg: string) => void;
};

export type Opts = {
    mode: 'edit' | 'play';
    cache: boolean;
    /** forced render backend for the icon bake, forwarded from the editor's
     *  `?renderer=` on the session (the worker's `self.location` can't carry it).
     *  Absent means the offline seam probes the adapter, as the live client does. */
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
    /** everything a report carries, kept here because the data bake and the icon
     *  render finish at different times and each reports the current whole picture
     *  rather than its own slice. */
    artifacts: BakedArtifacts;
    config: Config | null;
    // a bake / icon render in flight coalesces an overlapping trigger onto a trailing re-run
    // instead of dropping it: the boot icon render holds the GPU for seconds (device handshake +
    // pipeline compiles), and the first edit almost always lands inside that window.
    baking: boolean;
    /** a `run` requested while one was in flight, replayed when it finishes. */
    queuedBake: { forceAll: boolean } | null;
    // headless GPU render context, lazily created on first icon render (device handshake +
    // pipeline compiles are expensive and atlas-independent). null until then; a failed
    // handshake stays null and retries.
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
        artifacts: { blocks: null, sprites: null, audio: null, blockIcons: null, prefabIcons: [] },
        config: null,
        baking: false,
        queuedBake: null,
        renderCtx: null,
        renderingIcons: false,
        queuedIcons: null,
    };
    // re-bake when the user's declarations change (HMR re-eval, flush). The registration
    // stays here (engine-internal) so the editor worker never imports bongle/internal.
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
 *  leaves it off, a re-declare already bumps the revisions. A queued `forceAll` sticks:
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
                state.config = r.config;
                state.artifacts = {
                    ...state.artifacts,
                    blocks: r.atlasHash,
                    sprites: r.spriteAtlasHash,
                    audio: r.audioAtlasHash,
                };
                // per-stage wall-clock alongside the total: the stages run in parallel behind
                // `draw`, so the longest one is the bake's critical path.
                const stages = Object.entries(r.timings)
                    .sort((a, b) => b[1] - a[1])
                    .map(([label, ms]) => `${label} ${ms.toFixed(0)}`)
                    .join(', ');
                state.driver.log?.(
                    `bake ${(performance.now() - t0).toFixed(0)}ms, atlas ${r.atlasChanged ? 'changed' : 'unchanged'}` +
                        (stages ? ` (${stages})` : ''),
                );
                report(state);
            } catch (err) {
                state.driver.err?.(`bake error: ${(err as Error).message}`);
            }
            // icons render after the bake with its own error boundary, deliberately not awaited: a
            // GPU handshake shouldn't gate the bake result or the caller's initial-bake promise.
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

// renders block (and prefab) icons for the current registry + baked atlas, written as
// first-class client assets under resources/client/ (voxels-icons.png + sidecar json), shipped
// alongside the atlas so gameplay (inventory/hotbar) and the editor both read them from the same
// place. Fully isolated: an icon failure goes to stderr and never disturbs the bake.
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
 *  throws, an icon failure is reported and the next pass retries. */
async function renderIconsPass(state: State, atlasHash: string | null): Promise<void> {
    const { fs, log, err: reportErr } = state.driver;
    try {
        // the gate reads the derived block registry, and this worker never calls
        // engine-client.load(), so reindex here or the gate reads a null blockRegistry
        // (`buildRenderDeps` reindexes too, but only after the gate runs).
        reindexRegistry(registry);
        // gate before the device handshake + atlas upload: most passes change no
        // block and no prefab, and the artifacts on disk are already what we'd draw.
        const plan = await Icons.planIconBake(fs, { atlasHash, cache: state.cache });
        if (Icons.iconBakeIsNoop(plan)) {
            log?.('icons: up to date');
            // still announce: a consumer that hasn't read the atlas yet (a client that just
            // connected) needs to be told it's current even though this pass drew nothing.
            announceIcons(state, plan.blockIconsHash, []);
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
            log?.(`icons: wrote ${result.blockAtlas ? 'block atlas, ' : ''}${result.prefabs.length} prefab icon(s)`);
            // announced only once both the png and its sidecar are written, since the two land
            // as separate writes and a consumer must never read half of one pass with half of the last.
            announceIcons(state, plan.blockIconsHash, result.prefabs);
        } finally {
            dispose();
        }
    } catch (err) {
        // the icon bake can fail on its own (a GPU handshake, a device-lost mid-render) while
        // the data bake succeeded, so it must be legible: without icons the palette renders empty.
        reportErr?.(`icons error: ${(err as Error).message}`);
    }
}

/** Announce the session's current artifacts. `prefabIcons` is edge-shaped (ids
 *  that moved this report), so it is cleared once sent, a later report must not
 *  re-announce an invalidation the consumer already applied. */
function report(state: State): void {
    const artifacts = state.artifacts;
    state.artifacts = { ...artifacts, prefabIcons: [] };
    state.driver.onBaked({ artifacts, config: state.config, maxPlayers: deriveMaxPlayers(state.config) });
}

/** Fold an icon pass's outputs into the session's artifacts and report them. */
function announceIcons(state: State, blockIcons: string | null, prefabIcons: string[]): void {
    state.artifacts = { ...state.artifacts, blockIcons, prefabIcons: [...state.artifacts.prefabIcons, ...prefabIcons] };
    report(state);
}

/** RGBA8 pixels to PNG bytes via OffscreenCanvas (worker-safe; no DOM canvas). */
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
