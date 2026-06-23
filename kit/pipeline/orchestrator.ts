/**
 * Pipeline orchestrator — Node-side driver for the asset-pipeline worker.
 *
 * Holds applied state per worker boot (boot id, applied scene hashes, last
 * rendered artifact hashes) and dispatches verbs through the `WorkerHandle`
 * (the in-process `EngineAssetPipeline` surface; see
 * `kit/pipeline/local-pipeline.ts`). Transport-agnostic — the orchestrator
 * never knows the worker is in-process.
 *
 * Convention: `init(...) → State` + standalone fns taking state, matching
 * Registry / Content / EngineClient.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ScenePayload } from 'bongle/internal';
import { readArtifactHashSync } from '../cache';
import type { PipelineInternal } from '../asset-pipeline/pipeline';
import type { WorkerHandle } from './worker-handle';
import {
    computeBlockIconsHash,
    computePrefabIconHashes,
    computeSceneIconHashes,
} from './icon-hashes';

export type State = {
    worker: WorkerHandle;
    internal: PipelineInternal;
    projectDir: string;
    /** sceneId → on-disk bytes-hash of the .scene.json last applied to the
     *  worker. Drives the apply/clear delta on each pass. */
    appliedSceneHashes: Map<string, string>;
    lastBlockIconsHash: string | null;
    /** prefabId → last rendered icon hash. */
    lastPrefabIconHashes: Map<string, string>;
    /** sceneId → last rendered icon hash. */
    lastSceneIconHashes: Map<string, string>;
    /** worker's bootId from the last successful pass — wipes on mismatch. */
    lastBootId: string | null;
    /** atlas hash the current worker booted against. Drives the at-the-top
     *  reload check: if disk atlas != this, reload before doing anything. */
    lastBootAtlasHash: string | null;
    /** mutex around runOnePass: bool semaphore + queued flag for coalescing. */
    busy: boolean;
    queued: boolean;
};

export function init(worker: WorkerHandle, internal: PipelineInternal, projectDir: string): State {
    return {
        worker,
        internal,
        projectDir,
        appliedSceneHashes: new Map(),
        lastBlockIconsHash: null,
        lastPrefabIconHashes: new Map(),
        lastSceneIconHashes: new Map(),
        lastBootId: null,
        lastBootAtlasHash: null,
        busy: false,
        queued: false,
    };
}

/** Schedule a render pass. Coalesces concurrent triggers into a single pass
 *  plus at most one tail pass — same pattern as the previous browser-side
 *  flush handler.
 *
 *  This is the ONLY trigger the asset pipeline calls. Atlas changes,
 *  scene-file writes, and registry-driven inputs all route through here;
 *  the pass itself decides whether a worker re-boot is needed (atlas hash
 *  moved since last boot) before dispatching any verbs. That makes the
 *  re-boot race-free: it can only happen with the lock held, before any
 *  in-flight render exists. */
export async function scheduleRender(s: State): Promise<void> {
    if (s.busy) {
        s.queued = true;
        return;
    }
    s.busy = true;
    try {
        do {
            s.queued = false;
            try {
                await runOnePass(s);
            } catch (err) {
                console.error('[bongle:orchestrator] pass failed:', err);
            }
        } while (s.queued);
    } finally {
        s.busy = false;
    }
}

async function runOnePass(s: State): Promise<void> {
    // 1. Wait for the worker surface to be exposed (post-userEntry import).
    await s.worker.ready();

    // per-pass timing — render runs on the dev-server event loop (in-process),
    // so surfacing each HMR re-render's cost is how we'd notice editor jank.
    const passStart = performance.now();
    let rebooted = false;

    // 2. Atlas-staleness re-boot check. The worker loads the TextureArray
    //    once at boot, so an atlas-bytes change requires a re-boot to pick
    //    up the new tiles. We do this BEFORE dispatching any verbs so nothing
    //    in-flight can race it. After re-boot, bootId rotates and the next
    //    step's mismatch branch re-boots + wipes.
    const atlasHashBefore = readArtifactHashSync(
        path.join(s.projectDir, 'resources', 'client', 'voxels-atlas.json'),
    );
    if (atlasHashBefore && s.lastBootAtlasHash !== null && atlasHashBefore !== s.lastBootAtlasHash) {
        try {
            await s.worker.reload();
            rebooted = true;
        } catch (err) {
            console.warn('[bongle:orchestrator] worker reload failed:', err);
        }
        await s.worker.ready();
    }

    // 3. Detect worker reload (atlas-driven above, or any external cause)
    //    via bootId. New id ⇒ wipe applied state + re-boot the engine.
    const bootId = await s.worker.bootId();
    if (bootId !== s.lastBootId) {
        if (!atlasHashBefore) {
            // First pipeline pass hasn't landed an atlas yet. Schedule a
            // retry — the asset pipeline trigger will re-call scheduleRender
            // once an atlas exists.
            return;
        }
        await s.worker.call('bootEngine');
        rebooted = true;
        s.lastBootId = bootId;
        s.lastBootAtlasHash = atlasHashBefore;
        s.appliedSceneHashes.clear();
        s.lastBlockIconsHash = null;
        s.lastPrefabIconHashes.clear();
        s.lastSceneIconHashes.clear();
    }

    // 4. Drain registry pendingChanges so any HMR-delivered upserts that
    //    landed on the worker between the last pass and this one reach the
    //    engine before we render against it.
    await s.worker.call('applyRegistryChanges');

    // 5. Scene deltas — walk content/scenes/**, hash bytes per file. Disk
    //    is the source of truth for the scene corpus (the gameServer's
    //    registry only catches up to new blueprints once the codegen
    //    barrel re-emits).
    const current = scanScenes(s.projectDir);
    const currentIds = new Set(current.map((x) => x.id));
    const cleared: string[] = [];
    for (const id of s.appliedSceneHashes.keys()) {
        if (!currentIds.has(id)) cleared.push(id);
    }
    const deltas = current.filter((x) => s.appliedSceneHashes.get(x.id) !== x.bytesHash);

    // 6. Apply deltas one verb at a time; drain at the end.
    for (const id of cleared) await s.worker.call('clearScene', id);
    for (const { id, payload } of deltas) await s.worker.call('applyScene', id, payload);
    if (cleared.length || deltas.length) {
        await s.worker.call('applyRegistryChanges');
    }

    // 7. Render verbs — Node decides via hash.
    let blockRendered = false;
    let prefabsRendered = 0;
    let scenesRendered = 0;

    const blockHash = computeBlockIconsHash(s.internal, atlasHashBefore);
    if (blockHash !== s.lastBlockIconsHash) {
        await s.worker.call('renderBlockIcons', blockHash);
        blockRendered = true;
    }
    // hashes gate dispatch in-memory (no on-disk sidecar); the worker just
    // renders + writes the PNG, so the hash never leaves Node.
    const prefabHashes = computePrefabIconHashes(s.internal, atlasHashBefore);
    for (const { id, hash } of prefabHashes) {
        if (s.lastPrefabIconHashes.get(id) === hash) continue;
        await s.worker.call('renderPrefabIcon', id);
        prefabsRendered++;
    }
    const sceneHashes = computeSceneIconHashes(s.internal, atlasHashBefore, current);
    for (const { id, hash } of sceneHashes) {
        if (s.lastSceneIconHashes.get(id) === hash) continue;
        await s.worker.call('renderSceneIcon', id);
        scenesRendered++;
    }

    // Per-pass timing. Skip no-op passes (hash-gated — nothing rendered or
    // re-booted) so this only fires when there's real work to report.
    if (rebooted || blockRendered || prefabsRendered || scenesRendered) {
        const parts: string[] = [];
        if (rebooted) parts.push('reboot');
        if (blockRendered) parts.push('block-icons');
        if (prefabsRendered) parts.push(`${prefabsRendered} prefab${prefabsRendered > 1 ? 's' : ''}`);
        if (scenesRendered) parts.push(`${scenesRendered} scene${scenesRendered > 1 ? 's' : ''}`);
        console.log(`[bongle:pipeline] ${parts.join(' + ')} in ${(performance.now() - passStart).toFixed(0)}ms`);
    }

    // 8. Mid-flight rebuild check. If the asset pipeline rewrote the atlas
    //    while we were rendering, worker may have read stale bytes — re-queue
    //    and don't commit applied state. The next pass's reload check (step
    //    2) will pick up the new hash and reboot.
    const atlasHashAfter = readArtifactHashSync(
        path.join(s.projectDir, 'resources', 'client', 'voxels-atlas.json'),
    );
    if (atlasHashAfter !== atlasHashBefore) {
        s.queued = true;
        return;
    }

    // 9. Commit applied state.
    for (const id of cleared) {
        s.appliedSceneHashes.delete(id);
        s.lastSceneIconHashes.delete(id);
    }
    for (const { id, bytesHash } of current) s.appliedSceneHashes.set(id, bytesHash);
    s.lastBlockIconsHash = blockHash;
    // prune prefab ids no longer in the registry, then record the rest. (the
    // stale PNG lingers on disk — same as scenes; nothing references it.)
    const currentPrefabIds = new Set(prefabHashes.map((x) => x.id));
    for (const id of Array.from(s.lastPrefabIconHashes.keys())) {
        if (!currentPrefabIds.has(id)) s.lastPrefabIconHashes.delete(id);
    }
    for (const { id, hash } of prefabHashes) s.lastPrefabIconHashes.set(id, hash);
    for (const { id, hash } of sceneHashes) s.lastSceneIconHashes.set(id, hash);
}

/** Walk `content/scenes/**` and produce `{ id, bytesHash, payload }` for
 *  each `.scene.json`. This is the scene-corpus source of truth — both the
 *  apply/clear delta and the icon-hash inputs derive from it. The
 *  gameServer registry intentionally isn't consulted here: it only catches
 *  up to filesystem-discovered blueprints once the codegen barrel
 *  re-emits, and routing icons through it would lose the race. */
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
            // hash the on-disk bytes so any edit (including non-content
            // edits like reorder/format) triggers a re-apply. Cheap (~µs
            // for typical scene sizes).
            const bytesHash = djb2(raw);
            out.push({ id, bytesHash, payload });
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
