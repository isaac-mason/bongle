/**
 * core/registry.ts — unified declarative-content registry.
 *
 * one module-scope singleton (`registry`) bundles every declared kind
 * (blocks, blockTextures, models, traits, scripts, …) into a single
 * shape. user-facing APIs (`block()`, `trait()`, …) upsert into the
 * relevant per-kind `KindStore` via the primitives in this file; engine
 * consumers read `registry.blocks.byId.get(id)`, `registry.blockRegistry`,
 * `registry.commandWireIndex`, etc. dispatch (`client/registry-dispatch.ts`,
 * `server/registry-dispatch.ts`) drains each store's `pendingChanges` and
 * calls `Registry.bumpVersion(registry)` once at the end of each flush.
 *
 * derived views (`blockRegistry`, `traitsBySlot`, `commandWireIndex`,
 * `traitWireIndex`) memoise against the source kind's `revision` and
 * recompute lazily on next read. there is no `ProjectModule` snapshot —
 * the singleton itself is the read surface.
 */

import { clearDeps, type DepKey, getDirtyConsumers, setDeps } from './capture/dep-graph';
import { onModulePop, onModulePush, owningModule } from './capture/module-scope';
import { DEFAULT_MATCHMAKING_CONFIG, type MatchmakingConfig } from './matchmaking';
import type { ModelHandle } from './models/handle';
import type { ParticleHandle } from './particles/particles';
import type { CommandDef } from './rpc';
import type { Realm } from './scene/nodes';
import type { Schema } from './scene/prop/prop';
import type { SceneHandle } from './scene/scene-handle';
import type { ScriptDef } from './scene/scripts';
import type { ControlDef, SyncDef, TraitDef } from './scene/traits';
import type { SoundHandle } from './sounds/sounds';
import type { SpriteHandle } from './sprites/sprites';
import { type BlockRegistry, buildBlockRegistry } from './voxels/block-registry';
import { type BlockDef, type BlockHandle, type BlockModel, type BlockTextureDef, collectModelTextureIds } from './voxels/blocks';

/* ── primitive types ────────────────────────────────────────────── */

export type Handle<T> = {
    readonly id: string;
    readonly module: string;
    payload: T;
    version: number;
    hash: string;
};

export type Change<T> =
    | { kind: 'added'; handle: Handle<T> }
    | { kind: 'changed'; handle: Handle<T> }
    | { kind: 'removed'; handle: Handle<T> };

/**
 * per-kind storage. one of these per declared kind on the unified
 * `Registry`. carries its own byId map, ownership bookkeeping,
 * pending-change queue, monotonic revision counter, and the kind-specific
 * `hash` / `diff` / `extractDeps` functions.
 */
export type KindStore<T> = {
    readonly name: string;
    byId: Map<string, Handle<T>>;
    byModule: Map<string, Set<string>>;
    pending: Map<string, Set<string>>;
    pendingChanges: Array<Change<T>>;
    /**
     * monotonic counter bumped every time a change is appended to
     * `pendingChanges` (add / change / remove). independent of the
     * draining lifecycle — consumers that run AFTER the engine drains
     * `pendingChanges` (e.g. the asset pipeline flush handler) compare
     * their last-seen revision to the current to decide whether to
     * re-run their builders. tied to actual content change via the
     * diff in `upsert`, so HMR re-evals with identical bodies don't
     * bump this.
     */
    revision: number;
    /**
     * optional — returns `true` when `a` and `b` should be treated as
     * different. when omitted, any re-`upsert` of an existing id fires
     * `changed` (react-refresh-style: the module re-evaluated, so the
     * payload is fresh by definition — no point comparing). suitable for
     * cheap-to-react kinds like scripts where over-swap is harmless.
     */
    diff?: (a: T, b: T) => boolean;
    hash: (t: T) => string;
    /**
     * optional — returns the set of producer keys this payload depends on.
     * runtime-resolved deps that wouldn't be visible to `hash` (e.g.
     * BlockDef.model is a factory; closed-over BlockTextureDef refs are
     * invisible to `Function.prototype.toString()`). called on every
     * add/change so the DepGraph reflects the current reality.
     */
    extractDeps?: (payload: T) => DepKey[];
    /**
     * when true, every `upsert` call overwrites `byId.<id>.payload` with
     * the freshly-passed payload, even when the hash is unchanged (no
     * `changed` event fires in that case). used by stores whose payload
     * carries mutable sibling collections — TraitDef's controls / sync /
     * scripts arrays are repopulated on every module re-eval by the
     * per-kind registrars; without identity replacement, the registry
     * would keep returning the previous-run def with stale collections
     * while user-code variables hold the freshly-built one.
     */
    replaceIdentity?: boolean;
};

export type KindStoreOptions<T> = {
    name: string;
    diff?: (a: T, b: T) => boolean;
    hash: (t: T) => string;
    extractDeps?: (payload: T) => DepKey[];
    replaceIdentity?: boolean;
};

/* ── hashing ────────────────────────────────────────────────────── */

/**
 * structural hash that handles functions, maps, sets, plain objects, and
 * primitives. used by every kind's `hash` to detect payload changes.
 * not crypto-grade — purpose is hmr change-detection only.
 */
export function structuralHash(value: unknown): string {
    return djb2(stringify(value));
}

function stringify(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undef';
    const t = typeof value;
    if (t === 'string') return `s:${value}`;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return `${t[0]}:${String(value)}`;
    if (t === 'function') return `f:${(value as (...args: unknown[]) => unknown).toString()}`;
    if (t !== 'object') return `?:${String(value)}`;

    if (Array.isArray(value)) {
        return `[${value.map(stringify).join(',')}]`;
    }
    if (value instanceof Map) {
        const parts: string[] = [];
        for (const k of [...value.keys()].sort()) {
            parts.push(`${stringify(k)}=>${stringify(value.get(k))}`);
        }
        return `M{${parts.join(',')}}`;
    }
    if (value instanceof Set) {
        const parts = [...value].map(stringify).sort();
        return `S{${parts.join(',')}}`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => `${k}:${stringify(obj[k])}`);
    return `{${parts.join(',')}}`;
}

function djb2(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
    return (h >>> 0).toString(36);
}

/**
 * hash-equality diff. consumer reactions across the engine are wholesale
 * by design (any block change → remesh world; any texture change → rebuild
 * atlas; etc.), so a finer field vocabulary buys nothing.
 */
function wholesaleDiff<T>(hash: (t: T) => string): (a: T, b: T) => boolean {
    return (a, b) => hash(a) !== hash(b);
}

/* ── kind store construction ────────────────────────────────────── */

function createKindStore<T>(opts: KindStoreOptions<T>): KindStore<T> {
    const store: KindStore<T> = {
        name: opts.name,
        byId: new Map(),
        byModule: new Map(),
        pending: new Map(),
        pendingChanges: [],
        revision: 0,
        diff: opts.diff,
        hash: opts.hash,
        extractDeps: opts.extractDeps,
        replaceIdentity: opts.replaceIdentity,
    };

    onModulePush((moduleId) => {
        beginModuleRun(store, moduleId);
    });
    onModulePop((moduleId) => {
        endModuleRun(store, moduleId);
    });

    return store;
}

/**
 * clears the per-module pending set so passive removal can detect
 * vanished ids at endModuleRun. called via the module-scope push hook.
 */
function beginModuleRun<T>(store: KindStore<T>, moduleId: string): void {
    store.pending.set(moduleId, new Set());
}

/**
 * any id this module owned previously but didn't re-declare this run
 * fires `removed`. called via the module-scope pop hook.
 */
function endModuleRun<T>(store: KindStore<T>, moduleId: string): void {
    const seen = store.pending.get(moduleId);
    if (!seen) return;
    const owned = store.byModule.get(moduleId);
    if (!owned) {
        store.pending.delete(moduleId);
        return;
    }
    for (const id of owned) {
        if (seen.has(id)) continue;
        const handle = store.byId.get(id);
        if (!handle) continue;
        store.byId.delete(id);
        owned.delete(id);
        store.pendingChanges.push({ kind: 'removed', handle });
        store.revision++;
        if (store.extractDeps) clearDeps({ registry: store.name, id });
    }
    store.pending.delete(moduleId);
}

/* ── writes ─────────────────────────────────────────────────────── */

/**
 * synthetic owner for entries that exist before any "real" module has
 * claimed them. today's only producer is `model()`'s pre-codegen
 * placeholder — the user code calls `model('id')` before the codegen
 * barrel has emitted `_registerModelHandle('id', ...)`, so we still
 * need an entry in the registry (so the cli's pipeline read picks the
 * id up) but no real module owns it yet. When the real owner finally
 * calls `upsert`, ownership is reassigned without firing the mismatch
 * guard.
 */
export const PLACEHOLDER_OWNER = '__placeholder__';

export function upsert<T>(store: KindStore<T>, id: string, payload: T): Handle<T> {
    const module = owningModule();
    const pending = store.pending.get(module);
    pending?.add(id);

    const existing = store.byId.get(id);

    if (!existing) {
        const handle: Handle<T> = {
            id,
            module,
            payload,
            version: 0,
            hash: store.hash(payload),
        };
        store.byId.set(id, handle);
        addOwnership(store, module, id);
        store.pendingChanges.push({ kind: 'added', handle });
        store.revision++;
        if (store.extractDeps) {
            setDeps({ registry: store.name, id }, store.extractDeps(payload));
        }
        return handle;
    }

    if (existing.module !== module) {
        // PLACEHOLDER_OWNER entries are claimed via `claimOwnership` +
        // mutate-in-place, not via upsert — so any module-mismatch here
        // is a genuine redeclaration conflict.
        throw new Error(`[registry:${store.name}] '${id}' redeclared by ${module}, owned by ${existing.module}`);
    }

    // when `diff` is omitted, any re-upsert is a change — module
    // re-evaluation produced a fresh payload, that's the only way we got
    // here (cf. react-refresh, which also doesn't compare bodies).
    const changed = store.diff ? store.diff(existing.payload, payload) : true;

    // refresh deps and capture whether the dep set differs from before.
    // closure-bound producers (e.g. BlockDef.model factory closing over a
    // BlockTextureDef ref) are invisible to `hash`, so the content diff
    // can short-circuit even when the consumer's effective producer set
    // moved. when that happens we elevate to a synthetic `changed` event
    // so dispatch reacts.
    const depsChanged = store.extractDeps ? setDeps({ registry: store.name, id }, store.extractDeps(payload)) : false;

    if (!changed && !depsChanged) {
        if (store.replaceIdentity) {
            // payload identity moved even though content hash didn't —
            // derived caches keyed on `revision` (e.g. `traitsBySlot`) hold
            // refs to the prior payload and would return a stale def.
            existing.payload = payload;
            store.revision++;
        }
        return existing;
    }

    const handle: Handle<T> = {
        id,
        module,
        payload,
        version: existing.version + 1,
        hash: store.hash(payload),
    };
    store.byId.set(id, handle);
    store.pendingChanges.push({ kind: 'changed', handle });
    store.revision++;
    return handle;
}

/**
 * Re-hash an existing handle in place and fire `changed` if hash or dep set
 * moved. The handle's payload identity is preserved — callers mutate
 * `handle.<field>` directly (e.g. SceneHandle._payload on HMR, ModelHandle.bin
 * on bin reload) and then call `touch()` so the registry detects the change
 * without losing the user-code-held reference.
 *
 * Unlike `upsert`, no ownership check: out-of-band mutations come from
 * engine code (HMR listeners, codegen barrel re-runs), not user module
 * scope, so `owningModule()` would just be `__prod__` and a mismatch
 * compare with the user's original module would always throw. The handle's
 * `module` field is preserved.
 *
 * No-op when the store has no entry for `id`. Caller's responsibility to
 * mutate the payload before calling.
 */
export function touch<T>(store: KindStore<T>, id: string): void {
    const existing = store.byId.get(id);
    if (!existing) return;

    const newHash = store.hash(existing.payload);
    const hashChanged = newHash !== existing.hash;
    const depsChanged = store.extractDeps ? setDeps({ registry: store.name, id }, store.extractDeps(existing.payload)) : false;

    if (!hashChanged && !depsChanged) return;

    existing.hash = newHash;
    existing.version++;
    store.pendingChanges.push({ kind: 'changed', handle: existing });
    store.revision++;
}

function addOwnership<T>(store: KindStore<T>, module: string, id: string): void {
    let owned = store.byModule.get(module);
    if (!owned) {
        owned = new Set();
        store.byModule.set(module, owned);
    }
    owned.add(id);
}

function removeOwnership<T>(store: KindStore<T>, module: string, id: string): void {
    const owned = store.byModule.get(module);
    if (!owned) return;
    owned.delete(id);
    if (owned.size === 0) store.byModule.delete(module);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Register an entry without claiming module-scope ownership — for cases
 * where the caller knows the entry needs to exist in the store now
 * (so downstream readers can see it) but the "real" owner will arrive
 * later via a normal `upsert` or `claimOwnership`. The next claim
 * reassigns ownership; the mismatch throw is suppressed for the
 * placeholder owner.
 *
 * No-op if `id` already exists (the caller should mutate the existing
 * payload directly instead of replacing it, so user-held references
 * stay valid).
 */
export function upsertPlaceholder<T>(store: KindStore<T>, id: string, payload: T): Handle<T> {
    const existing = store.byId.get(id);
    if (existing) return existing;

    const handle: Handle<T> = {
        id,
        module: PLACEHOLDER_OWNER,
        payload,
        version: 0,
        hash: store.hash(payload),
    };
    store.byId.set(id, handle);
    addOwnership(store, PLACEHOLDER_OWNER, id);
    store.pendingChanges.push({ kind: 'added', handle });
    store.revision++;
    if (store.extractDeps) {
        setDeps({ registry: store.name, id }, store.extractDeps(payload));
    }
    return handle;
}

/**
 * Mark `id` as owned + still-declared by the calling module. Pairs with
 * in-place payload mutation patterns (e.g. `model()`'s src-patch path):
 * the caller mutates the existing handle's payload directly so user-held
 * references see new data, then calls this + `touch()` to update the
 * store's bookkeeping.
 *
 * Adds the id to the current module's `pending` set so `endModuleRun`
 * doesn't fire `removed` for it on this run, and promotes ownership
 * from `PLACEHOLDER_OWNER` to the calling module if the entry was a
 * pre-codegen placeholder. No-op when the entry is already owned by
 * the calling module.
 *
 * Throws when the entry is owned by a different real module — this
 * catches duplicate `model('id', ...)` / `block('id', ...)` declarations
 * across files, same as `upsert`'s mismatch guard.
 */
export function claimOwnership<T>(store: KindStore<T>, id: string): void {
    const existing = store.byId.get(id);
    if (!existing) return;
    const module = owningModule();
    store.pending.get(module)?.add(id);

    if (existing.module === module) return;
    if (existing.module === PLACEHOLDER_OWNER) {
        removeOwnership(store, PLACEHOLDER_OWNER, id);
        addOwnership(store, module, id);
        (existing as Mutable<Handle<T>>).module = module;
        return;
    }
    throw new Error(`[registry:${store.name}] '${id}' redeclared by ${module}, owned by ${existing.module}`);
}

/* ── reads ──────────────────────────────────────────────────────── */

export function get<T>(store: KindStore<T>, id: string): T | undefined {
    return store.byId.get(id)?.payload;
}

export function getHandle<T>(store: KindStore<T>, id: string): Handle<T> | undefined {
    return store.byId.get(id);
}

/* ── hmr utilities ──────────────────────────────────────────────── */

/**
 * Drain every store's `pendingChanges` queue without acting on it. Called
 * once per side at the end of `EngineClient.load` / `EngineServer.load` to
 * discard the initial-population `added` events — the engine consumes the
 * live registry directly, so those events are redundant and would
 * otherwise drown out the actual first edit in the dispatch log.
 */
export function clearPendingChanges(stores: ReadonlyArray<KindStore<any>>): void {
    for (const store of stores) store.pendingChanges.length = 0;
}

/**
 * Render a human-readable summary of pending changes across stores,
 * prefixed with the side that fired (`client` / `server`). Called at the
 * top of each `applyRegistryChanges*` so devs can see what hot reloaded
 * without instrumenting the rest of the pipeline.
 */
export function logPendingChanges(side: 'client' | 'server', stores: ReadonlyArray<KindStore<any>>): void {
    const lines: string[] = [];
    const directProducers: DepKey[] = [];
    const directConsumerKeys = new Set<string>();
    for (const store of stores) {
        if (store.pendingChanges.length === 0) continue;
        const added: string[] = [];
        const changed: string[] = [];
        const removed: string[] = [];
        for (const ch of store.pendingChanges) {
            if (ch.kind === 'added') added.push(ch.handle.id);
            else if (ch.kind === 'removed') removed.push(ch.handle.id);
            else changed.push(ch.handle.id);
            directProducers.push({ registry: store.name, id: ch.handle.id });
            directConsumerKeys.add(`${store.name}:${ch.handle.id}`);
        }
        const parts: string[] = [];
        if (added.length) parts.push(`+${added.join(',')}`);
        if (changed.length) parts.push(`~${changed.join(',')}`);
        if (removed.length) parts.push(`-${removed.join(',')}`);
        lines.push(`${store.name} ${parts.join(' ')}`);
    }
    if (lines.length === 0) return;

    const propagated = getDirtyConsumers(directProducers);
    const novel = propagated.filter((c) => !directConsumerKeys.has(`${c.registry}:${c.id}`));
    let suffix = '';
    if (novel.length > 0) {
        const byReg = new Map<string, string[]>();
        for (const c of novel) {
            let bucket = byReg.get(c.registry);
            if (!bucket) {
                bucket = [];
                byReg.set(c.registry, bucket);
            }
            bucket.push(c.id);
        }
        const propParts: string[] = [];
        for (const [reg, ids] of byReg) propParts.push(`${reg} *${ids.join(',')}`);
        suffix = ` || via deps: ${propParts.join(' | ')}`;
    }

    console.log(`[hmr/${side}] ${lines.join(' | ')}${suffix}`);
}

/* ── prefab type + helpers (formerly project-module) ────────────── */

/**
 * what a prefab produces when instantiated.
 *   - 'voxels'   — voxel content only
 *   - 'nodes'    — node children only
 *   - 'composite'— both voxels and nodes
 */
export type PrefabType = 'voxels' | 'nodes' | 'composite';

/**
 * Any producer handle that carries a DepGraph `dependency` stamp. The
 * unified `deps: [...]` field on `prefab()` and `script()` accepts
 * anything matching this shape — scene, model, block, trait, command,
 * prefab handles, etc.
 */
export type DepHandle = { dependency: DepKey };

export type PrefabDef = {
    id: string;
    name: string;
    type: PrefabType;
    /**
     * producer handles whose changes trigger re-instantiation in edit mode.
     * each handle carries a DepGraph `dependency` stamp — `extractPrefabDeps`
     * reads it to wire reverse edges so DepGraph dirty propagation flags
     * this prefab when any closed-over producer flips.
     */
    deps: ReadonlyArray<DepHandle>;
    args?: { schema: Schema; default: unknown };
    node?: { realm?: Realm };
    apply: (ctx: unknown, args: unknown) => void;
};

/**
 * Read the stable id off any handle in `PrefabDef.deps`. Uses the
 * DepGraph `dependency` stamp so every producer kind (scene, model,
 * block, trait, command, prefab, …) flows through the same path.
 */
export function depId(dep: DepHandle): string {
    return dep.dependency.id;
}

/* ── wire-index helpers ─────────────────────────────────────────── */

/**
 * sort-by-id wire-index table over a kind store. encode via `idToIndex`,
 * decode via `indexToId`. recomputed lazily per `registry.<kind>.revision`.
 * both peers derive identical tables from their own store mirrors — no
 * handshake.
 */
export type WireIndex = { idToIndex: Map<string, number>; indexToId: string[] };

/** build a `WireIndex` from an id set (sort-by-id). also used by inbound-
 *  table rebuilds in engine-server/engine-client when a `wire_swap` message
 *  arrives — the incoming id list is already sorted by the sender, but we
 *  re-sort here to keep the helper a single canonical place where
 *  wire-index shape is established. */
export function buildWireIndex(ids: Iterable<string>): WireIndex {
    const indexToId = [...ids].sort();
    const idToIndex = new Map<string, number>();
    for (let i = 0; i < indexToId.length; i++) idToIndex.set(indexToId[i], i);
    return { idToIndex, indexToId };
}

/**
 * resolve a wire trait ref (netIndex preferred, id string as fallback) to
 * a trait id. takes a `WireIndex` directly (not the registry) so callers
 * can pass an inbound wire-index table — the one received via `wire_swap`
 * from the sending peer — rather than the local outbound table.
 */
export function resolveTraitWireRef(
    traitWireIndex: WireIndex,
    netIndex: number | undefined,
    id: string | undefined,
): string | undefined {
    if (netIndex !== undefined) return traitWireIndex.indexToId[netIndex];
    return id;
}

/* ── unified registry ───────────────────────────────────────────── */

export type Registry = {
    /** monotonic id bumped once per dispatch drain via `bumpVersion()`. */
    id: number;

    blockTextures: KindStore<BlockTextureDef>;
    blocks: KindStore<BlockHandle>;
    models: KindStore<ModelHandle>;
    traits: KindStore<TraitDef>;
    /**
     * per-trait control registrations, keyed `${traitId}.${controlId}`. one
     * entry per `control()` call. lets HMR diff individual controls without
     * tripping a wholesale trait change — `traitHash` covers body + meta
     * only, so re-eval that flips a single control body fires here, not on
     * `registry.traits`.
     */
    controls: KindStore<ControlDef>;
    /** per-trait sync registrations, keyed `${traitId}.${syncId}`. */
    sync: KindStore<SyncDef>;
    /** per-trait script registrations, keyed `${traitId}.${scriptId}` (same as `ScriptDef.key`). */
    scripts: KindStore<ScriptDef>;
    commands: KindStore<CommandDef>;
    scenes: KindStore<SceneHandle>;
    prefabs: KindStore<PrefabDef>;
    sounds: KindStore<SoundHandle>;
    sprites: KindStore<SpriteHandle>;
    particles: KindStore<ParticleHandle>;
    matchmaking: KindStore<MatchmakingConfig>;

    /** runtime block lookup; derived from `blocks` + `blockTextures`. */
    readonly blockRegistry: BlockRegistry;
    /** slot → trait def for O(1) lookup at runtime. */
    readonly traitsBySlot: Map<number, TraitDef>;
    /** sort-by-id wire-index over commands. */
    readonly commandWireIndex: WireIndex;
    /** sort-by-id wire-index over traits. */
    readonly traitWireIndex: WireIndex;
    /**
     * matchmaking config — `matchmakingRegistry` is single-keyed (id
     * 'main'); falls back to `DEFAULT_MATCHMAKING_CONFIG` when the user
     * didn't call `matchmaking()`.
     */
    readonly matchmakingConfig: MatchmakingConfig;

    /** tests only — wipes every KindStore + derived-view cache. */
    _reset(): void;
};

/* ── per-kind hash + extractDeps wiring ─────────────────────────── */

const blockTextureHash = (t: BlockTextureDef) => structuralHash(t);
const spriteHash = (s: SpriteHandle) => structuralHash(s);
const particleHash = (p: ParticleHandle) => structuralHash(p);

/**
 * blocks store the handle (not just the def) so the consumer can patch
 * `_baseStateId` / `_index` / `_hooks` directly. hash reads `_def` only —
 * the slot fields are populated by the consumer at build time and would
 * otherwise feed back as spurious change detection.
 */
const blockHash = (h: BlockHandle) => structuralHash(h._def);

/**
 * `extractDeps` resolves the model factory across every state and collects
 * referenced BlockTexture ids. The factory typically closes over
 * BlockTextureDef refs which `Function.prototype.toString()` can't see —
 * so the content hash stays stable when the closed-over texture is swapped.
 * DepGraph picks the swap up via the dep-set diff and elevates it to a
 * `changed` event, which the block-branch dispatch reacts to.
 */
const extractBlockDeps = (h: BlockHandle): DepKey[] => {
    const def = h._def;
    if (!def.model) return [];
    const textureIds = new Set<string>();
    for (let i = 0; i < def.states.totalStates; i++) {
        const props = def.states.decode(i);
        let model: BlockModel | undefined;
        try {
            model = def.model(props);
        } catch {
            continue;
        }
        collectModelTextureIds(model, textureIds);
    }
    const deps: DepKey[] = [];
    for (const id of textureIds) deps.push({ registry: 'blockTextures', id });
    return deps;
};

// ModelHandle carries a detached `scene: Node` tree (parent pointers form
// cycles) plus per-side `.bin` URLs. The bin URLs already embed a content
// hash codegen'd by buildModels, so they're a sufficient change-detection
// key on their own — hashing the Node tree would just recurse the cycle.
const modelHash = (h: ModelHandle) => structuralHash({ modelId: h.modelId, src: h.src, bin: h.bin });

const prefabHash = (p: PrefabDef) => structuralHash({ id: p.id, type: p.type, args: p.args, node: p.node, apply: p.apply });

const extractPrefabDeps = (p: PrefabDef): DepKey[] => {
    const deps: DepKey[] = [];
    for (const dep of p.deps) deps.push(dep.dependency);
    return deps;
};

// SceneHandle carries a deserialized `node: Node` tree (parent pointers
// form cycles) which is runtime state, not authored content. The authored
// payload (`_payload`) is the change driver — hashing that side-steps the
// cycle and matches the actual edit surface.
const sceneHash = (s: SceneHandle) => structuralHash({ id: s.id, client: s.client, server: s.server, payload: s._payload });

/**
 * trait body + meta only — controls / sync / scripts are diffed in their
 * own per-kind stores (registry.controls / registry.sync / registry.scripts).
 * if those collections were folded into traitHash, every script edit on a
 * trait would also fire a wholesale "trait changed" event, drowning the
 * granular per-kind dispatch and producing spurious editor toasts.
 */
const traitHash = (t: TraitDef) => structuralHash({ id: t.id, name: t.name, slot: t.slot, persist: t.persist, body: t.body });
const controlHash = (c: ControlDef) =>
    structuralHash({
        label: c.label,
        schema: c.schema,
        get: c.get,
        set: c.set,
        category: c.category,
        hidden: c.hidden,
    });
const syncHash = (s: SyncDef) =>
    structuralHash({
        schema: s.schema,
        pack: s.pack,
        unpack: s.unpack,
        rate: s.rate,
        authority: s.authority,
    });
const scriptHash = (s: ScriptDef) => structuralHash({ factory: s.factory, editor: s.editor });
const commandHash = (c: CommandDef) => structuralHash(c);
const matchmakingHash = (m: MatchmakingConfig) => structuralHash(m);

// SoundHandle is inert authoring metadata (src + long flag + codegen'd
// duration). Runtime state (decoded AudioBuffer) lives in
// client/audio/audio.ts keyed by id; the handle itself never carries it.
// `duration` is in the hash because the codegen barrel's in-place mutation
// needs to flow as a `changed` event.
const soundHash = (s: SoundHandle) => structuralHash({ soundId: s.soundId, src: s.src, long: s.long, duration: s.duration });

/* ── singleton ──────────────────────────────────────────────────── */

export function init(): Registry {
    const blockTextures = createKindStore<BlockTextureDef>({
        name: 'blockTextures',
        hash: blockTextureHash,
        diff: wholesaleDiff(blockTextureHash),
    });
    const blocks = createKindStore<BlockHandle>({
        name: 'blocks',
        hash: blockHash,
        diff: wholesaleDiff(blockHash),
        extractDeps: extractBlockDeps,
    });
    const models = createKindStore<ModelHandle>({
        name: 'models',
        hash: modelHash,
        diff: wholesaleDiff(modelHash),
    });
    const traits = createKindStore<TraitDef>({
        name: 'traits',
        hash: traitHash,
        diff: wholesaleDiff(traitHash),
        // every trait() call constructs a fresh TraitDef with empty
        // controls / sync / scripts collections; control() / sync() /
        // script() populate those collections on the freshly-built def.
        // when the body is unchanged the `change` event is suppressed, but
        // byId must still point at the new def so runtime lookups see the
        // freshly-populated collections.
        replaceIdentity: true,
    });
    const controls = createKindStore<ControlDef>({
        name: 'controls',
        hash: controlHash,
        diff: wholesaleDiff(controlHash),
    });
    const sync = createKindStore<SyncDef>({
        name: 'sync',
        hash: syncHash,
        diff: wholesaleDiff(syncHash),
    });
    // no `diff` — script factories close over arbitrary module-scope refs
    // that `Function.prototype.toString()` can't see. lean on "module
    // re-evaluated → fresh closure → swap", same approach as react-refresh.
    const scripts = createKindStore<ScriptDef>({
        name: 'scripts',
        hash: scriptHash,
    });
    const commands = createKindStore<CommandDef>({
        name: 'commands',
        hash: commandHash,
        diff: wholesaleDiff(commandHash),
    });
    const scenes = createKindStore<SceneHandle>({
        name: 'scenes',
        hash: sceneHash,
        diff: wholesaleDiff(sceneHash),
    });
    const prefabs = createKindStore<PrefabDef>({
        name: 'prefabs',
        hash: prefabHash,
        diff: wholesaleDiff(prefabHash),
        extractDeps: extractPrefabDeps,
    });
    const sounds = createKindStore<SoundHandle>({
        name: 'sounds',
        hash: soundHash,
        diff: wholesaleDiff(soundHash),
    });
    const sprites = createKindStore<SpriteHandle>({
        name: 'sprites',
        hash: spriteHash,
        diff: wholesaleDiff(spriteHash),
    });
    const particles = createKindStore<ParticleHandle>({
        name: 'particles',
        hash: particleHash,
        diff: wholesaleDiff(particleHash),
    });
    const matchmaking = createKindStore<MatchmakingConfig>({
        name: 'matchmaking',
        hash: matchmakingHash,
        diff: wholesaleDiff(matchmakingHash),
    });

    /* ── derived view caches (lazy, keyed on source revision) ─── */

    let blockRegistryCache: BlockRegistry | null = null;
    let blockRegistryKey: { blocks: number; blockTextures: number } | null = null;

    let traitsBySlotCache: Map<number, TraitDef> | null = null;
    let traitsBySlotKey = -1;

    let commandWireCache: WireIndex | null = null;
    let commandWireKey = -1;

    let traitWireCache: WireIndex | null = null;
    let traitWireKey = -1;

    const reg = {
        id: 0,
        blockTextures,
        blocks,
        models,
        traits,
        controls,
        sync,
        scripts,
        commands,
        scenes,
        prefabs,
        sounds,
        sprites,
        particles,
        matchmaking,
    } as Registry;

    Object.defineProperty(reg, 'blockRegistry', {
        enumerable: true,
        get() {
            const bRev = blocks.revision;
            const tRev = blockTextures.revision;
            if (
                blockRegistryCache &&
                blockRegistryKey &&
                blockRegistryKey.blocks === bRev &&
                blockRegistryKey.blockTextures === tRev
            ) {
                return blockRegistryCache;
            }
            const defs = new Map<string, BlockDef>();
            const handles = new Map<string, BlockHandle>();
            for (const [id, h] of blocks.byId) {
                handles.set(id, h.payload);
                defs.set(id, h.payload._def);
            }
            const textures = new Map<string, BlockTextureDef>();
            for (const [id, h] of blockTextures.byId) textures.set(id, h.payload);
            blockRegistryCache = buildBlockRegistry(defs, handles, textures);
            blockRegistryKey = { blocks: bRev, blockTextures: tRev };
            return blockRegistryCache;
        },
    });

    Object.defineProperty(reg, 'traitsBySlot', {
        enumerable: true,
        get() {
            if (traitsBySlotCache && traitsBySlotKey === traits.revision) {
                return traitsBySlotCache;
            }
            const map = new Map<number, TraitDef>();
            for (const [, h] of traits.byId) map.set(h.payload.slot, h.payload);
            traitsBySlotCache = map;
            traitsBySlotKey = traits.revision;
            return map;
        },
    });

    Object.defineProperty(reg, 'commandWireIndex', {
        enumerable: true,
        get() {
            if (commandWireCache && commandWireKey === commands.revision) {
                return commandWireCache;
            }
            commandWireCache = buildWireIndex(commands.byId.keys());
            commandWireKey = commands.revision;
            return commandWireCache;
        },
    });

    Object.defineProperty(reg, 'traitWireIndex', {
        enumerable: true,
        get() {
            if (traitWireCache && traitWireKey === traits.revision) {
                return traitWireCache;
            }
            traitWireCache = buildWireIndex(traits.byId.keys());
            traitWireKey = traits.revision;
            return traitWireCache;
        },
    });

    Object.defineProperty(reg, 'matchmakingConfig', {
        enumerable: true,
        get() {
            return matchmaking.byId.get('main')?.payload ?? DEFAULT_MATCHMAKING_CONFIG;
        },
    });

    // tests only — wipes every KindStore and derived-view cache so the next
    // test's setup starts from a virgin registry. used by tst/e2e/harness.ts.
    reg._reset = () => {
        const stores: KindStore<unknown>[] = [
            blockTextures,
            blocks,
            models,
            traits,
            controls,
            sync,
            scripts,
            commands,
            scenes,
            prefabs,
            sounds,
            sprites,
            particles,
            matchmaking,
        ] as KindStore<unknown>[];
        for (const s of stores) {
            s.byId.clear();
            s.byModule.clear();
            s.pending.clear();
            s.pendingChanges.length = 0;
            s.revision = 0;
        }
        blockRegistryCache = null;
        blockRegistryKey = null;
        traitsBySlotCache = null;
        traitsBySlotKey = -1;
        commandWireCache = null;
        commandWireKey = -1;
        traitWireCache = null;
        traitWireKey = -1;
        reg.id = 0;
    };

    return reg;
}

/**
 * bump once per dispatch drain — called by `applyRegistryChanges*` after
 * every branch has reacted. consumers that compare `registry.id` between
 * frames (e.g. cached views) see one increment per HMR cycle.
 */
export function bumpVersion(reg: Registry): void {
    reg.id++;
}

/** module-scope singleton — every declarative API upserts into this. */
export const registry = init();
