/**
 * Worker surface exposed by the puppeteer pipeline page. The orchestrator
 * (Node side) drives it via `page.evaluate`; the worker side is in
 * kit/runtime/pipeline.ts (lives on `window.__bongle_worker`).
 *
 * Each verb does exactly one named thing. The page does NOT decide when to
 * render or what to fetch — it only reacts to RPC calls. Hashes are computed
 * Node-side and passed in as opaque strings (the worker writes them through
 * to the sidecar manifest via /__bongle/pipeline/emit).
 */

import type { ScenePayload } from 'bongle/internal';

export type WorkerApi = {
    /** Per-page-load identity. Orchestrator detects reloads by watching
     *  this; new id ⇒ wipe applied state and re-boot. */
    bootId: string;

    /** Initialize EngineClient + load the GPU atlas. Called by the
     *  orchestrator ONCE per page-load, only after Node confirms the atlas
     *  is on disk. */
    bootEngine(): Promise<void>;

    /** Apply one scene's payload to the engine. */
    applyScene(id: string, payload: ScenePayload): Promise<void>;

    /** Clear one scene. */
    clearScene(id: string): Promise<void>;

    /** Drain registry pendingChanges (refreshBlockResources, prefab anchor
     *  re-mark, etc.). Idempotent — no-op when queues are empty. */
    applyRegistryChanges(): Promise<void>;

    /** Render the block-icons atlas and POST it. `hash` is the Node-computed
     *  label written into the sidecar manifest. */
    renderBlockIcons(hash: string): Promise<void>;

    /** Render a single prefab's icon and POST it (one PNG per prefab).
     *  Render gating is Node-side; the worker just renders + POSTs. */
    renderPrefabIcon(id: string): Promise<void>;

    /** Render a single scene's icon and POST it. */
    renderSceneIcon(id: string): Promise<void>;
};
