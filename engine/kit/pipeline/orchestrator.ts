/**
 * Pipeline orchestrator — Node-side driver for the puppeteer worker page.
 *
 * Holds applied state per page-load (boot id, applied scene hashes, last
 * rendered artifact hashes) and dispatches RPC verbs to
 * `window.__bongle_worker` exposed by `kit/runtime/pipeline.ts`. Replaces
 * the browser-side flush handler + REST polling + HMR custom events from
 * the previous architecture. See plan-pipeline-orchestrator.md.
 *
 * Convention: `init(...) → State` + standalone fns taking state, matching
 * Registry / Content / EngineClient.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'puppeteer';
import type { ScenePayload } from 'bongle/internal';
import { readArtifactHashSync } from '../cache';
import type { PipelineInternal } from '../asset-pipeline/pipeline';
import {
    computeBlockIconsHash,
    computePrefabIconsHash,
    computeSceneIconHashes,
} from './icon-hashes';

export type State = {
    page: Page;
    internal: PipelineInternal;
    projectDir: string;
    /** sceneId → on-disk bytes-hash of the .scene.json last applied to the
     *  worker. Drives the apply/clear delta on each pass. */
    appliedSceneHashes: Map<string, string>;
    lastBlockIconsHash: string | null;
    lastPrefabIconsHash: string | null;
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

export function init(page: Page, internal: PipelineInternal, projectDir: string): State {
    return {
        page,
        internal,
        projectDir,
        appliedSceneHashes: new Map(),
        lastBlockIconsHash: null,
        lastPrefabIconsHash: null,
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
 *  the pass itself decides whether a page reload is needed (atlas hash
 *  moved since last boot) before dispatching any verbs. That makes the
 *  reload race-free: it can only happen with the lock held, before any
 *  in-flight fetch/render exists. */
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
    await waitForWorkerReady(s.page);

    // 2. Atlas-staleness reload check. The worker loads the TextureArray
    //    once at boot, so an atlas-bytes change requires a page reload to
    //    pick up the new tiles. We do this BEFORE dispatching any verbs so
    //    no in-flight fetch can race the reload. After reload, bootId
    //    rotates and the next step's mismatch branch re-boots + wipes.
    const atlasHashBefore = readArtifactHashSync(
        path.join(s.projectDir, 'resources', 'client', 'voxels-atlas.json'),
    );
    if (atlasHashBefore && s.lastBootAtlasHash !== null && atlasHashBefore !== s.lastBootAtlasHash) {
        try {
            await s.page.reload({ waitUntil: 'load' });
        } catch (err) {
            console.warn('[bongle:orchestrator] page.reload failed:', err);
        }
        await waitForWorkerReady(s.page);
    }

    // 3. Detect page reload (atlas-driven above, or any external cause)
    //    via bootId. New id ⇒ wipe applied state + re-boot the engine.
    const bootId = await callWorker<string>(s.page, '__GET_bootId');
    if (bootId !== s.lastBootId) {
        if (!atlasHashBefore) {
            // First pipeline pass hasn't landed an atlas yet. Schedule a
            // retry — the asset pipeline trigger will re-call scheduleRender
            // once an atlas exists.
            return;
        }
        await callWorker(s.page, 'bootEngine');
        s.lastBootId = bootId;
        s.lastBootAtlasHash = atlasHashBefore;
        s.appliedSceneHashes.clear();
        s.lastBlockIconsHash = null;
        s.lastPrefabIconsHash = null;
        s.lastSceneIconHashes.clear();
    }

    // 4. Drain registry pendingChanges so any HMR-delivered upserts that
    //    landed on the worker between the last pass and this one reach the
    //    engine before we render against it.
    await callWorker(s.page, 'applyRegistryChanges');

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
    for (const id of cleared) await callWorker(s.page, 'clearScene', id);
    for (const { id, payload } of deltas) await callWorker(s.page, 'applyScene', id, payload);
    if (cleared.length || deltas.length) {
        await callWorker(s.page, 'applyRegistryChanges');
    }

    // 7. Render verbs — Node decides via hash.
    const blockHash = computeBlockIconsHash(s.internal, atlasHashBefore);
    if (blockHash !== s.lastBlockIconsHash) {
        await callWorker(s.page, 'renderBlockIcons', blockHash);
    }
    const prefabHash = computePrefabIconsHash(s.internal, atlasHashBefore);
    if (prefabHash !== s.lastPrefabIconsHash) {
        await callWorker(s.page, 'renderPrefabIcons', prefabHash);
    }
    const sceneHashes = computeSceneIconHashes(s.internal, atlasHashBefore, current);
    for (const { id, hash } of sceneHashes) {
        if (s.lastSceneIconHashes.get(id) === hash) continue;
        await callWorker(s.page, 'renderSceneIcon', id, hash);
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
    s.lastPrefabIconsHash = prefabHash;
    for (const { id, hash } of sceneHashes) s.lastSceneIconHashes.set(id, hash);
}

const WORKER_READY_TIMEOUT_MS = 30_000;
const WORKER_READY_STEP_MS = 50;

async function waitForWorkerReady(page: Page): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < WORKER_READY_TIMEOUT_MS) {
        const ready = await page
            .evaluate(() => (globalThis as unknown as { __bongle_worker_ready?: boolean }).__bongle_worker_ready === true)
            .catch(() => false);
        if (ready) return;
        await new Promise((r) => setTimeout(r, WORKER_READY_STEP_MS));
    }
    throw new Error('[bongle:orchestrator] worker did not become ready in time');
}

/** Dispatch a verb on `window.__bongle_worker`. Args must JSON-serialize. */
async function callWorker<T = void>(page: Page, verb: string, ...args: unknown[]): Promise<T> {
    return page.evaluate(
        async (verbName, verbArgs) => {
            const w = (globalThis as unknown as {
                __bongle_worker?: Record<string, unknown>;
            }).__bongle_worker;
            if (!w) throw new Error('__bongle_worker missing');
            if (verbName === '__GET_bootId') return w.bootId as unknown;
            const fn = w[verbName];
            if (typeof fn !== 'function') throw new Error(`unknown verb ${verbName}`);
            return (fn as (...a: unknown[]) => unknown).apply(w, verbArgs);
        },
        verb,
        args,
    ) as Promise<T>;
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
