// lib/cli/bake/bake.ts — the node asset bake: the host-neutral AssetPipeline
// (src/asset-pipeline) driven from node, the mirror of the browser pipeline
// realm (editor/realms/pipeline/pipeline-worker.ts).
//
// Registry eval, node-style: the browser evaluates user code via a ModuleRunner;
// node just `import()`s the project's src/index.ts (tsx strips the types). The
// full bongle barrel imports clean in node — no DOM at module-eval — so the
// declarations register into the same engine registry singleton AssetPipeline
// reads (one instance: the `bongle` bin IS the project's own dep). import.meta.url
// stays the real project path, so `new URL('./x.png', import.meta.url)` asset refs
// resolve correctly.
//
// Icons (the GPU thumbnail step) are NOT run here — that's the optional `webgpu`
// peer path. This is the pure data bake: atlas / sprites / models / scenes / audio.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Filesystem } from '../../src/asset-pipeline/filesystem';
import { createBakeLoader } from '../../src/asset-pipeline/loader';
import { openNodeFs } from '../node-fs';
import { createNodeDecodeAudio } from './decode-audio-node';
import { renderBlockIcons } from './icons-node';
import { createNodeRaster } from './raster-node';

// Resolve a subpath of the PROJECT's own bongle install. Registry-bearing engine
// modules (registry / __bongle / AssetPipeline) MUST be the project's instance — the
// same one the user's `import 'bongle'` declarations register into — so we import
// them from projectRoot/node_modules/bongle, not lib's copy. (In a real
// `npm i bongle`, the `bongle` bin IS this dep, so they're one and the same; this
// makes dev match that.) Stateless capabilities (fs / loader / raster) stay
// lib-side — they hold no registry, so a separate instance is harmless.
function bongleEntry(projectRoot: string) {
    const dir = resolve(projectRoot, 'node_modules/bongle');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        exports: Record<string, string | { import?: string; default?: string }>;
    };
    return (name: string): string => {
        const e = pkg.exports[name];
        const target = typeof e === 'string' ? e : (e?.import ?? e?.default);
        if (!target) throw new Error(`[bongle] project's bongle has no "${name}" export`);
        return pathToFileURL(resolve(dir, target)).href;
    };
}

export type BakeResult = {
    matchmaking: { maxPlayers: number } | null;
    atlasChanged: boolean;
    spriteAtlasChanged: boolean;
    audioAtlasChanged: boolean;
};

/** evaluate the project's declarations then run one bake pass into
 *  resources/client on the given fs. Returns what moved + the matchmaking config
 *  read off the registry (the build manifest needs it). */
export async function bake(fs: Filesystem, projectRoot: string): Promise<BakeResult> {
    const entry = bongleEntry(projectRoot);

    // evaluate user declarations → register into the project bongle's registry.
    await import(pathToFileURL(resolve(projectRoot, 'src/index.ts')).href);

    // the SAME engine instance the declarations registered into.
    const { registry, __bongle } = (await import(entry('./internal'))) as typeof import('../../src/internal');
    const { AssetPipeline, Icons } = (await import(
        entry('./engine-asset-pipeline')
    )) as typeof import('../../src/asset-pipeline');
    __bongle.flush();

    const pipeline = AssetPipeline.init({
        mode: 'edit',
        cache: false, // one-shot: always bake (no HMR revision gate)
        fs,
        loader: createBakeLoader(fs),
        raster: createNodeRaster(),
        decodeAudio: createNodeDecodeAudio(),
    });
    const r = await AssetPipeline.run(pipeline, { forceAll: true });

    // GPU icon render (block thumbnails) — optional, after the data bake wrote the
    // atlas it reads. Own error boundary: an icon failure never fails the bake.
    try {
        await renderBlockIcons(fs, Icons);
    } catch (err) {
        console.log(`  · icons: render failed (skipped) — ${(err as Error).message}`);
    }

    return {
        matchmaking: registry.matchmaking.byId.get('main') ?? null,
        atlasChanged: r.atlasChanged,
        spriteAtlasChanged: r.spriteAtlasChanged,
        audioAtlasChanged: r.audioAtlasChanged,
    };
}

/** `bongle bake <project>` — standalone bake (also runs inside `bongle build`). */
export async function bakeCommand(projectDir: string): Promise<void> {
    const root = resolve(projectDir);
    const t0 = performance.now();
    const r = await bake(openNodeFs(root), root);
    console.log(
        `✓ baked in ${(performance.now() - t0).toFixed(0)}ms — atlas ${r.atlasChanged ? 'changed' : '—'}, sprites ${r.spriteAtlasChanged ? 'changed' : '—'}, audio ${r.audioAtlasChanged ? 'changed' : '—'}`,
    );
}
