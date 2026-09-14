import type { Filesystem } from '../../os/interface';
import type { Config } from '../core/config';
import type { ResourceLoader } from '../core/resource-loader';
import { buildBlockRegistry, createBlockRegistry, registry } from '../internal';
import { readArtifactHash } from './bake/cache';
import type { DecodeAudio } from './bake/decode-audio';
import {
    createPipelineState,
    type PipelineInternal,
    type PipelinePassTimings,
    type PipelineState,
    runAssetPipelinePass,
} from './bake/pass';
import type { Raster } from './bake/raster';

/** baked-output root, project-relative on the ctx filesystem. */
const CLIENT_RESOURCES_DIR = 'resources/client';

export type InitCtx = {
    /** bake invocation mode, controls scene barrel discovery (see buildScenes). */
    mode: 'edit' | 'play';
    /** forwarded to the atlas builders as their `cache` option (true in dev HMR). */
    cache: boolean;
    /** the editor project filesystem: sidecars read from it, baked outputs
     *  written into it. host-provided (browser: OPFS or memory). */
    fs: Filesystem;
    /** bake-input byte loader: registry `src` refs (URLs / project-relative
     *  paths) to bytes. host-provided. */
    loader: ResourceLoader;
    /** audio decode for the audio bake (bytes to per-channel s16 PCM).
     *  host-provided (browser: OfflineAudioContext). See bake/decode-audio.ts. */
    decodeAudio: DecodeAudio;
    /** 2d raster for the atlas bakes (decode/scale/composite/encode images).
     *  host-provided (browser: OffscreenCanvas; node: @napi-rs/canvas). See
     *  bake/raster.ts. */
    raster: Raster;
};

export type RunResult = {
    /** per-builder bake wall-clock; absent key = builder skipped (nothing dirty). */
    timings: PipelinePassTimings;
    /** latest launch config (the build manifest reads this). */
    config: Config | null;
    /** atlas bytes moved this pass, caller tells the live client to refresh.
     *  `*Hash` is the post-pass sidecar hash the caller forwards on the wire. */
    atlasChanged: boolean;
    atlasHash: string | null;
    spriteAtlasChanged: boolean;
    spriteAtlasHash: string | null;
    /** audio manifest (atlas + standalone) moved this pass, caller tells the
     *  live client to re-fetch the manifest + atlas. hash is the manifest's
     *  combined `hash` field, read the same way as the atlas sidecars. */
    audioAtlasChanged: boolean;
    audioAtlasHash: string | null;
};

export type State = {
    ctx: InitCtx;
    /** typed registry view the bake reads, built from the engine's own barrel. */
    internal: PipelineInternal;
    /** bake revision gates + caches + launch config. */
    bake: PipelineState;
};

export function init(ctx: InitCtx): State {
    return {
        ctx,
        internal: { registry, createBlockRegistry, buildBlockRegistry },
        bake: createPipelineState(),
    };
}

/** Run one bake pass. Idempotent and internally revision-gated; coalescing
 *  and when-to-fire are the caller's concern. */
export async function run(s: State, opts: { forceAll?: boolean } = {}): Promise<RunResult> {
    const { mode, cache, fs, loader, decodeAudio, raster } = s.ctx;
    const atlasJsonPath = `${CLIENT_RESOURCES_DIR}/voxels-atlas.json`;
    const spriteAtlasJsonPath = `${CLIENT_RESOURCES_DIR}/sprites-atlas.json`;
    // the audio manifest doubles as its own sidecar, its combined `hash` field
    // is exactly what readArtifactHash reads (see bake/audio.ts).
    const audioManifestPath = `${CLIENT_RESOURCES_DIR}/audio-manifest.json`;

    const prevAtlasHash = await readArtifactHash(fs, atlasJsonPath);
    const prevSpriteAtlasHash = await readArtifactHash(fs, spriteAtlasJsonPath);
    const prevAudioAtlasHash = await readArtifactHash(fs, audioManifestPath);
    const timings = await runAssetPipelinePass(s.internal, { mode, cache, fs, loader, decodeAudio, raster }, s.bake, {
        forceAll: opts.forceAll,
    });
    const atlasHash = await readArtifactHash(fs, atlasJsonPath);
    const spriteAtlasHash = await readArtifactHash(fs, spriteAtlasJsonPath);
    const audioAtlasHash = await readArtifactHash(fs, audioManifestPath);

    return {
        timings,
        config: s.bake.config,
        atlasChanged: !!atlasHash && atlasHash !== prevAtlasHash,
        atlasHash,
        spriteAtlasChanged: !!spriteAtlasHash && spriteAtlasHash !== prevSpriteAtlasHash,
        spriteAtlasHash,
        audioAtlasChanged: !!audioAtlasHash && audioAtlasHash !== prevAudioAtlasHash,
        audioAtlasHash,
    };
}

export function dispose(_s: State): void {
    // nothing to tear down: no GPU, no worker, no open handles.
}
