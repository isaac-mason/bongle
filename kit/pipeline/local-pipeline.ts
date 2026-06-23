/**
 * kit/pipeline/local-pipeline.ts — in-process Node asset pipeline.
 *
 * The pipeline runs in the dev-server process via the `pipeline` runnable Vite
 * environment (like gameServer). We create the Dawn device + the disk/sharp
 * `ResourceLoader` here, then `runner.import` the `virtual:bongle/pipeline-worker`
 * boot entry — which drives `EngineAssetPipeline` in the runner's isolated module
 * graph (its own `env.client`, separate from gameServer's `env.server`).
 *
 * No DOM stub: `EngineAssetPipeline` touches no DOM, so the dev-server
 * globalThis only gets the (harmless) GPU* constants gpucat reads.
 */

import path from 'node:path';
import type { RunnableDevEnvironment, ViteDevServer } from 'vite';
import { create, globals } from 'webgpu';
import { PREFAB_ICONS, SCENE_ICONS, writeIconArtifact, writePerIdIcon } from '../asset-pipeline/icons-write';
import { createPipelineResourceLoader } from './resource-loader';
import type { PipelineBootContext, PipelineWorker } from '../runtime/pipeline-node';
import type { WorkerHandle } from './worker-handle';

// Keep the `create()` GPU instance referenced for the process lifetime — Dawn's
// background ProcessEvents pump segfaults on a GC'd instance.
const liveGpuInstances: unknown[] = [];

export async function initLocalPipeline(server: ViteDevServer, projectDir: string): Promise<WorkerHandle> {
    Object.assign(globalThis, globals);

    const gpu = create([]);
    liveGpuInstances.push(gpu);
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error('[local-pipeline] no GPU adapter');
    const device = await adapter.requestDevice();

    const resourcesClientDir = path.join(projectDir, 'resources', 'client');

    // After writing an icon artifact, notify the live editor client so it
    // re-fetches the updated thumbnail (its loadEditorAssets listens for this).
    const notifyIconsReady = (payload: { kind: string; id?: string }) => {
        server.environments.client?.hot.send('bongle:icons-ready', payload);
    };

    const ctx: Omit<PipelineBootContext, 'userEntry'> = {
        gpu: { device, adapter },
        resourceLoader: createPipelineResourceLoader(resourcesClientDir),
        writeBlockIcons: async (r, hash) => {
            await writeIconArtifact(resourcesClientDir, 'block-icons', {
                hash,
                iconPx: r.iconPx,
                cols: r.cols,
                rows: r.rows,
                atlasWidth: r.atlasWidth,
                atlasHeight: r.atlasHeight,
                coords: r.coords,
            }, r.pixels);
            notifyIconsReady({ kind: 'block-icons' });
        },
        writePerIdIcon: async (group, id, pxSize, pixels) => {
            await writePerIdIcon(resourcesClientDir, group === 'scenes' ? SCENE_ICONS : PREFAB_ICONS, id, pxSize, pixels);
            notifyIconsReady({ kind: group === 'scenes' ? 'scene-icon' : 'prefab-icon', id });
        },
    };

    const pipelineEnv = server.environments.pipeline as RunnableDevEnvironment;
    const mod = (await pipelineEnv.runner.import('virtual:bongle/pipeline-worker')) as {
        boot: (ctx: Omit<PipelineBootContext, 'userEntry'>) => Promise<PipelineWorker>;
    };
    const worker = await mod.boot(ctx);

    return new LocalWorkerHandle(worker);
}

/** Drives the in-process `PipelineWorker` directly — no transport. */
class LocalWorkerHandle implements WorkerHandle {
    constructor(private readonly worker: PipelineWorker) {}

    ready(): Promise<void> {
        return Promise.resolve();
    }

    bootId(): Promise<string> {
        return Promise.resolve(this.worker.bootId);
    }

    reload(): Promise<void> {
        return this.worker.bootEngine();
    }

    call<T = void>(verb: string, ...args: unknown[]): Promise<T> {
        const fn = (this.worker as unknown as Record<string, (...a: unknown[]) => Promise<T>>)[verb];
        if (typeof fn !== 'function') throw new Error(`[local-pipeline] unknown verb ${verb}`);
        return fn.apply(this.worker, args);
    }
}
