// core/resources.ts — pipeline-prepared / dynamic asset registry.
//
// "resources" in this codebase means: assets the user declares that come
// from a build pipeline (today, gltf → bin via the cli) or are produced
// dynamically at runtime (future: synthesized player models). authored
// content (scenes, etc.) lives under `core/content/`, not here.
//
// today the only resource type is models. this module owns the per-modelId
// URL registry (declared via `model()`) and the lazy payload state machine
// that fetches the per-side `.bin`, parses it, and exposes
// geometry/clipChannels for downstream systems (renderer, animator,
// physics) to poll.

import type { Box3 } from 'mathcat';
import { createEmptyHandle, hydrateRuntimeHandle } from './models/build-runtime-handle';
import type { ClipChannel, ClipChannels, ClipDef, MeshId, ModelHandle } from './models/handle';
import { type Model, type ModelMesh, toModel } from './models/model';
import { unpack } from './models/model-bin';
import { gltfUnpack } from './models/model-glb';
import type { ResourceLoader } from './resource-loader';

// ── cached model ────────────────────────────────────────────────────

// keyed in resources.models by user-chosen modelId string (`'wizard'`).
export type ResourceModel = {
    /** payload fetch URL the client side uses. */
    clientUrl: string;
    /** payload fetch URL the server side uses. */
    serverUrl: string;
    /**
     * provenance of the entry. dictates both wire replication and
     * payload unpacker:
     *   - `'bundled'` — codegen'd, ships as part of the engine build.
     *     Both sides have it locally via their own registry-dispatch;
     *     never crosses the wire. Bytes are packcat `.bin` (unpack()).
     *   - `'runtime'` — registered dynamically at runtime (e.g. an
     *     uploaded avatar). The server is the canonical source of
     *     truth and Discovery broadcasts `register_model` to clients
     *     so they learn the URLs. Bytes are `.glb` (gltfUnpack()).
     *
     * Today this is 1:1 with bytes-format; if a future runtime source
     * ever ships `.bin`, split into two fields.
     */
    source: 'bundled' | 'runtime';
    /** content hash for cache busting / change detection. optional. */
    hash?: string;
    /** payload size in bytes. informational. */
    size?: number;
    /**
     * codegen'd handle for bundled models — passed through by the
     * `_registerModelHandle` → registry-dispatch path so consumers like
     * `Resources.modelHandle()` return the same handle object that user
     * code addresses via the codegen barrel (`wizard.nodes.Body`).
     *
     * Optional + omitted for runtime-source models. When omitted,
     * `setModel` constructs an empty `ModelHandle` shell and stashes it
     * here; `ensureModel` hydrates it in place on payload-ready (same
     * object identity across the swap).
     */
    handle?: ModelHandle;
    /**
     * runtime-source refcount, managed by `acquireRuntimeModel` /
     * `releaseRuntimeModel`. Undefined for bundled entries (never
     * released — they live for the engine lifetime). At zero, the
     * entry is eligible for deletion; the release op does this
     * eagerly today (no grace period — server lifecycle hooks already
     * filter rapid swaps).
     */
    _refcount?: number;
};

// ── lazy-loaded model payload ────────────────────────────────────────

/**
 * read raw model bytes by url. the engine is built per-side so each
 * side bakes in its own impl (fetch on the client, fs.readFile on the
 * server) — this type just lets the side-agnostic registry stay
 * decoupled from web/node apis. format-agnostic: same loader serves
 * both `.bin` and `.glb` urls; dispatch happens after bytes arrive.
 */
export type ModelBytesLoader = (url: string) => Promise<Uint8Array>;

/** parsed mesh geometry — shared shape between parser and renderer. */
export type ModelGeometry = {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    /** local-space AABB */
    aabb: Box3;
    /** convex hull, computed lazily on first request. */
    _hull: ModelGeometry | null;
};

export type ModelPayload = {
    state: 'unloaded' | 'loading' | 'ready' | 'failed';
    /** mesh-name → ModelGeometry. populated on both sides. */
    geometry: Map<string, ModelGeometry>;
    /** clip-name → ClipChannels. populated on ready. animator looks up
     *  via Resources.modelClipChannels(s, clip). */
    clips: Map<string, ClipChannels>;
    /** parsed runtime model — populated when state becomes 'ready'.
     *  Consumers (ModelResources on the client) null this after consuming
     *  to free memory. Server has no consumer; the field remains until
     *  release. Same shape regardless of source format (.bin or .glb). */
    model: Model | null;
    /** consecutive load failures; gates exponential backoff in
     *  `ensureModel`. Reset on a successful load. */
    _failedAttempts: number;
    /** earliest performance.now() timestamp at which a 'failed' payload
     *  may be retried. systems poll `ensureModel` every tick — without
     *  this, a single missing model bin would flood the network. */
    _nextRetryAt: number;
};

/** initial backoff after the first failure, in milliseconds. doubles per
 *  attempt up to BACKOFF_MAX_MS. */
const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 30_000;
export const BACKOFF_GIVE_UP_AFTER = 6;

// ── resources state ─────────────────────────────────────────────────

export type ResourcesSide = 'client' | 'server';

export type Resources = {
    /** keyed by user-chosen modelId string (`'wizard'`). url + handle entry. */
    models: Map<string, ResourceModel>;
    /** keyed by user-chosen modelId string. lazy load state + parsed bin. */
    modelPayloads: Map<string, ModelPayload>;
    /** environment resource-I/O — byte loading (fetch on the client, fs/fetch
     *  on the server, disk in the asset pipeline) plus the optional image
     *  decoder the asset pipeline injects. See `ResourceLoader`. */
    loader: ResourceLoader;
    /** which side this Resources instance runs on. Picks `clientUrl` vs
     *  `serverUrl` in `ensureModel`. Set once at init. */
    side: ResourcesSide;
};

export function init(loader: ResourceLoader, side: ResourcesSide): Resources {
    return {
        models: new Map(),
        modelPayloads: new Map(),
        loader,
        side,
    };
}

// ── url registry mutations ──────────────────────────────────────────

export function setModel(resources: Resources, id: string, model: ResourceModel): void {
    // runtime models pass no handle — construct an empty shell here so
    // `Resources.modelHandle(id)` returns a stable, identity-preserving
    // object that the hydrator (called from `ensureModel`) can mutate in
    // place on payload-ready. re-registering the same id without a
    // handle preserves the existing shell so user/script-held refs stay
    // valid across `setModel(url1)` → `setModel(url2)` sequences.
    if (!model.handle) {
        const existing = resources.models.get(id);
        model.handle = existing?.handle ?? createEmptyHandle(id);
    }
    resources.models.set(id, model);
    // every payload swap counts as a content change for the handle —
    // bump so prefabs that have it in `deps` rebuild.
    model.handle.version++;
}

export function deleteModel(resources: Resources, id: string): void {
    resources.models.delete(id);
}

/* ── runtime-source refcount ────────────────────────────────────────── */
//
// Bundled models live for the engine lifetime and never call these.
// Runtime models (uploaded avatars) use acquire/release at the server
// join/leave boundary: the same modelId worn by N players in a room
// resolves to refcount=N. At zero, the bytes (`releaseModel`) and URL
// entry (`deleteModel`) are both dropped, and Discovery's next flush
// notices the entry is gone and emits `unregister_model` to clients
// that knew about it. Symmetric on the client: it `releaseRuntimeModel`s
// on `unregister_model` receive — refcount tracking there is a no-op
// today (one acquire per server signal) but keeps the API parallel.

/**
 * Acquire a runtime model. First acquire registers the entry via
 * `setModel`; subsequent acquires just bump the refcount. Idempotent
 * against re-supplying the same entry (URL + handle re-bind is a noop
 * inside `setModel`).
 */
export function acquireRuntimeModel(
    resources: Resources,
    id: string,
    entry: Omit<ResourceModel, '_refcount'>,
): void {
    const existing = resources.models.get(id);
    if (existing) {
        existing._refcount = (existing._refcount ?? 0) + 1;
        return;
    }
    setModel(resources, id, { ...entry, _refcount: 1 });
}

/**
 * Release a runtime model. Decrements the refcount; at zero, releases
 * the payload bytes and drops the URL entry. Safe to call against an
 * unknown id (noop) or a bundled entry (noop) so leave-side cleanup can
 * call it unconditionally without checking the resolved kind.
 */
export function releaseRuntimeModel(resources: Resources, id: string): void {
    const existing = resources.models.get(id);
    if (!existing) return;
    if (existing.source !== 'runtime') return;
    const next = (existing._refcount ?? 0) - 1;
    if (next > 0) {
        existing._refcount = next;
        return;
    }
    releaseModel(resources, id);
    deleteModel(resources, id);
}

/* ── pollable sync accessors — return null while loading; never throw ── */

/** model payload ready? */
export function hasModel(resources: Resources, modelId: string): boolean {
    return resources.modelPayloads.get(modelId)?.state === 'ready';
}

/** geometry for a single mesh; null while payload still loading. */
export function modelGeometry(resources: Resources, meshId: MeshId): ModelGeometry | null {
    const payload = resources.modelPayloads.get(meshId.modelId);
    if (payload?.state !== 'ready') return null;
    return payload.geometry.get(meshId.meshName) ?? null;
}

/** clip channels for a clip; null while payload still loading. */
export function modelClipChannels(resources: Resources, clip: ClipDef): ClipChannels | null {
    const payload = resources.modelPayloads.get(clip.modelId);
    if (payload?.state !== 'ready') return null;
    return payload.clips.get(clip.name) ?? null;
}

/** lookup the handle for a model. null if not in the url registry. */
export function modelHandle(resources: Resources, modelId: string): ModelHandle | null {
    return resources.models.get(modelId)?.handle ?? null;
}

/* ── lazy load — fire-and-forget. transitions unloaded → loading ── */

/**
 * idempotent; safe to call every tick from systems that observe missing
 * payload. picks the per-side URL off the entry (`clientUrl` /
 * `serverUrl`) by `resources.side`, fetches via the host loader, and
 * dispatches the unpacker by `entry.source` (bundled → packcat bin,
 * runtime → glb subset).
 */
export function ensureModel(resources: Resources, modelId: string): void {
    let payload = resources.modelPayloads.get(modelId);
    if (payload) {
        if (payload.state === 'loading' || payload.state === 'ready') return;
        if (payload.state === 'failed') {
            // permanent give-up after enough failures — leave 'failed'
            // sticky so renderer/physics see no payload, and let humans
            // see one error rather than a continuous stream.
            if (payload._failedAttempts >= BACKOFF_GIVE_UP_AFTER) return;
            if (performance.now() < payload._nextRetryAt) return;
        }
    }

    const entry = resources.models.get(modelId);
    if (!entry) {
        console.warn(`[Resources] ensureModel "${modelId}": no resource entry; skipping`);
        return;
    }

    if (!payload) {
        payload = {
            state: 'unloaded',
            geometry: new Map(),
            clips: new Map(),
            model: null,
            _failedAttempts: 0,
            _nextRetryAt: 0,
        };
        resources.modelPayloads.set(modelId, payload);
    }
    payload.state = 'loading';

    const url = resources.side === 'client' ? entry.clientUrl : entry.serverUrl;
    const source = entry.source;
    resources.loader.loadBytes(url)
        .then((bytes) => (source === 'runtime' ? gltfUnpack(modelId, bytes) : toModel(modelId, unpack(bytes))))
        .then((model) => {
            _onPayloadReady(resources, modelId, model);
        })
        .catch((err) => {
            const p = resources.modelPayloads.get(modelId);
            if (!p) return;
            p.state = 'failed';
            p._failedAttempts++;
            const delay = Math.min(BACKOFF_INITIAL_MS * 2 ** (p._failedAttempts - 1), BACKOFF_MAX_MS);
            p._nextRetryAt = performance.now() + delay;
            const giveUp = p._failedAttempts >= BACKOFF_GIVE_UP_AFTER;
            console.error(
                `[Resources] failed to load "${modelId}" (attempt ${p._failedAttempts}${giveUp ? ', giving up' : `, retry in ${delay}ms`}):`,
                err,
            );
        });
}

/**
 * hydrate parsed model into the payload + sidecar clip refs. Side-agnostic:
 * stashes the model on the payload for downstream consumers (ModelResources
 * on client polls + nulls it). Server has no consumer.
 *
 * For runtime (`.glb`) models, also populates the empty `ModelHandle`
 * shell that `setModel` constructed — `scene`, `nodes`, `meshes`,
 * `animations`, `aabb` get stamped from the parsed model. Declared
 * (`.bin`) models pass through without handle mutation: the
 * codegen-stamped handle is already authoritative (constructed at
 * module-eval from the same scene-tree data baked into JS source).
 */
function _onPayloadReady(resources: Resources, modelId: string, model: Model): void {
    const payload = resources.modelPayloads.get(modelId);
    if (!payload) return;

    const geometry = new Map<string, ModelGeometry>();
    for (const m of model.meshesByName.values()) geometry.set(m.name, toModelGeometry(m));
    payload.geometry = geometry;

    const clips = new Map<string, ClipChannels>();
    for (const c of model.clipsByName.values()) {
        const channels: ClipChannel[] = c.channels.map((ch) => ({
            nodeName: ch.target.name,
            property: ch.property,
            interpolation: ch.interpolation,
            times: ch.times,
            values: ch.values,
        }));
        clips.set(c.name, { duration: c.duration, channels });
    }
    payload.clips = clips;

    payload.model = model;
    payload.state = 'ready';
    payload._failedAttempts = 0;
    payload._nextRetryAt = 0;

    const entry = resources.models.get(modelId);
    if (entry?.source === 'runtime' && entry.handle) {
        hydrateRuntimeHandle(entry.handle, model);
    }
}

/**
 * release a payload. drops CPU geometry + bin. Client-side gpu pools
 * (ModelResources) detect the removal on next update tick and free their
 * own state.
 */
export function releaseModel(resources: Resources, modelId: string): void {
    const payload = resources.modelPayloads.get(modelId);
    if (!payload) return;

    payload.geometry.clear();
    payload.clips.clear();
    payload.model = null;
    payload.state = 'unloaded';

    resources.modelPayloads.delete(modelId);
}

/* ── helpers ── */

function toModelGeometry(m: ModelMesh): ModelGeometry {
    return {
        positions: m.positions,
        normals: m.normals,
        uvs: m.uvs,
        indices: m.indices,
        aabb: [m.aabb[0], m.aabb[1], m.aabb[2], m.aabb[3], m.aabb[4], m.aabb[5]],
        _hull: null,
    };
}
