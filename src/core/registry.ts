/**
 * core/registry.ts, unified declarative-content registry.
 *
 * one module-scope singleton (`registry`) bundles every declared kind
 * (blocks, tiles, models, traits, scripts, …) into a single
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

import * as pack from 'packcat';
import { emptyArgsSchema, noopApply, type PrefabOptions } from '../api/prefabs';
import { resolveAssetMeta } from './asset-meta';
import { clearDeps, type DepKey, getDirtyConsumers, setDeps } from './capture/dep-graph';
import { onModulePop, onModulePush, owningModule, recordDeclaration } from './capture/module-scope';
import { CONFIG_ID, type Config, DEFAULT_CONFIG, HARD_MAX_PLAYERS_PER_ROOM } from './config';
import type { ScenePayload } from './content/scene-store';
import type { ModelDef, ModelHandle } from './models/handle';
import { createModelPlaceholderDef, type ModelHandleMap, type ModelOptions } from './models/models';
import type { ParticleDef, ParticleHandle, ParticleOptions } from './particles/particles';
import type { CommandDef, CommandHandle, RpcDirection } from './rpc';
import type { PrefabApplyContext } from './scene/prefab';
import type { Schema, SchemaType } from './scene/prop/prop';
import { createSceneDef, createSceneHandle, type SceneDef, type SceneHandle, type SceneOptions } from './scene/scene-handle';
import type { Realm } from './scene/scene-tree';
import type { ScriptDef, ScriptFactory, ScriptOptions } from './scene/scripts';
import {
    type ControlBody,
    type ControlDef,
    controlsById,
    type SyncBody,
    type SyncDef,
    type SyncHandle,
    setSyncDirty,
    syncById,
    type TraitBase,
    type TraitBody,
    type TraitDef,
    type TraitHandle,
    type TraitInstance,
    type TraitOptions,
} from './scene/traits';
import {
    createSoundPlaceholderDef,
    type SoundDef,
    type SoundHandle,
    type SoundHandleMap,
    type SoundOptions,
} from './sounds/sounds';
import type { ImageSource, SpriteDef, SpriteHandle, SpriteOptions } from './sprites/sprites';
import type { DrawFn, DrawInputs, DrawParams } from './textures/draw-fn';
import {
    isComputedOptions,
    type TextureDef,
    type TextureHandle,
    type TextureOptions,
    textureInputDeps,
} from './textures/textures';
import { _resetBlockSlots, type Blocks, buildBlockRegistry, createBlockRegistry, formatKey } from './voxels/block-registry';
import type { BlockStateDef, PropsDef } from './voxels/block-state';
import {
    type BlockDef,
    type BlockHandle,
    type BlockModel,
    type BlockOptions,
    CullType,
    collectModelTileIds,
    deriveBlockDust,
    EMPTY_STATES,
    MaterialType,
    type TileDef,
    type TileHandle,
    type TileOptions,
} from './voxels/blocks';

/* ── primitive types ────────────────────────────────────────────── */

/** HMR bookkeeping for one entry, parallel to `byId`. */
export type EntryMeta = {
    /** module id that owns this entry, or `PLACEHOLDER_OWNER` while unclaimed. */
    module: string;
    /** bumped whenever a re-declaration actually moved the content. */
    version: number;
    /** `store.hash(def)` as of the last accepted change; the change detector.
     *  `undefined` when the kind's hash cannot describe this def — see
     *  `KindOptions.hash`, which then reports every re-declaration. */
    hash: string | undefined;
};

export type Change<T> = { kind: 'added' | 'changed' | 'removed'; id: string; payload: T };

/**
 * The two members every handle carries. `id` is identity, not content: a
 * re-declaration of an id is by definition the same id. `def` is the one
 * member `declare` writes.
 *
 * Kinds add their own members on top, but only ones that cannot be derived —
 * see invariant 2 in the file header.
 */
export type HandleOf<T> = {
    readonly id: string;
    readonly dependency: DepKey;
    def: T;
};

export type RegistryStore<T, H extends HandleOf<T> = HandleOf<T>> = {
    name: string;
    /** the DEF: pure declared data, swapped wholesale on re-declaration. */
    byId: Map<string, T>;
    /**
     * id → the one handle ever minted for it. MONOTONIC: entries are never
     * pruned, so a removed declaration leaves its handle pointing at the last
     * def it had rather than dangling, and a later re-declaration re-points
     * that same object. Derived indexes must therefore iterate `byId`, not
     * this — a handle in here may name an id the store no longer holds.
     */
    handles: Map<string, H>;
    meta: Map<string, EntryMeta>;
    moduleToIds: Map<string, Set<string>>;
    /** ids declared by each module during the run currently in progress. */
    seen: Map<string, Set<string>>;
    pendingChanges: Array<Change<T>>;
    /**
     * monotonic, bumped whenever a change is appended. Consumers that run
     * after the engine drains `pendingChanges` compare their last-seen
     * revision to decide whether to re-run.
     */
    revision: number;
    hash: (def: T) => string | undefined;
    deps?: (def: T) => DepKey[];
    hmr?: { signature?: (def: T) => string };
    handle: (id: string) => Omit<H, 'def'> & ThisType<H>;
};

export type KindOptions<T, H extends HandleOf<T>> = {
    name: string;
    /**
     * change detector. Two defs hashing equal are the same declaration, and a
     * re-evaluation that produces one stays silent to dispatch.
     *
     * Return `undefined` for a def the hash CANNOT honestly describe, and the
     * re-declaration is reported as a change instead of assumed to be a no-op.
     * That is not a fallback, it is the correct answer for a def carrying a user
     * function: `structuralHash` sees `Function.prototype.toString()`, the SOURCE
     * TEXT, so what the function closes over is invisible to it. An edit to a
     * captured constant, or to a helper the function CALLS rather than IS,
     * produces an identical hash. (The store already holds the fresh closure —
     * `commit` re-points `byId` unconditionally; the short-circuit only decides
     * whether anyone is told.)
     *
     * Say `undefined` where missing a change leaves a stale CACHED ARTIFACT
     * rather than a stale live object, and where re-running is pure. A computed
     * texture qualifies twice over: re-baking gives the same pixels for the same
     * inputs, and the atlas builders hash the real baked pixels, so a false
     * positive costs one bake and writes nothing. `scripts` has the identical
     * blindness and deliberately does NOT do this — re-instantiating one would
     * destroy the live state its handlers hold.
     *
     * Precision comes from the module boundary, not from here: a re-declaration
     * only happens when the declaring module re-evaluates, so editing an
     * unrelated file costs nothing.
     */
    hash: (def: T) => string | undefined;
    /**
     * producer keys this def depends on, for kinds whose dependencies are
     * invisible to `hash` (a BlockDef's model is a factory closing over a
     * TileHandle, which `Function.prototype.toString()` cannot see).
     */
    deps?: (def: T) => DepKey[];
    /**
     * Dev-only: how this kind takes part in the patch-vs-invalidate decision,
     * or omitted for the kinds that don't take part at all — which is most of
     * them, and is the default deliberately. `hash` above asks "must runtime
     * consumers react?", and answering yes is cheap: the flush path rebuilds an
     * atlas or swaps a script instance. This asks "can importers keep the
     * bindings they already captured?", and answering no cascades to every
     * importer and, past the user-source boundary, forces a full page reload.
     *
     * Directly analogous to React Fast Refresh: `hasNonHandleExport` is its
     * boundary rule, and `signature` is its per-component hook signature —
     * unchanged means patch in place and keep state, changed means the captured
     * state cannot be trusted against the new shape.
     *
     * Declaring `hmr` at all opts the kind in, with the SET of declared ids as
     * the signature: adding, removing or renaming one invalidates. `signature`
     * narrows it further, for kinds whose content is itself part of what
     * importers bind to.
     */
    hmr?: { signature?: (def: T) => string };
    /**
     * Build the EMPTY container for `id`: identity, members the engine
     * populates later at their initial values, and any forwarding accessors.
     * It never sees a def and runs exactly once per id. `dependency` is
     * stamped by `kind()`, so a factory need not repeat the store name.
     */
    handle: (id: string) => Omit<H, 'def' | 'dependency'> & ThisType<H>;
};

/* ── hashing ────────────────────────────────────────────────────── */

/**
 * structural hash over functions, maps, sets, plain objects and primitives.
 * not crypto-grade; HMR change-detection only.
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

/* ── kind construction ──────────────────────────────────────────── */

/**
 * synthetic owner for entries that exist before any real module has claimed
 * them — today a codegen barrel seeding a payload before the user's `model()`
 * or `scene()` call runs. The next real declaration adopts the entry rather
 * than tripping the redeclaration guard.
 */
export const PLACEHOLDER_OWNER = '__placeholder__';

/** every store built by `kind()`, so the assembly and the test reset can walk
 *  them without naming each one. */
const allStores: Array<RegistryStore<any, any>> = [];

export function stores(): ReadonlyArray<RegistryStore<any, any>> {
    return allStores;
}

/** Define a kind. Call once, at module scope, in the module that owns the kind. */
function kind<T, H extends HandleOf<T> = HandleOf<T>>(opts: KindOptions<T, H>): RegistryStore<T, H> {
    const name = opts.name;
    const store: RegistryStore<T, H> = {
        name,
        byId: new Map(),
        handles: new Map(),
        meta: new Map(),
        moduleToIds: new Map(),
        seen: new Map(),
        pendingChanges: [],
        revision: 0,
        hash: opts.hash,
        deps: opts.deps,
        hmr: opts.hmr,
        // defineProperty, NOT a spread: spreading READS every property, which
        // invokes a forwarding accessor (`get name() { return this.def.name }`)
        // while `def` is still unset. Same trap as the merge this replaced —
        // accessors have to be moved by descriptor, never by value.
        handle: (id) => {
            const container = opts.handle(id) as Omit<H, 'def'>;
            Object.defineProperty(container, 'dependency', {
                value: { registry: name, id },
                enumerable: true,
                writable: false,
                configurable: true,
            });
            return container as Omit<H, 'def'> & ThisType<H>;
        },
    };

    onModulePush((moduleId) => {
        store.seen.set(moduleId, new Set());
    });
    onModulePop((moduleId) => {
        endModuleRun(store, moduleId);
    });

    allStores.push(store);
    return store;
}

/* ── the one write path ─────────────────────────────────────────── */

/**
 * Declare `id` with `def`, on behalf of the module currently evaluating.
 *
 * Returns the id's one handle, minting its container on first sight. The
 * handle object is stable for the life of the process; only `def` moves.
 *
 * `owner` is for codegen barrels seeding a payload ahead of the user's own
 * declaration — pass `PLACEHOLDER_OWNER` so the user's later call adopts the
 * entry instead of colliding with it.
 */
function declare<T, H extends HandleOf<T>>(store: RegistryStore<T, H>, id: string, def: T, owner: string = owningModule()): H {
    let handle = store.handles.get(id);
    if (handle === undefined) {
        handle = store.handle(id) as H;
        store.handles.set(id, handle);
    }
    handle.def = def;
    commit(store, id, def, owner);
    return handle;
}

/**
 * The single state transition. Every declaration lands here, so ownership,
 * change detection, dependency tracking and the reload shape are decided in
 * one place with one ordering.
 */
function commit<T>(store: RegistryStore<T, any>, id: string, def: T, owner: string): void {
    store.seen.get(owner)?.add(id);

    const meta = store.meta.get(id);
    const depsMoved = store.deps ? setDeps({ registry: store.name, id }, store.deps(def)) : false;

    if (meta === undefined) {
        store.byId.set(id, def);
        store.meta.set(id, { module: owner, version: 0, hash: store.hash(def) });
        addOwnership(store, owner, id);
        recordSignature(store, id, def, owner);
        store.pendingChanges.push({ kind: 'added', id, payload: def });
        store.revision++;
        return;
    }

    if (meta.module !== owner) adoptOwner(store, meta, id, owner);

    const hash = store.hash(def);
    // `byId` tracks the exact object user code holds even when nothing moved:
    // some defs carry mutable sibling collections filled in after creation, and
    // consumers key caches on def identity.
    store.byId.set(id, def);
    recordSignature(store, id, def, owner);

    // An `undefined` hash means the kind cannot prove this def is unchanged, so
    // the re-declaration is reported rather than assumed to be a no-op.
    if (hash !== undefined && hash === meta.hash && !depsMoved) return;

    meta.hash = hash;
    meta.version++;
    store.pendingChanges.push({ kind: 'changed', id, payload: def });
    store.revision++;
}

/**
 * Reassign an entry seeded under `PLACEHOLDER_OWNER` to its real owner. Any
 * other owner mismatch is two modules declaring the same id, which is a
 * genuine authoring error.
 */
function adoptOwner<T>(store: RegistryStore<T, any>, meta: EntryMeta, id: string, owner: string): void {
    if (meta.module !== PLACEHOLDER_OWNER && owner !== PLACEHOLDER_OWNER) {
        throw new Error(`[registry:${store.name}] '${id}' redeclared by ${owner}, owned by ${meta.module}`);
    }
    if (owner === PLACEHOLDER_OWNER) return;
    removeOwnership(store, PLACEHOLDER_OWNER, id);
    addOwnership(store, owner, id);
    meta.module = owner;
}

function addOwnership<T>(store: RegistryStore<T, any>, module: string, id: string): void {
    let owned = store.moduleToIds.get(module);
    if (!owned) {
        owned = new Set();
        store.moduleToIds.set(module, owned);
    }
    owned.add(id);
}

function removeOwnership<T>(store: RegistryStore<T, any>, module: string, id: string): void {
    const owned = store.moduleToIds.get(module);
    if (!owned) return;
    owned.delete(id);
    if (owned.size === 0) store.moduleToIds.delete(module);
}

/**
 * any id this module owned previously but didn't re-declare this run fires
 * `removed`. Called via the module-scope pop hook.
 */
function endModuleRun<T>(store: RegistryStore<T, any>, moduleId: string): void {
    const seen = store.seen.get(moduleId);
    if (!seen) return;
    const owned = store.moduleToIds.get(moduleId);
    if (!owned) {
        store.seen.delete(moduleId);
        return;
    }
    for (const id of owned) {
        if (seen.has(id)) continue;
        const def = store.byId.get(id);
        if (def === undefined) continue;
        store.byId.delete(id);
        store.meta.delete(id);
        owned.delete(id);
        store.pendingChanges.push({ kind: 'removed', id, payload: def });
        store.revision++;
        if (store.deps) clearDeps({ registry: store.name, id });
    }
    store.seen.delete(moduleId);
}

/* ── reads ──────────────────────────────────────────────────────── */

export function get<T>(store: RegistryStore<T, any>, id: string): T | undefined {
    return store.byId.get(id);
}

/**
 * Record what this declaration contributes to the HMR module boundary, for the
 * kinds that take part. Called from `commit`, so it happens once per
 * declaration with nothing for a call site to remember.
 */
function recordSignature<T>(store: RegistryStore<T, any>, id: string, def: T, owner: string): void {
    const hmr = store.hmr;
    if (!hmr) return;
    // a barrel seeding a payload is not a module whose importers can go stale.
    if (owner === PLACEHOLDER_OWNER) return;
    // with no `signature`, membership is the whole signal, so every entry of
    // this kind shares one value and the comparison degenerates to set equality.
    recordDeclaration(owner, store.name, id, hmr.signature ? hmr.signature(def) : '');
}

/* ── network protocol tables ────────────────────────────────────── */

/**
 * sort-by-id table for one id space (traits or commands). encode a ref via
 * `idToIndex`, decode via `indexToId`. both peers derive identical tables from
 * their own registrations; the manifest reconciles any set difference by id.
 *
 * Generic over the id space, so it lives with the machinery and each kind owns
 * the table built from its own store.
 */
export type ProtocolTable = { idToIndex: Map<string, number>; indexToId: string[] };

/** build a `ProtocolTable` from an id set (sort-by-id). also rebuilds an
 *  inbound table from a peer's manifest id list (already sorted by the sender;
 *  we re-sort so this stays the single canonical place table shape is set). */
export function buildProtocolTable(ids: Iterable<string>): ProtocolTable {
    const indexToId = [...ids].sort();
    const idToIndex = new Map<string, number>();
    for (let i = 0; i < indexToId.length; i++) idToIndex.set(indexToId[i]!, i);
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

/* ── test reset ─────────────────────────────────────────────────── */

/**
 * tests only. Clears `handles` along with everything else: a container is
 * minted once and then kept, so leaving it would hand the next test the
 * previous one's populated state (a scene's node children, say).
 */
export function _resetStores(): void {
    for (const store of allStores) {
        store.byId.clear();
        store.handles.clear();
        store.meta.clear();
        store.moduleToIds.clear();
        store.seen.clear();
        store.pendingChanges.length = 0;
        store.revision = 0;
    }
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
    /** search words for editor UIs, normalised (see `AssetMeta`). */
    tags: readonly string[];
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
            (manifest.syncs[i] ?? []).map((sid) => syncById(handle).get(sid)?.index),
        );
        controlRemap.set(
            traitId,
            (manifest.controls[i] ?? []).map((cid) => controlsById(handle).get(cid)?.index),
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
    //
    // Iterates `byId`, NOT `handles`: the handle map is monotonic, so a trait whose
    // declaration was removed still has a handle and would otherwise stay indexed.
    const slotToTrait: Array<TraitHandle | undefined> = [];
    for (const id of reg.traits.byId.keys()) {
        const handle = reg.traits.handles.get(id);
        if (handle) slotToTrait[handle.slot] = handle;
    }
    reg.slotToTrait = slotToTrait;

    const defs = new Map<string, BlockDef>();
    const handles = new Map<string, BlockHandle>();
    for (const [id, def] of reg.blocks.byId) {
        defs.set(id, def);
        const handle = reg.blocks.handles.get(id);
        if (handle) handles.set(id, handle);
    }
    const tiles = new Map<string, TileDef>();
    for (const [id, h] of reg.tiles.byId) tiles.set(id, h);
    // IN PLACE: `voxels.registry`, the per-room scene context, blueprint canvases
    // and content-store scene voxels all hold this object. Rebinding the field
    // would leave every one of them reading tables sized for the old state count.
    buildBlockRegistry(reg.blockRegistry, defs, handles, tiles);

    reg.protocol = {
        traits: buildProtocolTable(reg.traits.byId.keys()),
        commands: buildProtocolTable(reg.commands.byId.keys()),
    };

    // the wire index is sort-by-id and moves whenever the trait set does, so it is stamped
    // here rather than looked up by string id on every emitted trait.
    for (const handle of slotToTrait) {
        if (handle) handle.netIndex = reg.protocol.traits.idToIndex.get(handle.id);
    }
}

/* ── unified registry ───────────────────────────────────────────── */

export type Registry = {
    /** monotonic id bumped once per dispatch drain via `bumpVersion()`. */
    version: number;

    /** 16x16 entries in the voxel atlas, made of textures. */
    tiles: RegistryStore<TileDef, TileHandle>;
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
    /** pixel sources, from disk or computed. Both atlases consume these. */
    textures: RegistryStore<TextureDef, TextureHandle>;
    particles: RegistryStore<ParticleDef, ParticleHandle>;
    config: RegistryStore<Config>;

    /** runtime block lookup; derived from `blocks` + `tiles`.
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

/* ── the kinds ──────────────────────────────────────────────────── */
//
// Every declared kind, defined in one place so they read as a table. Each
// `kind({...})` literal is the whole description of that kind: how to detect a
// content change (`hash`), what it depends on (`deps`), whether it takes part in
// the HMR module boundary (`hmr`), and how to build the one handle container an
// id ever gets (`handle`).
//
// The handle factory references kind-local helpers (`formatKey`, `traitSlots`,
// `createSceneHandle`) but only from INSIDE the closure, never at module-eval,
// so the import edges back to those modules stay lazy and there is no
// initialisation order to reason about.
//
// `handle(id)` builds the EMPTY container: identity, plus members the engine
// stamps later (a block's state ids, a scene's node) at their initial values,
// plus any accessors forwarding to `def`. `declare` mints it once per id and
// from then on only ever re-points `def`, which is what makes a handle safe to
// hold across a re-declaration.

const tileHash = (t: TileDef) => structuralHash(t);
const spriteHash = (s: SpriteDef) => structuralHash(s);
// A file texture is fully described by its path, so it hashes and short-circuits like
// any other kind.
//
// A COMPUTED one cannot be, and says so with `undefined` rather than pretending: its
// `fn` is hashed as source text, which is blind to everything the function closes over,
// so `fn: (c, i, p) => tint(c, p)` hashes identically no matter what `tint` now does.
// Re-declaring one is therefore always reported, and re-baking is cheap and pure — the
// atlas builders hash the real baked pixels, so an unchanged texture writes nothing.
// See `KindOptions.hash`.
//
// `inputs` are DepKeys, so this hashes WHICH textures are drawn from, not their pixels.
// Their content reaches consumers through `deps`, not through this hash.
const textureHash = (t: TextureDef) => (t.from === 'file' ? structuralHash(t) : undefined);

/** the voxel atlas packs tiles in cells of this size; every tile frame is a
 *  multiple of it per side, so the tile keeps whole texels through the atlas's
 *  four mip halvings (the atlas has no gutters; alignment is what stops bleed). */
export const BLOCK_TILE_SIZE = 16;
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
 * referenced tile ids. The factory typically closes over
 * TileHandles which `Function.prototype.toString()` can't see,
 * so the content hash stays stable when the closed-over tile is swapped.
 * DepGraph picks the swap up via the dep-set diff and elevates it to a
 * `changed` event, which the block-branch dispatch reacts to.
 */
const extractBlockDeps = (def: BlockDef): DepKey[] => {
    if (!def.model) return [];
    const tileIds = new Set<string>();
    for (let i = 0; i < def.states.totalStates; i++) {
        const props = def.states.decode(i);
        let model: BlockModel | BlockModel[] | undefined;
        try {
            model = def.model(props);
        } catch {
            continue;
        }
        // a variant list contributes every entry's tiles: any of them can be
        // the one a given position draws.
        if (model) for (const m of Array.isArray(model) ? model : [model]) collectModelTileIds(m, tileIds);
    }
    const deps: DepKey[] = [];
    for (const id of tileIds) deps.push({ registry: 'tiles', id });
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

/* ── kind definitions ───────────────────────────────────────────── */

export const tileStore = kind<TileDef, TileHandle>({
    name: 'tiles',
    hash: tileHash,
    // Signature over WHICH textures the frames name, not the whole def.
    //
    // `tileFrame()` reads a frame's texture out of a tile, and `block()` uses it at
    // DECLARATION time to derive dust from the top face. That is a by-value read: the
    // dust texture stores the resolved texture id, so an importer that re-points its
    // frames leaves the derived entry aimed at an id that may no longer exist. Handle
    // identity does not save it, which is exactly the condition the boundary rule
    // invalidates for — so a frames change cascades and the importing module re-declares,
    // re-deriving its dust and letting the ordinary sweep reclaim the old.
    //
    // `fps` / `interpolate` are deliberately NOT in here: nothing reads them at
    // declaration time, so they ride the flush path as a cheap in-place patch.
    hmr: { signature: (t) => structuralHash(t.frames) },
    handle: (id) => ({ id }),
});

export const blockStore = kind<BlockDef, BlockHandle>({
    name: 'blocks',
    hash: blockHash,
    deps: extractBlockDeps,
    // Methods read the schema off `this.def`, never a closure capture: the
    // handle outlives every re-declaration, so capturing the declaring call's
    // `states` would be stale for every importer the moment the author edits
    // the state schema. `_index`/`_baseStateId`/`_hooks` are stamped by
    // `buildBlockRegistry` at freeze and `_defaultDust` by `block()` itself;
    // none is derived from the def, so they start empty here and survive every
    // re-declaration untouched.
    handle: (id): BlockContainer => ({
        id,
        _index: 0,
        _baseStateId: 0,
        _hooks: 0,
        _defaultDust: null,
        stateId(props) {
            return this._baseStateId + this.def.states.encode(props);
        },
        stateIdLocal(localIdx) {
            return this._baseStateId + localIdx;
        },
        defaultId() {
            return this._baseStateId + (this.def.defaultLocalIdx ?? 0);
        },
        stateKey(props) {
            return formatKey(this.id, this.def.states, this.def.states.encode(props));
        },
        defaultKey() {
            return formatKey(this.id, this.def.states, this.def.defaultLocalIdx ?? 0);
        },
    }),
});

export const modelStore = kind<ModelDef, ModelHandle>({
    name: 'models',
    hash: modelHash,
    // forwarding accessors rather than copied fields: a re-declaration re-points
    // `def`, and every holder sees the new data through these with nothing
    // copied and nothing to invalidate.
    handle: (id): ModelContainer => ({
        id,
        get name() {
            return this.def.name;
        },
        get src() {
            return this.def.src;
        },
        get scene() {
            return this.def.scene;
        },
        get aabb() {
            return this.def.aabb;
        },
        get nodes() {
            return this.def.nodes;
        },
        get meshes() {
            return this.def.meshes;
        },
        get animations() {
            return this.def.animations;
        },
    }),
});

export const traitStore = kind<TraitDef, TraitHandle>({
    name: 'traits',
    hash: traitHash,
    // Scripts destructure trait fields by name, so any body delta — an added or
    // removed key, a default tweak, a factory swap — can silently be a type
    // change and needs fresh script closures rather than a patch.
    hmr: { signature: (t) => structuralHash(t.body) },
    handle: (id) => ({ id, slot: traitSlots[id]!, netIndex: undefined, __type: null! }),
});

export const controlStore = kind<ControlDef>({
    name: 'controls',
    hash: controlHash,
    handle: (id) => ({ id }),
});

export const syncStore = kind<SyncDef>({
    name: 'sync',
    hash: syncHash,
    handle: (id) => ({ id }),
});

export const scriptStore = kind<ScriptDef>({
    name: 'scripts',
    hash: scriptHash,
    // opts in with no signature: importers bind to WHICH script ids exist, not
    // to their bodies. A body edit is swapped in place through the flush path,
    // which is what keeps editing one script from resetting its neighbours.
    hmr: {},
    handle: (id) => ({ id }),
});

export const commandStore = kind<CommandDef, CommandHandle<pack.Schema, RpcDirection>>({
    name: 'commands',
    hash: commandHash,
    handle: (id) => ({ id }),
});

export const sceneStore = kind<SceneDef, SceneHandle>({
    name: 'scenes',
    hash: sceneHash,
    // `node`, `voxels` and `version` are filled in by `Content.populateScene`
    // off the def's `_payload`, so they are established once and never rewritten.
    handle: (id) => createSceneHandle(id),
});

export const prefabStore = kind<PrefabDef, PrefabHandle>({
    name: 'prefabs',
    hash: prefabHash,
    deps: extractPrefabDeps,
    handle: (id) => ({ id, __args: null! }),
});

export const soundStore = kind<SoundDef, SoundHandle>({
    name: 'sounds',
    hash: soundHash,
    handle: (id) => ({ id }),
});

export const spriteStore = kind<SpriteDef, SpriteHandle>({
    name: 'sprites',
    hash: spriteHash,
    handle: (id) => ({ id }),
});

export const textureStore = kind<TextureDef, TextureHandle>({
    name: 'textures',
    hash: textureHash,
    // a computed texture's sources are `DepKey`s in the def, invisible to `hash` as
    // content — so the edges go to DepGraph, and editing a source propagates to
    // everything derived from it. Same reason `blocks` extracts its texture refs.
    deps: textureInputDeps,
    handle: (id) => ({ id }),
});

export const particleStore = kind<ParticleDef, ParticleHandle>({
    name: 'particles',
    hash: particleHash,
    handle: (id) => ({ id }),
});

export const configStore = kind<Config>({
    name: 'config',
    hash: configHash,
    handle: (id) => ({ id }),
});

// the two handle shapes whose factories carry methods/accessors reading
// `this.def`; annotated so `this` types against the finished handle.
type BlockContainer = Omit<BlockHandle, 'def' | 'dependency'> & ThisType<BlockHandle>;
type ModelContainer = Omit<ModelHandle, 'def' | 'dependency'> & ThisType<ModelHandle>;

/* ── singleton ──────────────────────────────────────────────────── */

/**
 * Assemble the singleton. Each kind is DEFINED by its own module — the def and
 * handle types, the hash, the dep extraction, the HMR policy and the handle
 * container all live together in one `kind({...})` literal there. This function
 * only collects them and owns what is genuinely cross-kind: `blockRegistry`
 * (blocks × tiles) and the protocol manifest.
 *
 * The import direction is one-way — `registry-store.ts` ← kind modules ←
 * here — so nothing a kind module needs at module-eval time can be reached
 * through this file, and there is no cycle to order carefully.
 */
export function init(): Registry {
    const reg = {
        version: 0,
        tiles: tileStore,
        blocks: blockStore,
        models: modelStore,
        traits: traitStore,
        controls: controlStore,
        sync: syncStore,
        scripts: scriptStore,
        commands: commandStore,
        scenes: sceneStore,
        prefabs: prefabStore,
        sounds: soundStore,
        sprites: spriteStore,
        textures: textureStore,
        particles: particleStore,
        config: configStore,
        // derived index fields — start empty; `reindexRegistry()` fills them at engine
        // boot (after user modules register) and at each dev flush. `blockRegistry` is
        // a real empty struct from the outset (never rebound after this), so holders
        // can take the reference at any time; `createBlockRegistry` touches no sibling
        // module, unlike `buildBlockRegistry`, which would trip circular init here.
        slotToTrait: [] as Array<TraitHandle | undefined>,
        blockRegistry: createBlockRegistry(),
        protocol: { traits: buildProtocolTable([]), commands: buildProtocolTable([]) },
    } as Registry;

    // tests only, wipes every store so the next test's setup starts from a
    // virgin registry, then rebuilds the (now empty) derived indexes. used by
    // tst/e2e/harness.ts.
    reg._reset = () => {
        // `_resetStores` walks every store `kind()` ever built, so a newly added
        // kind is covered without being listed here. It clears `handles` too: a
        // container is minted once and then kept, so leaving it would hand the
        // next test the previous one's populated state.
        _resetStores();
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

/* ── declaration apis ───────────────────────────────────────────────
 *
 * The user-facing surface for putting something in the registry. They live
 * beside the stores they write to, so `kind()` and `declare()` never leave this
 * file: there is exactly one way in, and no second write path to invent.
 *
 * Each builds its OWN handle container, because the declaring function is the
 * only place that knows both the handle's shape and the runtime it needs
 * (`traitSlots` here, `formatKey` for blocks, `createSceneHandle` for scenes).
 * Keeping those out of the kind config is what lets this file stay free of any
 * import that declares at module scope.
 */

/**
 * stable mapping from trait string id to runtime slot. Cached for the
 * process lifetime, a trait id always gets the same slot, even if its
 * registry entry is removed and re-added during HMR. Used as the integer
 * key into `node._traits` and friends.
 */
export const traitSlots: Record<string, number> = {};

let slotCounter = 0;

/**
 * define a trait. registers it in the global capture area and returns
 * a handle used with getTrait, addTrait, hasTrait, query, etc.
 *
 * @example
 * ```ts
 * const TransformTrait = trait('transform', {
 *     position: () => vec3.create(),
 *     scale:    () => vec3.fromValues(1, 1, 1),
 *     teleport: 0,
 *     interpolate: false,
 * });
 *
 * control(TransformTrait, 'position', {
 *     schema: prop.vec3(),
 *     get: (t) => t.position,
 *     set: (t, v) => { vec3.copy(t.position, v); markDirty(t); },
 * });
 *
 * const poseSync = sync(TransformTrait, 'pose', {
 *     schema: pack.tuple([pack.position(), pack.quaternion()]),
 *     pack: (t) => [t.position, t.quaternion],
 *     unpack: ([p, q], t) => { vec3.copy(t.position, p); quat.copy(t.quaternion, q); markDirty(t); },
 * });
 * ```
 */
export function trait<S extends TraitBody = Record<string, never>>(
    id: string,
    body?: S,
    options?: TraitOptions,
): TraitHandle<TraitInstance<S>> {
    let slot = traitSlots[id];
    if (slot === undefined) {
        slot = slotCounter++;
        traitSlots[id] = slot;
    }

    const nextBody = body ?? ({} as S);
    const name = options?.name ?? id;
    const persist = options?.persist ?? true;

    const handle = declare(traitStore, id, {
        id,
        name,
        body: nextBody,
        persist,
        // the module's control() / sync() / script() calls run again immediately
        // after this and re-register into these. Each refuses to re-register an id
        // it already holds (warns, keeps the old body), so starting empty is what
        // lets an author's edit to a control/sync/script body actually land.
        controls: [],
        sync: [],
        scripts: [],
    }) as TraitHandle<TraitInstance<S>>;

    return handle;
}

/**
 * register a control on a trait. callable multiple times per trait.
 * declared *after* the trait() literal so `t` is fully typed in get/set.
 * `id` is a stable string used as the persisted key in scene files and
 * the inspector lookup key.
 */
export function control<T extends TraitBase, V>(handle: TraitHandle<T>, controlId: string, body: ControlBody<T, V>): void {
    const target = handle.def;
    // linear scan over the def's own array, not a cached index: this runs DURING
    // accumulation (the control() calls that follow trait()), when a memo over
    // the array would capture it half-built. A handful of entries, module-eval
    // only.
    if (target.controls.some((c) => c.controlId === controlId)) {
        console.warn(`[bongle] trait '${target.id}' already has a control with id '${controlId}'; ignoring re-register`);
        return;
    }
    // into the per-kind store so HMR detects individual control edits without
    // flipping the parent trait hash. key matches the composed
    // `${traitId}.${controlId}` shape used elsewhere. Nothing holds the minted
    // handle today (`control()` returns void); it goes through `declare` so the
    // kind has the same shape as every other, and so a future user-held ref would
    // already be identity-stable.
    const key = `${target.id}.${controlId}`;
    const reg = declare(controlStore, key, { ...body, traitId: target.id, controlId } as unknown as ControlDef).def;
    // the def's array is the one record; `controlsById` is a view over it.
    target.controls.push(reg);
}

/**
 * register a sync on a trait. callable multiple times per trait.
 * `id` is a stable string used for debug and per-attachment diff tracking.
 * returns a SyncHandle for producer-side dirty hints; wire envelope still
 * keys by `SyncHandle.index` (the slot in def.sync).
 */
export function sync<T extends TraitBase, S>(handle: TraitHandle<T>, syncId: string, body: SyncBody<T, S>): SyncHandle<T> {
    const target = handle.def;
    // linear scan for the same reason as `control()`: this runs during accumulation.
    const existing = target.sync.findIndex((s) => s.syncId === syncId);
    if (existing !== -1) {
        console.warn(`[bongle] trait '${target.id}' already has a sync with id '${syncId}'; ignoring re-register`);
        return {
            index: existing,
            dirty(instance: T) {
                setSyncDirty(instance, existing);
            },
        };
    }
    // see `control()` for why this goes through `declare` despite nothing holding
    // the minted handle.
    const key = `${target.id}.${syncId}`;
    const reg = declare(syncStore, key, { ...body, traitId: target.id, syncId } as unknown as SyncDef).def;
    const index = target.sync.length;
    target.sync.push(reg);
    return {
        index,
        dirty(instance: T) {
            setSyncDirty(instance, index);
        },
    };
}

/*#__NO_SIDE_EFFECTS__*/
/**
 * declare a particle type. called at module scope.
 *
 * returns a pure-data handle. the runtime resolves particle types by id
 * at spawn time via `particlesRegistry`; no codegen barrel.
 *
 * @example
 * ```ts
 * const Smoke = particle('smoke', {
 *     sprite: SmokeSprite,
 *     playback: 'stretch',
 *     update: particleUpdate.smoke,
 * });
 * ```
 */
export function particle(id: string, options: ParticleOptions): ParticleHandle {
    const { name, tags } = resolveAssetMeta(id, options);
    const fps = options.fps ?? 0;
    const glow = options.glow ?? 0;
    const tint = options.tint ?? ([1, 1, 1, 1] as [number, number, number, number]);
    return declare(particleStore, id, {
        typeId: id,
        name,
        tags,
        sprite: options.sprite,
        playback: options.playback,
        fps,
        update: options.update,
        glow,
        tint,
    });
}

/*#__NO_SIDE_EFFECTS__*/
/**
 * declare a sprite. called at module scope.
 *
 * single entry → static sprite; array → flipbook frames.
 *
 * returns a pure-data handle that the asset pipeline reads to pack the
 * sprite atlas and the runtime consults (by id) for uvRect + sizePx.
 *
 * @example
 * ```ts
 * const Sword = sprite('sword', { src: 'items/sword.png' });
 * const FlamingSword = sprite('flaming-sword', {
 *     src: ['items/flaming_0.png', 'items/flaming_1.png'],
 * });
 * ```
 */
/*#__NO_SIDE_EFFECTS__*/
/**
 * Declare a texture: one picture, from disk or computed from other textures.
 *
 * ```ts
 * const stone = texture('kit:stone', { src: asset('./stone.png', import.meta.url) });
 *
 * const dust = texture('kit:stone:dust0', {
 *     size: [8, 8],
 *     inputs: { tex: stone },
 *     params: { seed: 1234 },
 *     fn: (ctx, inputs, params) => { ... },
 * });
 * ```
 *
 * Consumers (`sprite()`, and the voxel-atlas tile kind) hold textures in their `frames`,
 * so animation is the consumer's concern and a texture stays exactly one picture.
 */
export function texture<I extends Record<string, TextureHandle>, P extends DrawParams>(
    id: string,
    options: TextureOptions<I, P>,
): TextureHandle {
    if (!isComputedOptions(options)) {
        return declare(textureStore, id, { id, from: 'file', src: options.src });
    }
    // handles in, DepKeys out: the API takes pointers so a reference cannot be a typo or
    // depend on declaration order, while the stored def stays plain hashable data.
    const inputs: Record<string, DepKey> = {};
    for (const [key, handle] of Object.entries(options.inputs ?? {})) {
        inputs[key] = (handle as TextureHandle).dependency;
    }
    return declare(textureStore, id, {
        id,
        from: 'computed',
        size: options.size,
        inputs,
        params: (options.params ?? {}) as DrawParams,
        fn: options.fn as DrawFn<DrawInputs, DrawParams>,
    });
}

/*#__NO_SIDE_EFFECTS__*/
/**
 * declare a sprite. called at module scope.
 *
 * single entry → static sprite; array → flipbook frames.
 *
 * returns a pure-data handle that the asset pipeline reads to pack the
 * sprite atlas and the runtime consults (by id) for uvRect + sizePx.
 *
 * @example
 * ```ts
 * const Sword = sprite('sword', { src: 'items/sword.png' });
 * const FlamingSword = sprite('flaming-sword', {
 *     src: ['items/flaming_0.png', 'items/flaming_1.png'],
 * });
 * ```
 */
export function sprite(id: string, options: SpriteOptions): SpriteHandle {
    const { name, tags } = resolveAssetMeta(id, options);
    const padding = options.padding ?? 1;
    const mipmap = options.mipmap ?? true;
    return declare(spriteStore, id, {
        spriteId: id,
        name,
        tags,
        frames: declareFrames(id, options.src, options.frames),
        padding,
        mipmap,
    });
}

/**
 * Turn a consumer's `src` into declared textures and return refs to them.
 *
 * A consumer holds frame REFERENCES, not sources — the pixels belong to the texture kind,
 * which owns their identity, hashing, dedup and reclamation. This is the sugar that keeps
 * the common call site short: `sprite('smoke', { src: 'a.png' })` still works, it just
 * declares texture `smoke` on the way through.
 *
 * Ids: a single frame takes the owner's id verbatim (a different store, so no collision
 * with the sprite or tile of the same name); multiple frames are `id:0`, `id:1`. Going from
 * one frame to several therefore renames the first texture, which is fine — nothing holds
 * a sugar-declared texture by name.
 */
function declareFrames(
    ownerId: string,
    src: ImageSource | ImageSource[] | undefined,
    frames: TextureHandle[] | undefined,
): DepKey[] {
    // the direct form: caller already has textures, so nothing is declared here.
    if (frames) return frames.map((f) => f.dependency);
    if (src === undefined) throw new Error(`[bongle] '${ownerId}' needs either a 'src' or 'frames'`);
    const sources = Array.isArray(src) ? src : [src];
    const single = sources.length === 1;
    return sources.map((source, i) => texture(single ? ownerId : `${ownerId}:${i}`, { src: source }).dependency);
}

/*#__NO_SIDE_EFFECTS__*/
/**
 * Declare an audio clip. Called at module scope.
 *
 * Returns the codegen'd `SoundHandle` (typed via `SoundHandleMap` if the
 * cli has emitted the registry barrel yet, generic `SoundHandle` otherwise).
 *
 * ```ts
 * import { sound } from 'bongle';
 * const Footstep = sound('footstep', { src: 'audio/footstep.wav' });
 * const Ambient  = sound('ambient', { src: 'audio/ambient.ogg', long: true });
 * ```
 *
 * The bongle asset pipeline reads `soundsRegistry` on every flush and
 * builds the atlas (long:false bucket) + standalone files (long:true
 * bucket) into `resources/client/`, then codegens per-id sidecars +
 * barrel under `src/generated/sounds*`. Playback is via the script APIs
 * in `api/audio.ts` (`playMono` / `playAt` / `playOnNode`).
 */
export function sound<const Id extends string>(
    id: Id,
    options: SoundOptions,
): Id extends keyof SoundHandleMap ? SoundHandleMap[Id] : SoundHandle {
    const long = options.long ?? false;
    const src = options.src;
    const meta = resolveAssetMeta(id, options);
    // minting a placeholder is the normal cold-start path, not a warning case: the
    // user-entry shim wipes `src/generated/sounds.ts` on every dev start
    // (schema-drift protection in `resetGeneratedBarrels`), so EVERY declared sound
    // hits it before the pipeline's first flush populates the barrel.
    // codegen owns `duration`; merge onto whatever the barrel registered rather
    // than replacing it.
    const previous: SoundDef | undefined = get(soundStore, id);
    const def: SoundDef = previous ? { ...previous, src, long, ...meta } : createSoundPlaceholderDef(id, src, long, meta);
    return declare(soundStore, id, def) as never;
}

/**
 * declare per-game config. call once at module scope, before
 * scripts/traits/etc. only the first call wins, a second call throws so
 * conflicts don't sit hidden.
 */
export function config(c: Config): Config {
    // truthy narrows away `false` and `undefined`, leaving the { maxPlayers } arm.
    const server = c.server;
    if (server) {
        const maxPlayers = server.maxPlayers;
        if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > HARD_MAX_PLAYERS_PER_ROOM) {
            throw new Error(
                `config({ server: { maxPlayers } }): expected integer in [1, ${HARD_MAX_PLAYERS_PER_ROOM}], got ${maxPlayers}`,
            );
        }
    }
    // The payload is the CALLER'S OWN object, so unlike every other kind there is
    // nothing for the engine to mint an identity for — `config()` hands `c` straight
    // back. It still goes through `declare` so the singleton is stored, hashed and
    // change-detected exactly like the rest; the handle is bookkeeping nobody reads.
    declare(configStore, CONFIG_ID, c);
    return c;
}

/**
 * define a command. commands are typed network messages.
 *
 * direction determines where send() can be called and where listen() receives:
 * - CLIENT_TO_SERVER: client sends to server (routed via room), server listens per-room
 * - SERVER_TO_CLIENT: server sends/broadcasts to client, client listens
 *
 * handlers are NOT in the definition, they are registered in scripts via listen().
 *
 * ```ts
 * const placeBlock = command('place_block', CLIENT_TO_SERVER, p.object({
 *   x: p.int32(),
 *   y: p.int32(),
 *   z: p.int32(),
 *   blockId: p.string(),
 * }))
 *
 * // in client script:
 * send(ctx, placeBlock, { x: 0, y: 0, z: 0, blockId: 'stone' })
 *
 * // in server script:
 * listen(ctx, placeBlock, (args, from) => { ... })
 * ```
 */
export function command<S extends pack.Schema, D extends RpcDirection>(id: string, direction: D, schema: S): CommandHandle<S, D> {
    const serdes = pack.build(schema);

    const handle = declare(commandStore, id, { id, direction, schema, serdes: serdes as CommandDef['serdes'] });
    return handle as unknown as CommandHandle<S, D>;
}

/*#__NO_SIDE_EFFECTS__*/
/**
 * Declare a model. Called at module scope.
 *
 * Returns the codegen'd `ModelHandle` (typed via `ModelHandleMap` if the
 * cli has emitted the registry barrel yet, generic `ModelHandle` otherwise).
 *
 * ```ts
 * import { model } from 'bongle';
 * const wizard = model('wizard', { src: 'characters/wizard.glb' });
 * // wizard.scene, wizard.nodes.Body, wizard.meshes.Head, wizard.animations.idle
 * ```
 */
export function model<const Id extends string>(
    id: Id,
    options: ModelOptions,
): Id extends keyof ModelHandleMap ? ModelHandleMap[Id] : ModelHandle {
    const src = options.src;
    const meta = resolveAssetMeta(id, options);
    // minting a placeholder is the normal cold-start path, not a warning case: the
    // user-entry shim wipes `src/generated/models.ts` on every dev start
    // (schema-drift protection in `resetGeneratedBarrels`), so EVERY declared model
    // hits it before the pipeline's first flush populates the barrel.
    // codegen owns everything but `src` / `name`, so merge onto whatever the
    // barrel already registered rather than replacing it.
    const previous: ModelDef | undefined = get(modelStore, id);
    const def: ModelDef = previous ? { ...previous, src, ...meta } : createModelPlaceholderDef(id, src, meta);
    return declare(modelStore, id, def) as never;
}

/**
 * declare a scene resource at module scope. returns a stable handle whose
 * fields the engine populates once the scene is loaded (or arrives from the
 * server). reference identity is permanent for the lifetime of this module
 * load, closures over `handle.node` survive any number of hot reloads.
 *
 * idempotent within a single module load: a second `scene('id', ...)` call
 * returns the same handle (options on later calls are ignored, declare the
 * options on the first call).
 *
 * @example
 * ```ts
 * const PenguinScene = scene('penguin');
 * const Navmesh = scene('navmesh', { client: false });
 *
 * // read directly:
 * const blocks = PenguinScene.voxels;
 * const nodes = PenguinScene.node.children;
 *
 * // observe changes:
 * onTick(ctx, () => {
 *     if (PenguinScene.version > lastSeen) {
 *         lastSeen = PenguinScene.version;
 *         // rebuild whatever depends on it
 *     }
 * });
 * ```
 */
export function scene(id: string, options?: SceneOptions): SceneHandle {
    // identity-stable: the handle is referenced by user code across hot
    // reloads, so we keep the same object and let the engine mutate its
    // fields in place. only first call decides `options` for client/server
    // (those affect transport routing, flipping them mid-session would
    // require a reload anyway). `name` is patched in place so authors
    // can rename without restarting.
    // only the first call decides client/server (they affect transport routing;
    // flipping them mid-session needs a reload anyway). `name` follows the latest
    // declaration so authors can rename without restarting, and `_payload` is
    // owned by the codegen barrel, so both ride the previous def.
    const previous: SceneDef | undefined = get(sceneStore, id);
    const def: SceneDef = previous ? { ...previous, ...resolveAssetMeta(id, options) } : createSceneDef(id, options);
    return declare(sceneStore, id, def);
}

/**
 * register a script (behavior) on a trait. callable multiple times per trait,
 * each call appends to the trait def's `scripts` array. attaching the trait to
 * a live node instantiates one ScriptInstance per registered script. the
 * factory runs at attach time with `ctx.trait` typed for the handle.
 *
 * `id` is a stable user-supplied string (without trait prefix). the runtime
 * identifier becomes `${trait.id}.${id}`, used as the instance map key,
 * DepGraph dependency key, and error message label.
 *
 * @example
 * ```ts
 * const Gamemode = trait('gamemode');
 * script(Gamemode, 'tick', (ctx) => {
 *     onTick(ctx, () => { /* ctx.trait is TraitInstance<typeof Gamemode> *\/ });
 * });
 * ```
 */
export function script<T extends TraitBase>(
    handle: TraitHandle<T>,
    scriptId: string,
    factory: ScriptFactory<T>,
    opts?: ScriptOptions,
): ScriptDef {
    const target = handle.def;
    const key = `${handle.id}.${scriptId}`;
    const def: ScriptDef = {
        traitId: handle.id,
        scriptId,
        key,
        dependency: { registry: 'scripts', id: key },
        factory: factory as unknown as ScriptFactory,
        editor: opts?.editor === true,
    };
    // upsert into the trait def's script list: reuse the slot if this id already
    // exists, else append (`scripts[length] = def` extends the array). re-
    // registration is normal under HMR, a built-in trait like WorldTrait keeps
    // its def (and `scriptsById`) across a user-file reload, so the same
    // `script()` call re-runs against a populated map; latest factory wins.
    const found = target.scripts.findIndex((s) => s.scriptId === scriptId);
    const index = found === -1 ? target.scripts.length : found;
    target.scripts[index] = def;
    // into the per-kind store so HMR detects individual script factory edits
    // without flipping the parent trait hash; dispatch turns these pendingChanges
    // into a targeted applyTraitSwap. Nothing holds the minted handle today — see
    // `control()` for why it still goes through `declare`.
    declare(scriptStore, key, def);
    // wire dep edges so the dirty set covers scripts whose closed-over
    // producers changed even when the factory body itself is unchanged
    // (e.g. a referenced model handle reloaded). dispatch uses these to
    // target only the dirty scripts on applyTraitSwap.
    setDeps({ registry: 'scripts', id: key }, opts?.deps ? opts.deps.map((d) => d.dependency) : []);
    return def;
}

/*#__NO_SIDE_EFFECTS__*/
/**
 * declare a tile: one 16x16 entry in the voxel atlas, made of textures.
 *
 * pass a single `src` for a static tile, or an array for an animated one
 * (one entry per frame) — `src` is sugar that declares a texture per frame.
 * `frames` takes texture handles directly.
 *
 * returns a handle that can be passed to block model definitions.
 */
export function tile(id: string, options: TileOptions): TileHandle {
    const frames = declareFrames(id, options.src, options.frames);
    const fps = options.fps ?? 1;
    const interpolate = options.interpolate ?? false;
    // Computed frames carry their size, so a wrong one is caught here at the declaration
    // that produced it. A file frame's size isn't known until the pipeline loads it, so the
    // atlas builder checks those — see `tile-atlas.ts`.
    for (const frame of frames) {
        const def = textureStore.byId.get(frame.id);
        if (def?.from !== 'computed') continue;
        const [w, h] = def.size;
        if (w <= 0 || h <= 0 || w % BLOCK_TILE_SIZE !== 0 || h % BLOCK_TILE_SIZE !== 0) {
            throw new Error(
                `[bongle] tile('${id}') frame '${frame.id}' is ${w}x${h}; the voxel atlas packs tiles in multiples of ${BLOCK_TILE_SIZE}x${BLOCK_TILE_SIZE}`,
            );
        }
    }
    return declare(tileStore, id, { id, frames, fps, interpolate });
}

/*#__NO_SIDE_EFFECTS__*/
/**
 * declare a block type. called at module scope, the definition is
 * captured and frozen into a registry when the module is loaded.
 *
 * returns a handle used for getting global state ids in gameplay code.
 */
export function block<const P extends PropsDef = {}>(id: string, options: BlockOptions<P> = {}): BlockHandle<P> {
    const states = (options.states ?? EMPTY_STATES) as BlockStateDef<P>;
    const cull = options.cull ?? CullType.SOLID;
    const material = options.material ?? MaterialType.OPAQUE;
    const defaultLocalIdx = options.defaultState ? states.encode(options.defaultState) : 0;

    const { name, tags } = resolveAssetMeta(id, options);
    const def: BlockDef<P> = {
        id,
        name,
        tags,
        states,
        defaultLocalIdx,
        model: options.model,
        cull,
        material,
        vertexAnimation: options.vertexAnimation,
        jitter: options.jitter,
        lightEmission: options.lightEmission,
        lightOpacity: options.lightOpacity,
        emissive: options.emissive,
        collision: options.collision,
        selection: options.selection,
        shape: options.shape,
        climbable: options.climbable,
        liquid: options.liquid,
        pathfindable: options.pathfindable,
        friction: options.friction,
        restitution: options.restitution,
        sneakGuard: options.sneakGuard,
        flags: options.flags,
        surfaceHeight: options.surfaceHeight,
        fluidGroup: options.fluidGroup,
        screenTint: options.screenTint,
        sounds: options.sounds,
        particles: options.particles,
        onNeighbourUpdate: options.onNeighbourUpdate,
        onNeighbourChanged: options.onNeighbourChanged,
        place: options.place,
        rotate: options.rotate,
        flip: options.flip,
    };

    // Methods read the schema off `this.def`, never a closure capture: the handle
    // outlives every re-declaration (see `declare`), so a capture of THIS call's
    // `states` / `defaultLocalIdx` would be stale for every importer the moment the
    // author edits the state schema.
    // Block content changes propagate via the flush path, never by invalidating:
    // `applyRegistryChanges` rebuilds BlockRegistry, refreshes the atlas,
    // repoints per-room `voxels.registry`, and `resolveAllChunks` triggers a
    // remesh next tick. Hence no `hmr` block on the kind below.
    const handle = declare(blockStore, id, def as BlockDef) as BlockHandle<P>;

    // Dust is derived HERE, not at freeze, so the texture/sprite/particle entries
    // it declares are owned by the module that declared the block and the ordinary
    // per-module sweep reclaims them when the block goes. Deriving needs only the
    // tile HANDLE the model names — no registry lookup, no declaration order — so
    // it is expressible at declaration time; `extractBlockDeps` already evaluates
    // this same model factory during `declare` above, so this costs one more call
    // rather than reaching anything new.
    handle._defaultDust = deriveDefaultDust(def as BlockDef);
    return handle;
}

/** the block's dust particles, from the default state's model (state 0), shared
 *  across every state as the fallback for particle slots the author left unset.
 *  `null` when the block opted out, has no model, or names no tile. */
function deriveDefaultDust(def: BlockDef): readonly ParticleHandle[] | null {
    if (def.particles === false || !def.model) return null;
    // variants are rotations or rearrangements of one another, so the first is
    // as good a dust source as any; picking per position would be noise.
    const model = def.model(def.states.decode(0));
    const primary = Array.isArray(model) ? model[0] : model;
    // an empty variant list is rejected with a clear message at registry build;
    // don't pre-empt that with a crash in here.
    if (!primary) return null;
    return deriveBlockDust(def.id, primary);
}

/**
 * Called by the per-project barrel `src/generated/models.ts` at module-
 * eval to populate each handle's runtime fields. Barrel does not own
 * registry entries, see file header. Mutates the existing payload in
 * place so user code refs stay valid, then `touch()`es so consumers
 * (renderer, animator, prefab deps) react via the dispatch path.
 *
 * If no entry exists (cold start where the barrel ran before any user
 * `model()` call), the payload is registered under `PLACEHOLDER_OWNER`;
 * the first user `model()` call promotes ownership.
 *
 * Re-runs on every barrel re-import (hot reload). Pass through `touch`
 * is what bumps `revision` so the cli's flush handler picks up bin-url
 * changes for codegen.
 */
export function _registerModelDef(id: string, def: ModelDef): void {
    // Declared on behalf of nobody: seeds the entry when the barrel runs first,
    // and swaps the def under whoever already owns it otherwise. Ownership is
    // untouched either way, so the user's own `model()` call still claims it.
    declare(modelStore, id, def, PLACEHOLDER_OWNER);
}

/**
 * Called by the per-project barrel `src/generated/sounds.ts` at module-
 * eval to populate each handle's codegen'd fields. Barrel does not own
 * registry entries, see file header. Mutates the existing payload in
 * place so user code refs stay valid, then `touch()`es so consumers
 * react via the dispatch path.
 *
 * If no entry exists (cold start where the barrel ran before any user
 * `sound()` call), the payload is registered under `PLACEHOLDER_OWNER`;
 * the first user `sound()` call promotes ownership.
 *
 * Re-runs on every barrel re-import (hot reload). The `touch` call is
 * what bumps `revision` so the cli's flush handler picks up duration
 * changes for downstream consumers.
 */
export function _registerSoundDef(id: string, def: SoundDef): void {
    // see `_registerModelDef`: seeds or re-points, never claims ownership.
    declare(soundStore, id, def, PLACEHOLDER_OWNER);
}

/**
 * called at module-eval by the per-project codegen barrel
 * `src/generated/scenes.ts` (one call per discovered scene file).
 *
 *   - existing handle → mutate `_payload` in place so user-held refs stay
 *     valid.
 *   - no handle yet → register one under `PLACEHOLDER_OWNER` so it's
 *     visible through `registry.scenes` (icon renderer, editor inventory).
 *     If the user later declares the id via `scene()`, `claimOwnership`
 *     promotes the placeholder to the user module. Edit mode's filesystem
 *     walk surfaces every `.scene.json` (including blueprints), so many
 *     ids never get a user-side `scene()` and stay as placeholders, fine.
 *
 * Exposed via `bongle/internal`.
 */
export function _registerScenePayload(id: string, payload: ScenePayload): void {
    // A NEW def object, not a mutation of the old one: `sceneHash` covers
    // `_payload`, so this moves the hash and fires `changed`, which is what
    // makes registry-dispatch run `Content.populateScene` and bump
    // `SceneHandle.version` so prefab deps unblock.
    const previous: SceneDef | undefined = get(sceneStore, id);
    const def: SceneDef = { ...(previous ?? createSceneDef(id)), _payload: payload };
    // Going through `declare` also mints the handle here rather than waiting for
    // a user-side `scene()`. That is what fixes the case where the barrel seeded
    // a payload, populate had no handle to fill, and the later `scene()` call
    // hashed identical so nothing ever fired again.
    declare(sceneStore, id, def, PLACEHOLDER_OWNER);
}

/**
 * declare a prefab def at module scope.
 */
// generic (args-bearing) overload MUST come first: TS contextually types an
// un-annotated `fn` param from the first matching overload, so if the no-args
// overload led, `fn`'s `args` would get pinned to `Record<string, never>` and
// then fail the args-bearing call. see the two-overload note above.
export function prefab<T extends PrefabType, S extends Schema>(
    id: string,
    options: PrefabOptions<T, S>,
): PrefabHandle<SchemaType<S>>;
export function prefab<T extends PrefabType>(
    id: string,
    options: {
        type: T;
        deps?: ReadonlyArray<DepHandle>;
        node?: { realm?: Realm };
        fn?: (ctx: PrefabApplyContext<T>, args: Record<string, never>) => void;
    },
): PrefabHandle<Record<string, never>>;
export function prefab<T extends PrefabType, S extends Schema>(
    id: string,
    options: PrefabOptions<T, S>,
): PrefabHandle<SchemaType<S>> {
    const type = options.type;
    const { name, tags } = resolveAssetMeta(id, options);
    const deps = options.deps ?? [];
    const argsSchema = (options.args?.schema ?? emptyArgsSchema) as S;
    const defaultArgs = (options.args?.default ?? {}) as SchemaType<S>;
    const apply = options.fn ?? noopApply;
    const node = options.node;

    const args = options.args ? { schema: argsSchema, default: defaultArgs } : undefined;
    const applyFn = apply as (ctx: unknown, args: unknown) => void;

    const handle = declare(prefabStore, id, { id, name, tags, type, deps, args, node, apply: applyFn } as PrefabDef);
    // wire user-supplied deps into the DepGraph (replace semantics).
    // the AST wrap unions AST-detected deps on top via __addDeps/addDeps,
    // so wipe-and-rewire on re-eval stays correct: factory's setDeps
    // resets, then the wrap re-unions fresh AST-detected refs.
    setDeps(
        { registry: 'prefabs', id },
        deps.map((d) => d.dependency),
    );
    return handle as PrefabHandle<SchemaType<S>>;
}

/**
 * Replace a scene's authored payload, from the engine rather than from a
 * declaration: the dev boot template's scene-add / scene-clear HMR listeners and
 * the editor's content push.
 *
 * A purpose-named write rather than exposing `declare`, so the one way content
 * enters a store stays inside this file. `sceneHash` covers `_payload`, so this
 * moves the hash and fires `changed`, which is what makes registry-dispatch
 * re-run `Content.populateScene` and bump `SceneHandle.version`.
 */
export function setScenePayload(id: string, payload: ScenePayload | null): void {
    const previous = get(sceneStore, id);
    if (!previous) return;
    declare(sceneStore, id, { ...previous, _payload: payload }, PLACEHOLDER_OWNER);
}
