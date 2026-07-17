/// <reference types="vite/client" />
// cli/dev/vite/runtime/pipeline.ts — the asset-pipeline realm for `bongle dev`,
// booted in the `pipeline` Vite env (a RunnableDevEnvironment in node). It
// evaluates the user code (so it owns the registry the AssetPipeline reads) and
// re-bakes on the SAME __kit flush that HMR fires — so a CODE edit (a block(),
// blockTexture(), sprite/model/sound decl) re-bakes just like an asset-file edit
// (start.ts calls rebake() for those). One trigger for both.
//
// Runs the DATA bake only (atlas / sprites / models / audio) — NOT the webgpu icon
// render, which would load Dawn into this long-lived process (segfault). Icons are
// produced by the startup child-bake + `bongle build`. After each bake, onBaked →
// start.ts emits the HMR refresh events the edit-client listens for.

import { AssetPipeline } from 'bongle/engine-asset-pipeline';
import { env } from 'bongle/env';
import { __kit } from 'bongle/internal';
import { createBakeLoader } from '../../../../src/asset-pipeline/loader';
import { createNodeDecodeAudio } from '../../../pipeline/decode-audio-node';
import { createNodeRaster } from '../../../pipeline/raster-node';
import { openNodeFs } from '../../../node-fs';

export type BakeSummary = { atlasChanged: boolean; spriteAtlasChanged: boolean; audioAtlasChanged: boolean };

export type StartPipelineOptions = {
    projectDir: string;
    userEntry: () => Promise<unknown>;
    /** called after every bake with what moved → start.ts fans HMR refresh events. */
    onBaked: (r: BakeSummary) => void;
};

export type PipelineBootResult = {
    /** run one bake pass now (start.ts calls this on asset-file change). */
    rebake: () => Promise<void>;
    stop: () => void;
};

export async function start(opts: StartPipelineOptions): Promise<PipelineBootResult> {
    // the pipeline mirrors the server's compile-time env (render path is
    // env-agnostic); set before user code so declarations see it.
    env.client = false;
    env.server = true;
    env.editor = true;
    await opts.userEntry();

    const fs = openNodeFs(opts.projectDir);
    const pipeline = AssetPipeline.init({
        mode: 'edit',
        cache: true, // incremental — re-bake only what the revision gate says changed
        fs,
        loader: createBakeLoader(fs),
        raster: createNodeRaster(),
        decodeAudio: createNodeDecodeAudio(),
    });

    let baking = false;
    const rebake = async (): Promise<void> => {
        if (baking) return;
        baking = true;
        try {
            const r = await AssetPipeline.run(pipeline, {});
            opts.onBaked({ atlasChanged: r.atlasChanged, spriteAtlasChanged: r.spriteAtlasChanged, audioAtlasChanged: r.audioAtlasChanged });
        } catch (err) {
            console.error(`[dev:pipeline] bake failed: ${(err as Error).message}`);
        } finally {
            baking = false;
        }
    };

    // re-bake on every settled registry change AFTER boot (a user block()/texture
    // edit → HMR cascade → flush → here). The initial flush is skipped — the
    // startup child-bake already produced the cold resources (incl. icons).
    let firstFlush = true;
    __kit.registerFlush(() => {
        if (firstFlush) {
            firstFlush = false;
            return;
        }
        void rebake();
    });
    __kit.flush();

    return { rebake, stop: () => {} };
}
