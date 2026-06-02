/**
 * kit/runtime/pipeline.ts — persistent-puppeteer worker page driven by the
 * Node-side orchestrator (kit/pipeline/orchestrator.ts).
 *
 * Loaded by the `<script>` tag in `<project>/.bongle/pipeline.html` via
 * the `virtual:bongle/pipeline` virtual module (served by
 * `kit/vite/virtual-entries.ts`). It imports user code so the Vite HMR
 * cascade populates the engine's registries; then exposes a tightly-
 * scoped RPC surface on `window.__bongle_worker`. The orchestrator drives
 * boot, scene application, registry drain, and icon renders — this file
 * makes zero decisions about *when* to render or *what* to fetch.
 *
 * Always edit context — the only caller is dev-mode bongle:pipeline.
 */

import { env } from 'bongle';
import { EngineClient } from 'bongle/engine-client';
import { runBlockIcons, runPrefabIcons, runSceneIcon } from 'bongle/offline-renderer';
import { __kit, type ScenePayload } from 'bongle/internal';
import type { WorkerApi } from '../pipeline/worker-api';

export type StartOptions = {
    userEntry: () => Promise<unknown>;
};

export async function start(opts: StartOptions) {
    env.client = true;
    env.server = false;
    env.editor = true;

    // Importing user code drives the declarative registries to a populated
    // state. Vite HMR keeps them current — see plugin.ts header docs.
    await opts.userEntry();

    // matchmake() throws — the pipeline page never re-matchmakes; if it
    // fires it's a wiring bug we want loud.
    let state: EngineClient | null = null;

    const bootId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        ? crypto.randomUUID()
        : String(Math.random()).slice(2);

    const worker: WorkerApi = {
        bootId,

        async bootEngine() {
            state = EngineClient.init({
                mode: 'edit',
                driver: {
                    matchmake() {
                        throw new Error('[pipeline] driver.matchmake invoked on pipeline page — wiring bug');
                    },
                },
            });
            __kit.pipeline();
            await EngineClient.load(state);
        },

        async applyScene(id: string, payload: ScenePayload) {
            __kit.registerScene(id, payload);
            if (state) EngineClient.applyScenePayload(state, id, payload);
        },

        async clearScene(id: string) {
            if (state) EngineClient.clearScene(state, id);
        },

        async applyRegistryChanges() {
            if (state) await EngineClient.applyRegistryChanges(state);
        },

        async renderBlockIcons(hash: string) {
            if (!state) throw new Error('[pipeline] renderBlockIcons before bootEngine');
            const result = await runBlockIcons(state);
            await emitIconAtlas('block-icons', hash, result);
        },

        async renderPrefabIcons(hash: string) {
            if (!state) throw new Error('[pipeline] renderPrefabIcons before bootEngine');
            const result = await runPrefabIcons(state);
            await emitIconAtlas('prefab-icons', hash, result);
        },

        async renderSceneIcon(id: string, hash: string) {
            if (!state) throw new Error('[pipeline] renderSceneIcon before bootEngine');
            const result = await runSceneIcon(state, id);
            await emitSceneIcon(id, hash, result.pxSize, result.pixels);
        },
    };

    (globalThis as unknown as { __bongle_worker: WorkerApi }).__bongle_worker = worker;
    (globalThis as unknown as { __bongle_worker_ready: boolean }).__bongle_worker_ready = true;
}

type IconAtlasResult = {
    pixels: Uint8Array;
    atlasWidth: number;
    atlasHeight: number;
    coords: Record<string, [number, number]>;
    iconPx: number;
    cols: number;
    rows: number;
};

async function emitIconAtlas(kind: 'block-icons' | 'prefab-icons', hash: string, artifact: IconAtlasResult) {
    const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'X-Manifest': JSON.stringify({
            hash,
            iconPx: artifact.iconPx,
            cols: artifact.cols,
            rows: artifact.rows,
            atlasWidth: artifact.atlasWidth,
            atlasHeight: artifact.atlasHeight,
            coords: artifact.coords,
        }),
    };
    const body = pixelsToArrayBuffer(artifact.pixels);
    await fetch('/__bongle/pipeline/emit?kind=' + kind, { method: 'POST', headers, body });
}

async function emitSceneIcon(id: string, hash: string, pxSize: number, pixels: Uint8Array): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    const body = pixelsToArrayBuffer(pixels);
    const q = '?kind=scene-icon&id=' + encodeURIComponent(id) + '&hash=' + encodeURIComponent(hash) + '&px=' + pxSize;
    await fetch('/__bongle/pipeline/emit' + q, { method: 'POST', headers, body });
}

function pixelsToArrayBuffer(pixels: Uint8Array): ArrayBuffer {
    if (pixels.byteOffset === 0 && pixels.byteLength === pixels.buffer.byteLength) {
        return pixels.buffer;
    }
    return pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength);
}
