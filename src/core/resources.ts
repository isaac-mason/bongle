import type { Box3 } from 'math/shapes';
import { createEmptyDef, hydrateRuntimeHandle } from './models/build-runtime-handle';
import type { ClipChannel, ClipChannels, ClipDef, MeshId, ModelDef } from './models/handle';
import { type Model, type ModelMesh, toModel } from './models/model';
import { unpack } from './models/model-bin';
import { gltfUnpack } from './models/model-glb';
import type { ResourceLoader } from './resource-loader';
import type { SpriteAtlasMetadata } from './sprites/atlas';

// keyed in resources.models by user-chosen modelId string (`'wizard'`).
export type ResourceModel = {
    /** payload fetch URL the client side uses. */
    clientUrl: string;
    /** payload fetch URL the server side uses. */
    serverUrl: string;
    /**
     * provenance of the entry, dictates both wire replication and payload
     * unpacker. `'bundled'` is codegen'd and ships with the engine build;
     * both sides have it locally, never crosses the wire, bytes are packcat
     * `.bin`. `'runtime'` is registered dynamically (e.g. an uploaded
     * avatar); the server is canonical and broadcasts `register_model` to
     * clients, bytes are `.glb`.
     */
    source: 'bundled' | 'runtime';
    /** content hash for cache busting / change detection. optional. */
    hash?: string;
    /** payload size in bytes. informational. */
    size?: number;
    /**
     * codegen'd handle for bundled models, so consumers like
     * `Resources.modelDef()` return the same def object user code addresses
     * via the codegen barrel. Omitted for runtime-source models: `setModel`
     * constructs an empty `ModelDef` shell and stashes it here, and
     * `ensureModel` hydrates it in place on payload-ready.
     */
    def?: ModelDef;
    /** runtime-source refcount, managed by `acquireRuntimeModel` /
     *  `releaseRuntimeModel`. Undefined for bundled entries, which are
     *  never released. At zero, the entry is eligible for deletion. */
    _refcount?: number;
};

/**
 * read raw model bytes by url. The engine is built per-side so each side
 * bakes in its own impl (fetch on the client, fs.readFile on the server).
 * Format-agnostic: same loader serves both `.bin` and `.glb` urls.
 */
export type ModelBytesLoader = (url: string) => Promise<Uint8Array>;

/** parsed mesh geometry, shared shape between parser and renderer. */
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
    /** mesh-name to ModelGeometry. populated on both sides. */
    geometry: Map<string, ModelGeometry>;
    /** clip-name to ClipChannels. populated on ready; animator looks up via
     *  Resources.modelClipChannels(s, clip). */
    clips: Map<string, ClipChannels>;
    /** parsed runtime model, populated when state becomes 'ready'. Consumers
     *  (MeshResources on the client) null this after consuming to free
     *  memory. Server has no consumer, so the field remains until release. */
    model: Model | null;
    /** consecutive load failures; gates exponential backoff in
     *  `ensureModel`. Reset on a successful load. */
    _failedAttempts: number;
    /** earliest performance.now() timestamp at which a 'failed' payload may
     *  be retried, without which a missing model bin would flood the network. */
    _nextRetryAt: number;
    /** deferred for the awaited (non-tick-driven) load path, created lazily
     *  by `whenModelReady`. Resolved on 'ready', rejected on give-up or
     *  release. While set, `ensureModel` self-schedules its own retry;
     *  tick-driven consumers (where this stays null) poll `ensureModel` themselves. */
    _ready: PromiseWithResolvers<ModelDef> | null;
};

/** initial backoff after the first failure, in milliseconds. doubles per
 *  attempt up to BACKOFF_MAX_MS. */
const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_GIVE_UP_AFTER = 6;

export type ResourcesSide = 'client' | 'server';

export type Resources = {
    /** keyed by user-chosen modelId string (`'wizard'`). url + handle entry. */
    models: Map<string, ResourceModel>;
    /** keyed by user-chosen modelId string. lazy load state + parsed bin. */
    modelPayloads: Map<string, ModelPayload>;
    /** environment resource-I/O: byte loading (fetch on the client, fs/fetch
     *  on the server, disk in the asset pipeline) plus the optional image
     *  decoder the asset pipeline injects. See `ResourceLoader`. */
    loader: ResourceLoader;
    /** which side this Resources instance runs on; picks `clientUrl` vs
     *  `serverUrl` in `ensureModel`. Set once at init. */
    side: ResourcesSide;
    /** sprite atlas sidecar metadata (pixel rects + per-sprite flags), loaded
     *  via `Sprites.loadAtlasMetadata` at boot + on HMR atlas change. Null
     *  server-side / before load. */
    spriteAtlas: SpriteAtlasMetadata | null;
};

export function init(loader: ResourceLoader, side: ResourcesSide): Resources {
    return {
        models: new Map(),
        modelPayloads: new Map(),
        loader,
        side,
        spriteAtlas: null,
    };
}

export function setModel(resources: Resources, id: string, model: ResourceModel): void {
    // runtime models pass no handle: construct an empty shell here so
    // `Resources.modelDef(id)` returns a def the hydrator (called from
    // `ensureModel`) can mutate in place on payload-ready. Re-registering the
    // same id without a handle preserves the existing shell so user/script-held
    // refs stay valid across `setModel(url1)` -> `setModel(url2)` sequences.
    if (!model.def) {
        const existing = resources.models.get(id);
        model.def = existing?.def ?? createEmptyDef(id);
    }
    resources.models.set(id, model);
    // every payload swap counts as a content change for the handle, bump so
    // prefabs that have it in `deps` rebuild.
    model.def!.version++;
}

export function deleteModel(resources: Resources, id: string): void {
    resources.models.delete(id);
}

// bundled models live for the engine lifetime and never call these. Runtime
// models (uploaded avatars) use acquire/release at the server join/leave
// boundary: the same modelId worn by N players resolves to refcount=N. At
// zero, the bytes and URL entry are both dropped, and Discovery's next flush
// emits `unregister_model` to clients that knew about it.

/**
 * Acquire a runtime model. First acquire registers the entry via `setModel`;
 * subsequent acquires just bump the refcount. Idempotent against
 * re-supplying the same entry.
 */
export function acquireRuntimeModel(resources: Resources, id: string, entry: Omit<ResourceModel, '_refcount'>): void {
    const existing = resources.models.get(id);
    if (existing) {
        existing._refcount = (existing._refcount ?? 0) + 1;
        return;
    }
    setModel(resources, id, { ...entry, _refcount: 1 });
}

/**
 * Release a runtime model. Decrements the refcount; at zero, releases the
 * payload bytes and drops the URL entry. Safe to call against an unknown id
 * or a bundled entry (both noop), so leave-side cleanup can call it
 * unconditionally.
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
export function modelDef(resources: Resources, modelId: string): ModelDef | null {
    return resources.models.get(modelId)?.def ?? null;
}

/**
 * idempotent; safe to call every tick from systems that observe missing
 * payload. Fire-and-forget, transitions unloaded to loading. Picks the
 * per-side URL off the entry by `resources.side`, fetches via the host
 * loader, and dispatches the unpacker by `entry.source` (bundled to packcat
 * bin, runtime to glb subset).
 */
export function ensureModel(resources: Resources, modelId: string): void {
    let payload = resources.modelPayloads.get(modelId);
    if (payload) {
        if (payload.state === 'loading' || payload.state === 'ready') return;
        if (payload.state === 'failed') {
            // permanent give-up after enough failures: leave 'failed' sticky
            // so renderer/physics see no payload, and log once rather than
            // a continuous stream.
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
            _ready: null,
        };
        resources.modelPayloads.set(modelId, payload);
    }
    payload.state = 'loading';

    const url = resources.side === 'client' ? entry.clientUrl : entry.serverUrl;
    const source = entry.source;
    resources.loader
        .loadBytes(url)
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
            _settleWaiter(resources, modelId); // rejects iff this attempt hit give-up
            if (!giveUp && p._ready) {
                // awaited load with no tick-driver to re-poll us: self-drive
                // the retry once the backoff elapses. Harmless if a
                // tick-driven consumer also exists, since `ensureModel` is idempotent.
                setTimeout(() => ensureModel(resources, modelId), delay);
            }
        });
}

/**
 * hydrate parsed model into the payload + sidecar clip refs. Side-agnostic:
 * stashes the model on the payload for downstream consumers (MeshResources
 * on client polls + nulls it). For runtime (`.glb`) models, also populates
 * the empty `ModelDef` shell that `setModel` constructed. Declared (`.bin`)
 * models pass through without handle mutation: the codegen-stamped handle is
 * already authoritative.
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
    if (entry?.source === 'runtime' && entry.def) {
        hydrateRuntimeHandle(entry.def, model);
    }

    _settleWaiter(resources, modelId);
}

/**
 * Settle the awaited-load deferred (`payload._ready`) against the payload's
 * current terminal state: resolve on 'ready', reject at the backoff give-up.
 * No-op while still loading/retrying, or when nothing is awaiting. Idempotent,
 * so every state-transition site can call it without tracking waiters.
 */
function _settleWaiter(resources: Resources, modelId: string): void {
    const payload = resources.modelPayloads.get(modelId);
    const deferred = payload?._ready;
    if (!deferred) return;
    if (payload.state === 'ready') {
        const def = modelDef(resources, modelId);
        if (def) deferred.resolve(def);
        else deferred.reject(new Error(`[Resources] "${modelId}" ready but no def`));
    } else if (payload.state === 'failed' && payload._failedAttempts >= BACKOFF_GIVE_UP_AFTER) {
        deferred.reject(new Error(`[Resources] "${modelId}" failed after ${payload._failedAttempts} attempts`));
    }
}

/** release a payload. drops CPU geometry + bin. Client-side gpu pools
 *  (MeshResources) detect the removal on next update tick and free their
 *  own state. */
export function releaseModel(resources: Resources, modelId: string): void {
    const payload = resources.modelPayloads.get(modelId);
    if (!payload) return;

    payload.geometry.clear();
    payload.clips.clear();
    payload.model = null;
    payload.state = 'unloaded';
    payload._ready?.reject(new Error(`[Resources] "${modelId}" released before ready`));

    resources.modelPayloads.delete(modelId);
}

/**
 * Promise that settles with the model's handle once its payload is ready, or
 * rejects if the load gives up after backoff (or the entry is released
 * mid-flight). The awaited sibling of the `hasModel`/`modelDef` poll pair.
 * Pair with `ensureModel` so a load is actually in flight; this only
 * attaches to it. Registering the deferred also opts the load into
 * self-driven retries, since an awaited one-shot has no tick-driven pump.
 */
export function whenModelReady(resources: Resources, modelId: string): Promise<ModelDef> {
    const payload = resources.modelPayloads.get(modelId);
    if (!payload) {
        return Promise.reject(new Error(`[Resources] whenModelReady "${modelId}": no payload; call ensureModel first`));
    }
    payload._ready ??= Promise.withResolvers<ModelDef>();
    // settle now if the payload already reached a terminal state before any
    // awaiter existed; the transition sites only fire on the edge.
    _settleWaiter(resources, modelId);
    return payload._ready.promise;
}

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
