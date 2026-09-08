/**
 * core/registry.ts, unified declarative-content registry.
 *
 * one module-scope singleton (`registry`) bundles every declared kind
 * (blocks, blockTextures, models, traits, scripts, …) into a single
 * shape. user-facing APIs (`block()`, `trait()`, …) upsert into the
 * relevant per-kind `KindStore` via the primitives in this file; engine
 * consumers read `registry.blocks.byId.get(id)`, `registry.blockRegistry`,
 * `registry.protocol.commands`, etc.
 *
 * the derived index fields (`blockRegistry`, `slotToTrait`, `protocol`) are
 * PLAIN DATA rebuilt by `reindex(registry)` — once at engine boot (after user
 * modules register, before runtime) and again at the end of each dev flush
 * (`client/registry-dispatch.ts`, `server/registry-dispatch.ts`, which also
 * drain `pendingChanges` + `bumpVersion`). registrations only change at those
 * two moments, so plain fields refreshed there need no getter or revision key.
 */

import type * as pack from 'packcat';
import { clearDeps, type DepKey, getDirtyConsumers, setDeps } from './capture/dep-graph';
import { onModulePop, onModulePush, owningModule } from './capture/module-scope';
import { CONFIG_ID, type Config, DEFAULT_CONFIG } from './config';
import type { ModelDef, ModelHandle } from './models/handle';
import type { ParticleDef, ParticleHandle } from './particles/particles';
import type { CommandDef, CommandHandle, RpcDirection } from './rpc';
import type { Schema } from './scene/prop/prop';
import type { SceneDef, SceneHandle } from './scene/scene-handle';
import type { Realm } from './scene/scene-tree';
import type { ScriptDef } from './scene/scripts';
import type { ControlDef, SyncDef, TraitDef, TraitHandle } from './scene/traits';
import type { SoundDef, SoundHandle } from './sounds/sounds';
import type { SpriteDef, SpriteHandle } from './sprites/sprites';
import { _resetBlockSlots, type Blocks, buildBlockRegistry, createBlockRegistry } from './voxels/block-registry';
import {
    type BlockDef,
    type BlockHandle,
    type BlockModel,
    type BlockTextureDef,
    type BlockTextureHandle,
    collectModelTextureIds,
} from './voxels/blocks';

/* ── primitive types ────────────────────────────────────────────── */

/** HMR bookkeeping for one entry, parallel to `byId`. Only the reload path
 *  (change detection + passive deletion) reads it; runtime reads `byId`
 *  directly. `module` = owning module; `version` bumps per content change;
 *  `hash` is the last content fingerprint. */
export type EntryMeta = {
    module: string;
    version: number;
    hash: string;
};

export type Change<T> = { kind: 'added' | 'changed' | 'removed'; id: string; payload: T };

/**
 * per-kind storage. one of these per declared kind on the unified
 * `Registry`. `byId` maps id → payload DIRECTLY (dumb data, the runtime read
 * surface); `meta` holds the parallel HMR bookkeeping. carries ownership
 * bookkeeping, a pending-change queue, a monotonic revision counter, and the
 * kind-specific `hash` / `diff` / `extractDeps` functions.
 */
/** The stable, user-facing wrapper around a declared def. `def` is re-pointed on
 *  every re-declaration, so an importer that captured the handle keeps seeing
 *  current data — the contract `capture/module-scope.ts` relies on when it lets a
 *  module self-accept. Kinds add their own members (blocks' state helpers, a
 *  phantom type param) on top of these two. */
export type HandleOf<T> = {
    /** the declared id. Identity, not content: it can never change for a given
     *  handle (a re-declaration of the same id is by definition the same id), so
     *  unlike the def's mutable fields it is safe to carry here. */
    readonly id: string;
    readonly dependency: DepKey;
    def: T;
};

export type RegistryStore<T, H extends HandleOf<T> = HandleOf<T>> = {
    name: string;
    /** the DEF: pure declared data, swapped wholesale on re-declaration. Everything
     *  engine-side (indexes, hashing, `pendingChanges`) reads this. */
    byId: Map<string, T>;
    /**
     * id → the one handle ever minted for that id. MONOTONIC: entries are never
     * pruned, so a removed declaration leaves its handle pointing at the last def it
     * had rather than dangling, and a later re-declaration of the same id re-points
     * that same object. Same shape and lifetime as `traitSlots`.
     */
    handles: Map<string, H>;
    meta: Map<string, EntryMeta>;
    moduleToIds: Map<string, Set<string>>;
    seen: Map<string, Set<string>>;
    pendingChanges: Array<Change<T>>;
    /**
     * monotonic counter bumped every time a change is appended to
     * `pendingChanges` (add / change / remove). independent of the
     * draining lifecycle, consumers that run AFTER the engine drains
     * `pendingChanges` (e.g. the asset pipeline flush handler) compare
     * their last-seen revision to the current to decide whether to
     * re-run their builders. tied to actual content change via the
     * diff in `upsert`, so HMR re-evals with identical bodies don't
     * bump this.
     */
    revision: number;
    /**
     * optional, returns `true` when `a` and `b` should be treated as
     * different. when omitted, any re-`upsert` of an existing id fires
     * `changed` (react-refresh-style: the module re-evaluated, so the
     * payload is fresh by definition, no point comparing). suitable for
     * cheap-to-react kinds like scripts where over-swap is harmless.
     */
    diff?: (a: T, b: T) => boolean;
    hash: (t: T) => string;
    /**
     * optional, returns the set of producer keys this payload depends on.
     * runtime-resolved deps that wouldn't be visible to `hash` (e.g.
     * BlockDef.model is a factory; closed-over BlockTextureDef refs are
     * invisible to `Function.prototype.toString()`). called on every
     * add/change so the DepGraph reflects the current reality.
     */
    deps?: (payload: T) => DepKey[];
};

export type KindStoreOptions<T> = {
    name: string;
    diff?: (a: T, b: T) => boolean;
    hash: (t: T) => string;
    extractDeps?: (payload: T) => DepKey[];
};

/* ── hashing ────────────────────────────────────────────────────── */

/**
 * structural hash that handles functions, maps, sets, plain objects, and
 * primitives. used by every kind's `hash` to detect payload changes.
 * not crypto-grade, purpose is hmr change-detection only.
 */
export function structuralHash(value: unknown): string {
    return djb2(stringify(value));
}

/** objects on the current recursion path, so a back-reference degrades to a
 *  marker instead of overflowing the stack. Path-scoped, not visit-scoped: the
 *  same object appearing twice in different branches still hashes normally. */
const _hashPath = new Set<object>();

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
    if (_hashPath.has(obj)) return '<cycle>';
    _hashPath.add(obj);
    try {
        const keys = Object.keys(obj).sort();
        const parts = keys.map((k) => `${k}:${stringify(obj[k])}`);
        return `{${parts.join(',')}}`;
    } finally {
        _hashPath.delete(obj);
    }
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

function createRegistryStore<T, H extends HandleOf<T> = HandleOf<T>>(opts: KindStoreOptions<T>): RegistryStore<T, H> {
    const store: RegistryStore<T, H> = {
        name: opts.name,
        byId: new Map(),
        handles: new Map(),
        meta: new Map(),
        moduleToIds: new Map(),
        seen: new Map(),
        pendingChanges: [],
        revision: 0,
        diff: opts.diff,
        hash: opts.hash,
        deps: opts.extractDeps,
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
function beginModuleRun<T>(store: RegistryStore<T>, moduleId: string): void {
    store.seen.set(moduleId, new Set());
}

/**
 * any id this module owned previously but didn't re-declare this run
 * fires `removed`. called via the module-scope pop hook.
 */
function endModuleRun<T>(store: RegistryStore<T>, moduleId: string): void {
    const seen = store.seen.get(moduleId);
    if (!seen) return;
    const owned = store.moduleToIds.get(moduleId);
    if (!owned) {
        store.seen.delete(moduleId);
        return;
    }
    for (const id of owned) {
        if (seen.has(id)) continue;
        const payload = store.byId.get(id);
        if (payload === undefined) continue;
        store.byId.delete(id);
        store.meta.delete(id);
        owned.delete(id);
        store.pendingChanges.push({ kind: 'removed', id, payload });
        store.revision++;
        if (store.deps) clearDeps({ registry: store.name, id });
    }
    store.seen.delete(moduleId);
}

/* ── writes ─────────────────────────────────────────────────────── */

/**
 * synthetic owner for entries that exist before any "real" module has
 * claimed them. today's only producer is `model()`'s pre-codegen
 * placeholder, the user code calls `model('id')` before the codegen
 * barrel has emitted `_registerModelHandle('id', ...)`, so we still
 * need an entry in the registry (so the cli's pipeline read picks the
 * id up) but no real module owns it yet. When the real owner finally
 * calls `upsert`, ownership is reassigned without firing the mismatch
 * guard.
 */
export const PLACEHOLDER_OWNER = '__placeholder__';

export function upsert<T>(store: RegistryStore<T>, id: string, payload: T): T {
    const module = owningModule();
    const pending = store.seen.get(module);
    pending?.add(id);

    const existing = store.byId.get(id);
    const existingMeta = store.meta.get(id);

    if (existing === undefined || existingMeta === undefined) {
        store.byId.set(id, payload);
        store.meta.set(id, { module, version: 0, hash: store.hash(payload) });
        addOwnership(store, module, id);
        store.pendingChanges.push({ kind: 'added', id, payload });
        store.revision++;
        if (store.deps) {
            setDeps({ registry: store.name, id }, store.deps(payload));
        }
        return payload;
    }

    if (existingMeta.module !== module) {
        // PLACEHOLDER_OWNER entries are claimed via `claimOwnership` +
        // mutate-in-place, not via upsert, so any module-mismatch here
        // is a genuine redeclaration conflict.
        throw new Error(`[registry:${store.name}] '${id}' redeclared by ${module}, owned by ${existingMeta.module}`);
    }

    // when `diff` is omitted, any re-upsert is a change, module
    // re-evaluation produced a fresh payload, that's the only way we got
    // here (cf. react-refresh, which also doesn't compare bodies).
    const changed = store.diff ? store.diff(existing, payload) : true;

    // refresh deps and capture whether the dep set differs from before.
    // closure-bound producers (e.g. BlockDef.model factory closing over a
    // BlockTextureDef ref) are invisible to `hash`, so the content diff
    // can short-circuit even when the consumer's effective producer set
    // moved. when that happens we elevate to a synthetic `changed` event
    // so dispatch reacts.
    const depsChanged = store.deps ? setDeps({ registry: store.name, id }, store.deps(payload)) : false;

    if (!changed && !depsChanged) {
        // content unchanged, but still overwrite `byId` with the freshly-eval'd
        // payload. some payloads (TraitDef) carry mutable sibling collections
        // (controls/sync/scripts) filled in AFTER creation by later calls, and
        // consumers key caches on payload identity (the packcat codec WeakMaps),
        // so the registry must track the exact object user code holds. no
        // `changed` event fires — a no-op re-eval stays silent to dispatch.
        store.byId.set(id, payload);
        store.revision++;
        return payload;
    }

    store.byId.set(id, payload);
    store.meta.set(id, { module, version: existingMeta.version + 1, hash: store.hash(payload) });
    store.pendingChanges.push({ kind: 'changed', id, payload });
    store.revision++;
    return payload;
}

/**
 * Re-hash an existing handle in place and fire `changed` if hash or dep set
 * moved. The handle's payload identity is preserved, callers mutate
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
/**
 * Declare an entity from user module scope. The DEF is swapped wholesale (it is
 * pure data); the HANDLE is minted once and re-pointed at the new def, so it keeps
 * its identity for the life of the process.
 *
 * That identity is the contract `capture/module-scope.ts` relies on when it lets a
 * module self-accept: a module whose exports are all handles is patched rather than
 * invalidated, so its importers are deliberately NOT re-evaluated and keep the
 * binding they already hold. Only sound if that binding is the one being updated.
 *
 * `mintDef` receives the def currently registered for this id, or undefined on a
 * cold declaration. Most kinds ignore it and build fresh. The ones whose def is
 * assembled from two sources — a codegen barrel plus the user's call, i.e. models
 * and sounds — merge onto it, which is why this is a parameter rather than a
 * wholesale replace.
 *
 * `touch` re-hashes afterwards and fires `changed` only if the content actually
 * moved, so a no-op re-eval stays silent to dispatch.
 */
export function declare<T, H extends HandleOf<T>>(
    store: RegistryStore<T, H>,
    id: string,
    mintDef: (previous: T | undefined) => T,
    mintHandle: (def: T, previous: H | undefined) => H,
): H {
    const def = mintDef(store.byId.get(id));

    // `mintHandle` runs on EVERY declaration, not only the first. A handle carries
    // two sorts of member: identity (`id`, `dependency`, a trait's slot), which
    // re-computes to the same value, and state DERIVED from the def (a trait's
    // compiled constructor and codec memos, a block's state helpers), which has to
    // be rebuilt whenever the def moves. Building the whole handle and merging it
    // onto the surviving object gets both without a second per-kind hook: identity
    // holds because the object is the same one, and no derived field can be
    // forgotten because `mintHandle` returns a complete `H` by construction. Same
    // refill-in-place move as `buildBlockRegistry`.
    const existing = store.handles.get(id);
    const fresh = mintHandle(def, existing);
    const handle = existing === undefined ? fresh : Object.assign(existing, fresh);
    if (existing === undefined) store.handles.set(id, handle);

    // `byId` can already hold an entry with no handle yet: a codegen barrel seeds
    // placeholders under PLACEHOLDER_OWNER before user code runs. That is a
    // re-declaration as far as ownership goes, so it takes the claim path.
    if (store.byId.has(id)) {
        claimOwnership(store, id);
        store.byId.set(id, def);
        touch(store, id);
        return handle;
    }
    upsert(store, id, def);
    return handle;
}

export function touch<T>(store: RegistryStore<T>, id: string): void {
    const payload = store.byId.get(id);
    const meta = store.meta.get(id);
    if (payload === undefined || meta === undefined) return;

    const newHash = store.hash(payload);
    const hashChanged = newHash !== meta.hash;
    const depsChanged = store.deps ? setDeps({ registry: store.name, id }, store.deps(payload)) : false;

    if (!hashChanged && !depsChanged) return;

    meta.hash = newHash;
    meta.version++;
    store.pendingChanges.push({ kind: 'changed', id, payload });
    store.revision++;
}

function addOwnership<T>(store: RegistryStore<T>, module: string, id: string): void {
    let owned = store.moduleToIds.get(module);
    if (!owned) {
        owned = new Set();
        store.moduleToIds.set(module, owned);
    }
    owned.add(id);
}

function removeOwnership<T>(store: RegistryStore<T>, module: string, id: string): void {
    const owned = store.moduleToIds.get(module);
    if (!owned) return;
    owned.delete(id);
    if (owned.size === 0) store.moduleToIds.delete(module);
}

/**
 * Register an entry without claiming module-scope ownership, for cases
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
export function upsertPlaceholder<T>(store: RegistryStore<T>, id: string, payload: T): T {
    const existing = store.byId.get(id);
    if (existing !== undefined) return existing;

    store.byId.set(id, payload);
    store.meta.set(id, { module: PLACEHOLDER_OWNER, version: 0, hash: store.hash(payload) });
    addOwnership(store, PLACEHOLDER_OWNER, id);
    store.pendingChanges.push({ kind: 'added', id, payload });
    store.revision++;
    if (store.deps) {
        setDeps({ registry: store.name, id }, store.deps(payload));
    }
    return payload;
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
 * Throws when the entry is owned by a different real module, this
 * catches duplicate `model('id', ...)` / `block('id', ...)` declarations
 * across files, same as `upsert`'s mismatch guard.
 */
export function claimOwnership<T>(store: RegistryStore<T>, id: string): void {
    const meta = store.meta.get(id);
    if (!meta) return;
    const module = owningModule();
    store.seen.get(module)?.add(id);

    if (meta.module === module) return;
    if (meta.module === PLACEHOLDER_OWNER) {
        removeOwnership(store, PLACEHOLDER_OWNER, id);
        addOwnership(store, module, id);
        meta.module = module;
        return;
    }
    throw new Error(`[registry:${store.name}] '${id}' redeclared by ${module}, owned by ${meta.module}`);
}

/* ── reads ──────────────────────────────────────────────────────── */

export function get<T>(store: RegistryStore<T>, id: string): T | undefined {
    return store.byId.get(id);
}

/* ── hmr utilities ──────────────────────────────────────────────── */

/**
 * Drain every store's `pendingChanges` queue without acting on it. Called
 * once per side at the end of `EngineClient.load` / `EngineServer.load` to
 * discard the initial-population `added` events, the engine consumes the
 * live registry directly, so those events are redundant and would
 * otherwise drown out the actual first edit in the dispatch log.
 */
export function clearPendingChanges(stores: ReadonlyArray<RegistryStore<any>>): void {
    for (const store of stores) store.pendingChanges.length = 0;
}

/**
 * Render a human-readable summary of pending changes across stores,
 * prefixed with the side that fired (`client` / `server`). Called at the
 * top of each `applyRegistryChanges*` so devs can see what hot reloaded
 * without instrumenting the rest of the pipeline.
 */
export function logPendingChanges(side: 'client' | 'server', stores: ReadonlyArray<RegistryStore<any>>): void {
    const lines: string[] = [];
    const directProducers: DepKey[] = [];
    const directConsumerKeys = new Set<string>();
    for (const store of stores) {
        if (store.pendingChanges.length === 0) continue;
        const added: string[] = [];
        const changed: string[] = [];
        const removed: string[] = [];
        for (const ch of store.pendingChanges) {
            if (ch.kind === 'added') added.push(ch.id);
            else if (ch.kind === 'removed') removed.push(ch.id);
            else changed.push(ch.id);
            directProducers.push({ registry: store.name, id: ch.id });
            directConsumerKeys.add(`${store.name}:${ch.id}`);
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
 *   - 'voxels', voxel content only
 *   - 'nodes', node children only
 *   - 'composite', both voxels and nodes
 */
export type PrefabType = 'voxels' | 'nodes' | 'composite';

/**
 * Any producer handle that carries a DepGraph `dependency` stamp. The
 * unified `deps: [...]` field on `prefab()` and `script()` accepts
 * anything matching this shape, scene, model, block, trait, command,
 * prefab handles, etc.
 */
export type DepHandle = { dependency: DepKey };

export type PrefabDef = {
    id: string;
    name: string;
    type: PrefabType;
    /**
     * producer handles whose changes trigger re-instantiation in edit mode.
     * each handle carries a DepGraph `dependency` stamp, `extractPrefabDeps`
     * reads it to wire reverse edges so DepGraph dirty propagation flags
     * this prefab when any closed-over producer flips.
     */
    deps: ReadonlyArray<DepHandle>;
    args?: { schema: Schema; default: unknown };
    node?: { realm?: Realm };
    apply: (ctx: unknown, args: unknown) => void;
};

/** Stable wrapper around a `PrefabDef`. Carries identity plus the live def; the
 *  data itself is read through `.def` rather than copied out (see `declare`). */
export type PrefabHandle<Args = unknown> = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /** DepGraph dependency + the brand `isHandle` tests. */
    dependency: { registry: 'prefabs'; id: string };
    /** the declared data. re-pointed on every re-declaration. */
    def: PrefabDef;
    /** phantom, carries the args type for inference. not present at runtime. */
    readonly __args: Args;
};

/**
 * Read the stable id off any handle in `PrefabDef.deps`. Uses the
 * DepGraph `dependency` stamp so every producer kind (scene, model,
 * block, trait, command, prefab, …) flows through the same path.
 */
export function depId(dep: DepHandle): string {
    return dep.dependency.id;
}

/* ── network protocol tables ────────────────────────────────────── */

/**
 * sort-by-id table for one id space (traits or commands). encode a ref via
 * `idToIndex`, decode via `indexToId`. both peers derive identical tables from
 * their own registrations; the manifest reconciles any set difference by id.
 */
export type ProtocolTable = { idToIndex: Map<string, number>; indexToId: string[] };

/** build a `ProtocolTable` from an id set (sort-by-id). also rebuilds an
 *  inbound table from a peer's manifest id list (already sorted by the sender;
 *  we re-sort so this stays the single canonical place table shape is set). */
export function buildProtocolTable(ids: Iterable<string>): ProtocolTable {
    const indexToId = [...ids].sort();
    const idToIndex = new Map<string, number>();
    for (let i = 0; i < indexToId.length; i++) idToIndex.set(indexToId[i], i);
    return { idToIndex, indexToId };
}

/**
 * resolve a wire trait ref (netIndex preferred, id string as fallback) to a
 * trait id. takes a `ProtocolTable` directly so callers can pass the INBOUND
 * table (the peer's, from its manifest) rather than the local one.
 */
export function resolveTraitWireRef(
    table: ProtocolTable,
    netIndex: number | undefined,
    id: string | undefined,
): string | undefined {
    if (netIndex !== undefined) return table.indexToId[netIndex];
    return id;
}

/**
 * The full id manifest one peer publishes so the other can decode its traffic
 * by id, never by a coincidental local slot. `traits`/`commands` are sort-by-id
 * (the sender encodes trait/command refs against these positions); `syncs` and
 * `controls` are parallel to `traits` and list each trait's sync/control ids in
 * the SENDER's own slot order (the order it packs field slices in).
 */
export type ProtocolManifest = {
    traits: string[];
    commands: string[];
    syncs: string[][];
    controls: string[][];
};

/** Build this side's manifest from the registry. Cheap; sent once per
 *  connection and again whenever the registrations change (dev flush). */
export function protocolManifest(reg: Registry): ProtocolManifest {
    const traits = [...reg.traits.byId.keys()].sort();
    const syncs: string[][] = [];
    const controls: string[][] = [];
    for (const id of traits) {
        const def = reg.traits.byId.get(id)!;
        syncs.push(def.sync.map((s) => s.syncId));
        controls.push(def.controls.map((c) => c.controlId));
    }
    return { traits, commands: [...reg.commands.byId.keys()].sort(), syncs, controls };
}

/** Per-trait map from a peer's field slot (the slot on the wire) to OUR local
 *  slot. A slot the peer has but we don't is `undefined` — that one field is
 *  dropped, neighbours unaffected. */
export type SlotRemap = (number | undefined)[];

/**
 * A resolved inbound decode context for one peer: the peer's trait/command
 * tables plus, per trait id, the sync/control slot maps. Every trait the peer
 * published (that we also have a def for) has an entry, so a resolved trait
 * always yields a concrete remap — callers never branch on its presence.
 */
export type InboundProtocol = {
    traits: ProtocolTable;
    commands: ProtocolTable;
    syncRemap: Map<string, SlotRemap>;
    controlRemap: Map<string, SlotRemap>;
};

/** Build an `InboundProtocol` from a peer's manifest, resolving its per-trait
 *  sync and control slots against OUR local trait defs by id. */
export function buildInboundProtocol(manifest: ProtocolManifest, reg: Registry): InboundProtocol {
    const syncRemap = new Map<string, SlotRemap>();
    const controlRemap = new Map<string, SlotRemap>();
    for (let i = 0; i < manifest.traits.length; i++) {
        const traitId = manifest.traits[i];
        const handle = reg.traits.handles.get(traitId);
        if (!handle) continue; // peer trait we lack; its refs drop at trait resolve, never remapped
        syncRemap.set(
            traitId,
            (manifest.syncs[i] ?? []).map((sid) => handle.syncById.get(sid)?.index),
        );
        controlRemap.set(
            traitId,
            (manifest.controls[i] ?? []).map((cid) => handle.controlsById.get(cid)?.index),
        );
    }
    return {
        traits: buildProtocolTable(manifest.traits),
        commands: buildProtocolTable(manifest.commands),
        syncRemap,
        controlRemap,
    };
}

/** The identity `InboundProtocol` for our OWN registry — the decode context for
 *  in-process (no peer) callers, so decode paths always receive a concrete
 *  context. Cheap; callers that have it hot can hold the result. */
export function localInbound(reg: Registry): InboundProtocol {
    return buildInboundProtocol(protocolManifest(reg), reg);
}

/**
 * resolve the game config; single-keyed (id 'main'), falls back to the default
 * when the user didn't call `config()`.
 */
export function resolveConfig(reg: Registry): Config {
    return reg.config.byId.get(CONFIG_ID) ?? DEFAULT_CONFIG;
}

/**
 * Rebuild the registry's derived index fields (`slotToTrait`, `blockRegistry`,
 * `protocol`) from the source stores. Called once at engine boot (after user
 * modules have registered, before runtime reads) and at the end of each dev
 * flush. Registrations only change at those two moments, so plain fields
 * refreshed here need no getter, revision key, or per-read check.
 */
export function reindexRegistry(reg: Registry): void {
    // indexed by slot rather than keyed by it: slots come from one dense counter, and this
    // is read per trait per node per client in the replication fan-out.
    const slotToTrait: Array<TraitHandle | undefined> = [];
    for (const handle of reg.traits.handles.values()) slotToTrait[handle.slot] = handle;
    reg.slotToTrait = slotToTrait;

    const defs = new Map<string, BlockDef>();
    const handles = new Map<string, BlockHandle>();
    for (const [id, def] of reg.blocks.byId) {
        defs.set(id, def);
        const handle = reg.blocks.handles.get(id);
        if (handle) handles.set(id, handle);
    }
    const textures = new Map<string, BlockTextureDef>();
    for (const [id, h] of reg.blockTextures.byId) textures.set(id, h);
    // IN PLACE: `voxels.registry`, the per-room scene context, blueprint canvases
    // and content-store scene voxels all hold this object. Rebinding the field
    // would leave every one of them reading tables sized for the old state count.
    buildBlockRegistry(reg.blockRegistry, defs, handles, textures);

    reg.protocol = {
        traits: buildProtocolTable(reg.traits.byId.keys()),
        commands: buildProtocolTable(reg.commands.byId.keys()),
    };

    // the wire index is sort-by-id and moves whenever the trait set does, so it is stamped
    // here rather than looked up by string id on every emitted trait.
    for (const handle of reg.traits.handles.values()) handle.netIndex = reg.protocol.traits.idToIndex.get(handle.id);
}

/* ── unified registry ───────────────────────────────────────────── */

export type Registry = {
    /** monotonic id bumped once per dispatch drain via `bumpVersion()`. */
    version: number;

    blockTextures: RegistryStore<BlockTextureDef, BlockTextureHandle>;
    blocks: RegistryStore<BlockDef, BlockHandle>;
    models: RegistryStore<ModelDef, ModelHandle>;
    traits: RegistryStore<TraitDef, TraitHandle>;
    /**
     * per-trait control registrations, keyed `${traitId}.${controlId}`. one
     * entry per `control()` call. lets HMR diff individual controls without
     * tripping a wholesale trait change, `traitHash` covers body + meta
     * only, so re-eval that flips a single control body fires here, not on
     * `registry.traits`.
     */
    controls: RegistryStore<ControlDef>;
    /** per-trait sync registrations, keyed `${traitId}.${syncId}`. */
    sync: RegistryStore<SyncDef>;
    /** per-trait script registrations, keyed `${traitId}.${scriptId}` (same as `ScriptDef.key`). */
    scripts: RegistryStore<ScriptDef>;
    commands: RegistryStore<CommandDef, CommandHandle<pack.Schema, RpcDirection>>;
    scenes: RegistryStore<SceneDef, SceneHandle>;
    prefabs: RegistryStore<PrefabDef, PrefabHandle>;
    sounds: RegistryStore<SoundDef, SoundHandle>;
    sprites: RegistryStore<SpriteDef, SpriteHandle>;
    particles: RegistryStore<ParticleDef, ParticleHandle>;
    config: RegistryStore<Config>;

    /** runtime block lookup; derived from `blocks` + `blockTextures`.
     *  rebuilt by `reindexRegistry()` at boot + each dev flush — a plain field. */
    blockRegistry: Blocks;
    /** slot → trait HANDLE for O(1) runtime lookup — the handle, because callers
     *  need its derived state (codecs, by-id maps) as well as `.def`. rebuilt by
     *  `reindexRegistry()`. */
    slotToTrait: Array<TraitHandle | undefined>;
    /** sort-by-id wire tables for the network protocol. rebuilt by `reindexRegistry()`. */
    protocol: { traits: ProtocolTable; commands: ProtocolTable };

    /** tests only, wipes every KindStore. */
    _reset(): void;
};

/* ── per-kind hash + extractDeps wiring ─────────────────────────── */

const blockTextureHash = (t: BlockTextureDef) => structuralHash(t);
const spriteHash = (s: SpriteDef) => structuralHash(s);
const particleHash = (p: ParticleDef) => structuralHash(p);

/**
 * blocks store the handle (not just the def) so the consumer can patch
 * `_baseStateId` / `_index` / `_hooks` directly. hash reads `_def` only,
 * the slot fields are populated by the consumer at build time and would
 * otherwise feed back as spurious change detection.
 */
const blockHash = (d: BlockDef) => structuralHash(d);

/**
 * `extractDeps` resolves the model factory across every state and collects
 * referenced BlockTexture ids. The factory typically closes over
 * BlockTextureDef refs which `Function.prototype.toString()` can't see,
 * so the content hash stays stable when the closed-over texture is swapped.
 * DepGraph picks the swap up via the dep-set diff and elevates it to a
 * `changed` event, which the block-branch dispatch reacts to.
 */
const extractBlockDeps = (def: BlockDef): DepKey[] => {
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
        if (model) collectModelTextureIds(model, textureIds);
    }
    const deps: DepKey[] = [];
    for (const id of textureIds) deps.push({ registry: 'blockTextures', id });
    return deps;
};

// NOT wholesale, and deliberately so: `ModelDef` carries a detached `scene: Node`
// tree (parent pointers form cycles) plus per-side `.bin` URLs, and `version` is
// bumped at runtime when the payload reloads. The bin URLs already embed a content
// hash codegen'd by buildModels, so they are a sufficient change-detection key on
// their own; hashing the Node tree would just recurse the cycle.
const modelHash = (d: ModelDef) => structuralHash({ modelId: d.modelId, src: d.src, bin: d.bin });

const prefabHash = (p: PrefabDef) => structuralHash({ id: p.id, type: p.type, args: p.args, node: p.node, apply: p.apply });

const extractPrefabDeps = (p: PrefabDef): DepKey[] => {
    const deps: DepKey[] = [];
    for (const dep of p.deps) deps.push(dep.dependency);
    return deps;
};

// SceneHandle carries a deserialized `node: Node` tree (parent pointers
// form cycles) which is runtime state, not authored content. The authored
// payload (`_payload`) is the change driver, hashing that side-steps the
// cycle and matches the actual edit surface.
const sceneHash = (s: SceneDef) => structuralHash(s);

/**
 * trait body + meta only, controls / sync / scripts are diffed in their
 * own per-kind stores (registry.controls / registry.sync / registry.scripts).
 * if those collections were folded into traitHash, every script edit on a
 * trait would also fire a wholesale "trait changed" event, drowning the
 * granular per-kind dispatch.
 */
// NOT wholesale, unlike the other kinds: `controls` / `sync` / `scripts` have their
// own per-id stores precisely so a single control edit fires there rather than
// forcing a wholesale trait swap. Hashing them here would collapse that.
const traitHash = (t: TraitDef) => structuralHash({ id: t.id, name: t.name, persist: t.persist, body: t.body });
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
        dirty: s.dirty,
        rate: s.rate,
        authority: s.authority,
    });
const scriptHash = (s: ScriptDef) => structuralHash({ factory: s.factory, editor: s.editor });
// `serdes` is derived from `schema` and `handle` is derived identity; hashing either
// would make every re-declaration look like a content change.
const commandHash = (c: CommandDef) => structuralHash({ id: c.id, direction: c.direction, schema: c.schema });
const configHash = (c: Config) => structuralHash(c);

// SoundHandle is inert authoring metadata (src + long flag + codegen'd
// duration). Runtime state (decoded AudioBuffer) lives in
// client/audio/audio.ts keyed by id; the handle itself never carries it.
// `duration` is in the hash because the codegen barrel's in-place mutation
// needs to flow as a `changed` event.
// `version` is bumped at runtime by the barrel, so it can't be hashed; `name` is
// cosmetic and deliberately doesn't fire a change.
const soundHash = (s: SoundDef) => structuralHash({ soundId: s.soundId, src: s.src, long: s.long, duration: s.duration });

/* ── singleton ──────────────────────────────────────────────────── */

export function init(): Registry {
    const blockTextures = createRegistryStore<BlockTextureDef, BlockTextureHandle>({
        name: 'blockTextures',
        hash: blockTextureHash,
        diff: wholesaleDiff(blockTextureHash),
    });
    const blocks = createRegistryStore<BlockDef, BlockHandle>({
        name: 'blocks',
        hash: blockHash,
        diff: wholesaleDiff(blockHash),
        extractDeps: extractBlockDeps,
    });
    const models = createRegistryStore<ModelDef, ModelHandle>({
        name: 'models',
        hash: modelHash,
        diff: wholesaleDiff(modelHash),
    });
    const traits = createRegistryStore<TraitDef, TraitHandle>({
        name: 'traits',
        hash: traitHash,
        diff: wholesaleDiff(traitHash),
    });
    const controls = createRegistryStore<ControlDef>({
        name: 'controls',
        hash: controlHash,
        diff: wholesaleDiff(controlHash),
    });
    const sync = createRegistryStore<SyncDef>({
        name: 'sync',
        hash: syncHash,
        diff: wholesaleDiff(syncHash),
    });
    // no `diff`, script factories close over arbitrary module-scope refs
    // that `Function.prototype.toString()` can't see. lean on "module
    // re-evaluated → fresh closure → swap", same approach as react-refresh.
    const scripts = createRegistryStore<ScriptDef>({
        name: 'scripts',
        hash: scriptHash,
    });
    const commands = createRegistryStore<CommandDef, CommandHandle<pack.Schema, RpcDirection>>({
        name: 'commands',
        hash: commandHash,
        diff: wholesaleDiff(commandHash),
    });
    const scenes = createRegistryStore<SceneDef, SceneHandle>({
        name: 'scenes',
        hash: sceneHash,
        diff: wholesaleDiff(sceneHash),
    });
    const prefabs = createRegistryStore<PrefabDef, PrefabHandle>({
        name: 'prefabs',
        hash: prefabHash,
        diff: wholesaleDiff(prefabHash),
        extractDeps: extractPrefabDeps,
    });
    const sounds = createRegistryStore<SoundDef, SoundHandle>({
        name: 'sounds',
        hash: soundHash,
        diff: wholesaleDiff(soundHash),
    });
    const sprites = createRegistryStore<SpriteDef, SpriteHandle>({
        name: 'sprites',
        hash: spriteHash,
        diff: wholesaleDiff(spriteHash),
    });
    const particles = createRegistryStore<ParticleDef, ParticleHandle>({
        name: 'particles',
        hash: particleHash,
        diff: wholesaleDiff(particleHash),
    });
    const config = createRegistryStore<Config>({
        name: 'config',
        hash: configHash,
        diff: wholesaleDiff(configHash),
    });

    const reg = {
        version: 0,
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
        config,
        // derived index fields — start empty; `reindexRegistry()` fills them at engine
        // boot (after user modules register) and at each dev flush. `blockRegistry` is
        // a real empty struct from the outset (never rebound after this), so holders
        // can take the reference at any time; `createBlockRegistry` touches no sibling
        // module, unlike `buildBlockRegistry`, which would trip circular init here.
        slotToTrait: [] as Array<TraitHandle | undefined>,
        blockRegistry: createBlockRegistry(),
        protocol: { traits: buildProtocolTable([]), commands: buildProtocolTable([]) },
    } as Registry;

    // tests only, wipes every KindStore so the next test's setup starts from a
    // virgin registry, then rebuilds the (now empty) derived indexes. used by
    // tst/e2e/harness.ts.
    reg._reset = () => {
        const stores: RegistryStore<unknown>[] = [
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
            config,
        ] as RegistryStore<unknown>[];
        for (const s of stores) {
            s.byId.clear();
            s.meta.clear();
            s.moduleToIds.clear();
            s.seen.clear();
            s.pendingChanges.length = 0;
            s.revision = 0;
        }
        reg.version = 0;
        // block state-id reservations are process-lifetime; a suite declaring a
        // different block set per case would otherwise keep growing the high-water
        // mark every table is sized from.
        _resetBlockSlots();
        reindexRegistry(reg);
    };

    return reg;
}

/**
 * bump once per dispatch drain, called by `applyRegistryChanges*` after
 * every branch has reacted. consumers that compare `registry.id` between
 * frames (e.g. cached views) see one increment per HMR cycle.
 */
export function bumpVersion(reg: Registry): void {
    reg.version++;
}

/** module-scope singleton, every declarative API upserts into this. */
export const registry = init();
