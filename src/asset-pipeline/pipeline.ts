/**
 * src/asset-pipeline/pipeline.ts, AssetPipeline, the one asset pipeline.
 *
 * It lives in the engine because it USES the engine: it reads the registries,
 * bakes assets (atlas/models/scenes/audio/sprites), and boots
 * `EngineAssetPipeline` to render icons. Reachable only through the
 * `engine-asset-pipeline` entrypoint (edit + build), so its Node deps
 * (sharp/skia/gltf/ffmpeg/Dawn) never enter the play bundles.
 *
 * Surface, the house pattern: `init(ctx) -> State`, `run(state) -> RunResult`,
 * `dispose(state)`, plus `assetSources(state)` for the dev file-watcher.
 *
 * One `run` is the whole job, start to end: bake (revision-gated per builder)
 * then, when `renderIcons`, render the dirty icons (hash-gated). One `State`
 * folds both gating machines + the lazily-booted render engine. No worker, no
 * transport, no reboot, it's an in-graph object that the bake either feeds in
 * place (`applyRegistryChanges` → `VoxelResources.refresh`) or, on the first
 * pass, boots once.
 *
 * The kit invokes it: the edit-server entrypoint sets it up, the dev plugin
 * runs it on each settled flush and forwards the `RunResult` to the browser,
 * and the build path runs it once with `renderIcons: false` (bake only, no GPU).
 */

import fs from 'node:fs';
import path from 'node:path';
import { __kit, buildBlockRegistry, registry, type ScenePayload } from '../internal';
import { readArtifactHashSync } from './bake/cache';
import { PREFAB_ICONS, SCENE_ICONS, writeIconArtifact, writePerIdIcon } from './bake/icons-write';
import {
    collectAssetSources,
    createPipelineState,
    type PipelineInternal,
    type PipelinePassTimings,
    type PipelineState,
    runAssetPipelinePass,
} from './bake/pass';
import { createPipelineResourceLoader } from './bake/resource-loader';
import * as EngineAssetPipeline from './engine';
import { computeBlockIconsHash, computePrefabIconHashes, computeSceneIconHashes } from './icon-hashes';

export type InitCtx = {
    projectDir: string;
    /** kit invocation mode, controls scene barrel discovery (see buildScenes). */
    mode: 'edit' | 'play';
    /** forwarded to the atlas builders as their `cache` option (true in dev HMR). */
    cache: boolean;
    /** edit: true (boot the engine, render icons); play build: false (bake only,
     *  no GPU device created). */
    renderIcons: boolean;
};

export type IconWritten = { kind: 'block-icons' | 'prefab-icon' | 'scene-icon'; id?: string };

export type RunResult = {
    /** per-builder bake wall-clock; absent key = builder skipped (nothing dirty). */
    timings: PipelinePassTimings;
    /** latest matchmaking config (the build manifest reads this). */
    matchmakingConfig: { maxPlayers: number } | null;
    /** atlas bytes moved this pass → caller tells the live client to refresh.
     *  `*Hash` is the post-pass sidecar hash the caller forwards on the wire. */
    atlasChanged: boolean;
    atlasHash: string | null;
    spriteAtlasChanged: boolean;
    spriteAtlasHash: string | null;
    /** audio manifest (atlas + standalone) moved this pass → caller tells the
     *  live client to re-fetch the manifest + atlas. hash is the manifest's
     *  combined `hash` field, read the same way as the atlas sidecars. */
    audioAtlasChanged: boolean;
    audioAtlasHash: string | null;
    /** icons written this pass → caller notifies the editor to re-fetch them. */
    iconsWritten: IconWritten[];
};

export type State = {
    ctx: InitCtx;
    /** typed registry view the bake reads, built from the engine's own barrel. */
    internal: PipelineInternal;
    /** bake revision gates + caches + matchmaking config. */
    bake: PipelineState;
    /** Dawn device, created on the first icon render; pinned for the process
     *  lifetime (Dawn's ProcessEvents pump segfaults on a GC'd instance). */
    gpu: { device: GPUDevice; adapter: GPUAdapter } | null;
    /** render engine, booted lazily on the first icon render. */
    engine: EngineAssetPipeline.State | null;
    // render gates, sceneId/prefabId/blockHash → last applied/rendered.
    appliedSceneHashes: Map<string, string>;
    lastBlockIconsHash: string | null;
    lastPrefabIconHashes: Map<string, string>;
    lastSceneIconHashes: Map<string, string>;
};

// Keep created Dawn instances referenced for the process lifetime, Dawn's
// background ProcessEvents pump segfaults on a GC'd instance.
const liveGpuInstances: unknown[] = [];

export function init(ctx: InitCtx): State {
    return {
        ctx,
        internal: { registry, buildBlockRegistry },
        bake: createPipelineState(),
        gpu: null,
        engine: null,
        appliedSceneHashes: new Map(),
        lastBlockIconsHash: null,
        lastPrefabIconHashes: new Map(),
        lastSceneIconHashes: new Map(),
    };
}

/** Run one full pass: bake, then (when `renderIcons`) render the dirty icons.
 *  Idempotent and internally gated, coalescing and when-to-fire are the
 *  caller's concern. */
export async function run(s: State, opts: { forceAll?: boolean } = {}): Promise<RunResult> {
    const { projectDir, mode, cache, renderIcons } = s.ctx;
    const dir = clientResourcesDir(s);
    const atlasJsonPath = path.join(dir, 'voxels-atlas.json');
    const spriteAtlasJsonPath = path.join(dir, 'sprites-atlas.json');
    // the audio manifest doubles as its own sidecar, its combined `hash` field
    // is exactly what readArtifactHashSync reads (see asset-pipeline/bake/audio.ts).
    const audioManifestPath = path.join(dir, 'audio-manifest.json');

    // ── bake ──
    const prevAtlasHash = readArtifactHashSync(atlasJsonPath);
    const prevSpriteAtlasHash = readArtifactHashSync(spriteAtlasJsonPath);
    const prevAudioAtlasHash = readArtifactHashSync(audioManifestPath);
    const timings = await runAssetPipelinePass(s.internal, { projectDir, mode, cache }, s.bake, {
        forceAll: opts.forceAll,
    });
    const atlasHash = readArtifactHashSync(atlasJsonPath);
    const spriteAtlasHash = readArtifactHashSync(spriteAtlasJsonPath);
    const audioAtlasHash = readArtifactHashSync(audioManifestPath);

    const result: RunResult = {
        timings,
        matchmakingConfig: s.bake.matchmakingConfig,
        atlasChanged: !!atlasHash && atlasHash !== prevAtlasHash,
        atlasHash,
        spriteAtlasChanged: !!spriteAtlasHash && spriteAtlasHash !== prevSpriteAtlasHash,
        spriteAtlasHash,
        audioAtlasChanged: !!audioAtlasHash && audioAtlasHash !== prevAudioAtlasHash,
        audioAtlasHash,
        iconsWritten: [],
    };

    // ── render icons (edit only) ──
    if (renderIcons) await renderIcons_(s, atlasHash, result);

    return result;
}

/** Files the pipeline reads off disk (gltf/png/ogg/...), the dev watcher uses
 *  this to force a pass when an asset's bytes change without a registry move. */
export function assetSources(s: State): Set<string> {
    return collectAssetSources(s.internal, s.ctx.projectDir);
}

export function dispose(s: State): void {
    if (s.engine) EngineAssetPipeline.dispose(s.engine);
    s.engine = null;
    // The GPU device + Dawn instance stay pinned for the process lifetime.
}

// ── internals ───────────────────────────────────────────────────────

function clientResourcesDir(s: State): string {
    return path.join(s.ctx.projectDir, 'resources', 'client');
}

async function renderIcons_(s: State, atlasHash: string | null, result: RunResult): Promise<void> {
    // The engine loads the atlas at boot, so the first render needs one on disk.
    // The bake above just wrote it; if there's still none (cold pass before any
    // blocks exist), defer, a later run with an atlas boots the engine then.
    if (!s.engine) {
        if (!atlasHash) return;
        await boot(s);
    }
    const engine = s.engine;
    if (!engine) return;

    // Atlas + registry edits land in place, no reboot.
    await EngineAssetPipeline.applyRegistryChanges(engine);

    // Scene corpus delta off disk (source of truth for which scenes exist).
    const current = scanScenes(s.ctx.projectDir);
    const currentIds = new Set(current.map((x) => x.id));
    const cleared: string[] = [];
    for (const id of s.appliedSceneHashes.keys()) if (!currentIds.has(id)) cleared.push(id);
    const deltas = current.filter((x) => s.appliedSceneHashes.get(x.id) !== x.bytesHash);

    for (const id of cleared) EngineAssetPipeline.clearScene(engine, id);
    for (const { id, payload } of deltas) {
        __kit.registerScene(id, payload);
        EngineAssetPipeline.applyScene(engine, id, payload);
    }
    if (cleared.length || deltas.length) await EngineAssetPipeline.applyRegistryChanges(engine);

    // Hash-gated icon render. Gating inputs fold in `atlasHash`, so a moved
    // atlas re-renders every icon.
    const dir = clientResourcesDir(s);
    const blockHash = computeBlockIconsHash(s.internal, atlasHash);
    if (blockHash !== s.lastBlockIconsHash) {
        const r = await EngineAssetPipeline.renderBlockIcons(engine);
        await writeIconArtifact(
            dir,
            'block-icons',
            {
                hash: blockHash,
                iconPx: r.iconPx,
                cols: r.cols,
                rows: r.rows,
                atlasWidth: r.atlasWidth,
                atlasHeight: r.atlasHeight,
                coords: r.coords,
            },
            r.pixels,
        );
        result.iconsWritten.push({ kind: 'block-icons' });
    }

    const prefabHashes = computePrefabIconHashes(s.internal, atlasHash);
    for (const { id, hash } of prefabHashes) {
        if (s.lastPrefabIconHashes.get(id) === hash) continue;
        const r = await EngineAssetPipeline.renderPrefabIcon(engine, id);
        await writePerIdIcon(dir, PREFAB_ICONS, id, r.pxSize, r.pixels);
        result.iconsWritten.push({ kind: 'prefab-icon', id });
    }

    const sceneHashes = computeSceneIconHashes(s.internal, atlasHash, current);
    for (const { id, hash } of sceneHashes) {
        if (s.lastSceneIconHashes.get(id) === hash) continue;
        const r = await EngineAssetPipeline.renderSceneIcon(engine, id);
        await writePerIdIcon(dir, SCENE_ICONS, id, r.pxSize, r.pixels);
        result.iconsWritten.push({ kind: 'scene-icon', id });
    }

    // Commit applied state. (No mid-flight atlas re-check: bake + render run in
    // one caller-serialized pass, so the atlas can't move under us.)
    for (const id of cleared) {
        s.appliedSceneHashes.delete(id);
        s.lastSceneIconHashes.delete(id);
    }
    for (const { id, bytesHash } of current) s.appliedSceneHashes.set(id, bytesHash);
    s.lastBlockIconsHash = blockHash;
    const currentPrefabIds = new Set(prefabHashes.map((x) => x.id));
    for (const id of Array.from(s.lastPrefabIconHashes.keys())) {
        if (!currentPrefabIds.has(id)) s.lastPrefabIconHashes.delete(id);
    }
    for (const { id, hash } of prefabHashes) s.lastPrefabIconHashes.set(id, hash);
    for (const { id, hash } of sceneHashes) s.lastSceneIconHashes.set(id, hash);
}

async function boot(s: State): Promise<void> {
    if (!s.gpu) {
        // Lazy + dynamic so `webgpu` (Dawn) is only loaded when icons are
        // rendered, the play build (`renderIcons: false`) never touches it.
        const { create, globals } = await import('webgpu');
        Object.assign(globalThis, globals);
        const gpu = create([]);
        liveGpuInstances.push(gpu);
        const adapter = await gpu.requestAdapter();
        if (!adapter) throw new Error('[asset-pipeline] no GPU adapter');
        const device = await adapter.requestDevice();
        s.gpu = { device, adapter };
    }
    s.engine = await EngineAssetPipeline.boot({
        gpu: s.gpu,
        resourceLoader: createPipelineResourceLoader(clientResourcesDir(s)),
    });
}

/** Walk `content/scenes/**` → `{ id, bytesHash, payload }` per `.scene.json`.
 *  Disk is the scene-corpus source of truth: both the apply/clear delta and the
 *  icon-hash inputs derive from it (the registry only catches up to new
 *  filesystem blueprints once the codegen barrel re-emits). */
function scanScenes(projectDir: string): Array<{ id: string; bytesHash: string; payload: ScenePayload }> {
    const scenesDir = path.join(projectDir, 'content', 'scenes');
    if (!fs.existsSync(scenesDir)) return [];

    const SCENE_EXT = '.scene.json';
    const out: Array<{ id: string; bytesHash: string; payload: ScenePayload }> = [];

    const walk = (current: string): void => {
        for (const ent of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, ent.name);
            if (ent.isDirectory()) {
                walk(full);
                continue;
            }
            if (!ent.isFile() || !ent.name.endsWith(SCENE_EXT)) continue;
            const rel = path.relative(scenesDir, full).split(path.sep).join('/');
            const id = rel.slice(0, -SCENE_EXT.length);
            let raw: string;
            try {
                raw = fs.readFileSync(full, 'utf-8');
            } catch {
                continue;
            }
            let payload: ScenePayload;
            try {
                const file = JSON.parse(raw) as { nodes: unknown; chunks?: unknown };
                payload = {
                    nodes: file.nodes as ScenePayload['nodes'],
                    voxels: file.chunks ? ({ chunks: file.chunks } as ScenePayload['voxels']) : null,
                };
            } catch {
                continue;
            }
            out.push({ id, bytesHash: djb2(raw), payload });
        }
    };
    walk(scenesDir);
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
}

function djb2(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
    return (h >>> 0).toString(16);
}
