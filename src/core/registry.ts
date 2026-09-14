import * as pack from 'packcat';
import { emptyArgsSchema, noopApply, type PrefabOptions } from '../api/prefabs';
import { resolveAssetMeta } from './asset-meta';
import { clearDeps, type DepKey, getDirtyConsumers, setDeps } from './capture/dep-graph';
import { onModulePop, onModulePush, owningModule, recordDeclaration } from './capture/module-scope';
import { CONFIG_ID, type Config, DEFAULT_CONFIG, HARD_MAX_PLAYERS_PER_ROOM, MAX_TICK_RATE, MIN_TICK_RATE } from './config';
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
    isRegionOptions,
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

export type EntryMeta = {
    module: string;
    version: number;
    hash: string | undefined;
};

export type Change<T> = { kind: 'added' | 'changed' | 'removed'; id: string; payload: T };

export type HandleOf<T> = {
    readonly id: string;
    readonly dependency: DepKey;
    def: T;
};

export type RegistryStore<T, H extends HandleOf<T> = HandleOf<T>> = {
    name: string;
    byId: Map<string, T>;
    /** monotonic, never pruned: a removed declaration leaves its handle pointing at the last def it had. */
    handles: Map<string, H>;
    meta: Map<string, EntryMeta>;
    moduleToIds: Map<string, Set<string>>;
    seen: Map<string, Set<string>>;
    pendingChanges: Array<Change<T>>;
    revision: number;
    hash: (def: T) => string | undefined;
    deps?: (def: T) => DepKey[];
    hmr?: { signature?: (def: T) => string };
    handle: (id: string) => Omit<H, 'def'> & ThisType<H>;
};

export type KindOptions<T, H extends HandleOf<T>> = {
    name: string;
    /** change detector; return undefined when a def can't be honestly hashed, forcing every re-declaration to report as changed. */
    hash: (def: T) => string | undefined;
    /** producer keys this def depends on, for kinds whose dependencies are invisible to `hash`. */
    deps?: (def: T) => DepKey[];
    /** dev-only: whether importers can keep bindings across a re-declaration (patch in place) or must be invalidated. */
    hmr?: { signature?: (def: T) => string };
    /** build the empty container for `id`; `dependency` is stamped by `kind()`. */
    handle: (id: string) => Omit<H, 'def' | 'dependency'> & ThisType<H>;
};

/** structural hash over functions, maps, sets, plain objects and primitives; not crypto-grade, HMR change-detection only. */
export function structuralHash(value: unknown): string {
    return djb2(stringify(value));
}

/** objects on the current recursion path, so a back-reference degrades to a marker instead of overflowing the stack. */
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

/** synthetic owner for entries seeded before any real module has claimed them; the next real declaration adopts the entry. */
export const PLACEHOLDER_OWNER = '__placeholder__';

const allStores: Array<RegistryStore<any, any>> = [];

export function stores(): ReadonlyArray<RegistryStore<any, any>> {
    return allStores;
}

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
        // defineProperty, not a spread: spreading would invoke a forwarding accessor while `def` is still unset.
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

/** declare `id` with `def` on behalf of the module currently evaluating, minting its one handle on first sight. */
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

/** the single state transition every declaration goes through: ownership, change detection, deps and the reload shape. */
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
    // `byId` tracks the exact object user code holds even when nothing moved: consumers key caches on def identity.
    store.byId.set(id, def);
    recordSignature(store, id, def, owner);

    // undefined hash: the kind cannot prove this def is unchanged, so report it.
    if (hash !== undefined && hash === meta.hash && !depsMoved) return;

    meta.hash = hash;
    meta.version++;
    store.pendingChanges.push({ kind: 'changed', id, payload: def });
    store.revision++;
}

/** reassign an entry seeded under `PLACEHOLDER_OWNER` to its real owner; any other mismatch is two modules declaring the same id. */
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

/** any id this module owned previously but didn't re-declare this run fires `removed`. */
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

export function get<T>(store: RegistryStore<T, any>, id: string): T | undefined {
    return store.byId.get(id);
}

/** record what this declaration contributes to the HMR module boundary, for the kinds that take part. */
function recordSignature<T>(store: RegistryStore<T, any>, id: string, def: T, owner: string): void {
    const hmr = store.hmr;
    if (!hmr) return;
    // a barrel seeding a payload is not a module whose importers can go stale.
    if (owner === PLACEHOLDER_OWNER) return;
    recordDeclaration(owner, store.name, id, hmr.signature ? hmr.signature(def) : '');
}

/** sort-by-id table for one id space (traits or commands); encode via `idToIndex`, decode via `indexToId`. */
export type ProtocolTable = { idToIndex: Map<string, number>; indexToId: string[] };

export function buildProtocolTable(ids: Iterable<string>): ProtocolTable {
    const indexToId = [...ids].sort();
    const idToIndex = new Map<string, number>();
    for (let i = 0; i < indexToId.length; i++) idToIndex.set(indexToId[i]!, i);
    return { idToIndex, indexToId };
}

/** resolve a wire trait ref (netIndex preferred, id string as fallback) to a trait id. */
export function resolveTraitWireRef(
    table: ProtocolTable,
    netIndex: number | undefined,
    id: string | undefined,
): string | undefined {
    if (netIndex !== undefined) return table.indexToId[netIndex];
    return id;
}

/** tests only; clears `handles` too, since a container is minted once and kept, leaking populated state to the next test. */
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

/** drain every store's `pendingChanges` queue without acting on it, discarding initial-population `added` events. */
export function clearPendingChanges(stores: ReadonlyArray<RegistryStore<any>>): void {
    for (const store of stores) store.pendingChanges.length = 0;
}

/** render a human-readable summary of pending changes across stores, prefixed with the side that fired. */
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

export type PrefabType = 'voxels' | 'nodes' | 'composite';

/** any producer handle carrying a DepGraph `dependency` stamp; what the unified `deps: [...]` field accepts. */
export type DepHandle = { dependency: DepKey };

export type PrefabDef = {
    id: string;
    name: string;
    tags: readonly string[];
    type: PrefabType;
    deps: ReadonlyArray<DepHandle>;
    args?: { schema: Schema; default: unknown };
    node?: { realm?: Realm };
    apply: (ctx: unknown, args: unknown) => void;
};

/** stable wrapper around a `PrefabDef`; data is read through `.def` rather than copied out. */
export type PrefabHandle<Args = unknown> = {
    readonly id: string;
    dependency: { registry: 'prefabs'; id: string };
    def: PrefabDef;
    readonly __args: Args;
};

export function depId(dep: DepHandle): string {
    return dep.dependency.id;
}

/** the full id manifest one peer publishes so the other can decode its traffic by id, never by a coincidental local slot. */
export type ProtocolManifest = {
    traits: string[];
    commands: string[];
    syncs: string[][];
    controls: string[][];
};

/** build this side's manifest from the registry; sent once per connection and again whenever registrations change. */
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

/** per-trait map from a peer's wire field slot to our local slot; `undefined` if the peer has a slot we don't. */
export type SlotRemap = (number | undefined)[];

/** a resolved inbound decode context for one peer: its trait/command tables plus per-trait sync/control slot maps. */
export type InboundProtocol = {
    traits: ProtocolTable;
    commands: ProtocolTable;
    syncRemap: Map<string, SlotRemap>;
    controlRemap: Map<string, SlotRemap>;
};

/** build an `InboundProtocol` from a peer's manifest, resolving its per-trait sync and control slots against ours. */
export function buildInboundProtocol(manifest: ProtocolManifest, reg: Registry): InboundProtocol {
    const syncRemap = new Map<string, SlotRemap>();
    const controlRemap = new Map<string, SlotRemap>();
    for (let i = 0; i < manifest.traits.length; i++) {
        const traitId = manifest.traits[i];
        const handle = reg.traits.handles.get(traitId);
        if (!handle) continue; // peer trait we lack; its refs drop at trait resolve
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

/** the identity `InboundProtocol` for our own registry, the decode context for in-process (no peer) callers. */
export function localInbound(reg: Registry): InboundProtocol {
    return buildInboundProtocol(protocolManifest(reg), reg);
}

/** resolve the game config; single-keyed (id 'main'), falls back to the default when the user didn't call `config()`. */
export function resolveConfig(reg: Registry): Config {
    return reg.config.byId.get(CONFIG_ID) ?? DEFAULT_CONFIG;
}

/** rebuild the registry's derived index fields from the source stores, at engine boot and at each dev flush. */
export function reindexRegistry(reg: Registry): void {
    // iterates `byId`, not `handles`: the handle map is monotonic, so a trait whose declaration was removed still has a handle.
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
    // in place: several holders keep this object; rebinding it would leave them reading tables sized for the old state count.
    buildBlockRegistry(reg.blockRegistry, defs, handles, tiles);

    reg.protocol = {
        traits: buildProtocolTable(reg.traits.byId.keys()),
        commands: buildProtocolTable(reg.commands.byId.keys()),
    };

    for (const handle of slotToTrait) {
        if (handle) handle.netIndex = reg.protocol.traits.idToIndex.get(handle.id);
    }
}

export type Registry = {
    version: number;

    tiles: RegistryStore<TileDef, TileHandle>;
    blocks: RegistryStore<BlockDef, BlockHandle>;
    models: RegistryStore<ModelDef, ModelHandle>;
    traits: RegistryStore<TraitDef, TraitHandle>;
    /** per-trait control registrations, keyed `${traitId}.${controlId}`; lets HMR diff a control without a wholesale trait change. */
    controls: RegistryStore<ControlDef>;
    sync: RegistryStore<SyncDef>;
    scripts: RegistryStore<ScriptDef>;
    commands: RegistryStore<CommandDef, CommandHandle<pack.Schema, RpcDirection>>;
    scenes: RegistryStore<SceneDef, SceneHandle>;
    prefabs: RegistryStore<PrefabDef, PrefabHandle>;
    sounds: RegistryStore<SoundDef, SoundHandle>;
    sprites: RegistryStore<SpriteDef, SpriteHandle>;
    textures: RegistryStore<TextureDef, TextureHandle>;
    particles: RegistryStore<ParticleDef, ParticleHandle>;
    config: RegistryStore<Config>;

    blockRegistry: Blocks;
    /** slot -> trait handle for O(1) runtime lookup; the handle, since callers need its derived state as well as `.def`. */
    slotToTrait: Array<TraitHandle | undefined>;
    protocol: { traits: ProtocolTable; commands: ProtocolTable };

    /** tests only, wipes every KindStore. */
    _reset(): void;
};

const tileHash = (t: TileDef) => structuralHash(t);
const spriteHash = (s: SpriteDef) => structuralHash(s);
// a computed texture hashes as undefined: `fn` hashes as source text, blind to what it closes over.
const textureHash = (t: TextureDef) => (t.from === 'computed' ? undefined : structuralHash(t));

/** the voxel atlas packs tiles in cells of this size; every tile frame is a multiple of it per side. */
export const BLOCK_TILE_SIZE = 16;
const particleHash = (p: ParticleDef) => structuralHash(p);

const blockHash = (d: BlockDef) => structuralHash(d);

/** resolves the model factory across every state and collects referenced tile ids, since DepGraph can't see closed-over TileHandles. */
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
        if (model) for (const m of Array.isArray(model) ? model : [model]) collectModelTileIds(m, tileIds);
    }
    const deps: DepKey[] = [];
    for (const id of tileIds) deps.push({ registry: 'tiles', id });
    return deps;
};

// not wholesale: `ModelDef` carries a detached `scene: Node` tree with parent-pointer cycles, so hash the bin URLs instead.
const modelHash = (d: ModelDef) => structuralHash({ modelId: d.modelId, src: d.src, bin: d.bin });

const prefabHash = (p: PrefabDef) => structuralHash({ id: p.id, type: p.type, args: p.args, node: p.node, apply: p.apply });

const extractPrefabDeps = (p: PrefabDef): DepKey[] => {
    const deps: DepKey[] = [];
    for (const dep of p.deps) deps.push(dep.dependency);
    return deps;
};

// SceneHandle carries a deserialized `node: Node` tree (cycles); hash the authored `_payload` instead.
const sceneHash = (s: SceneDef) => structuralHash(s);

// body + meta only: `controls`/`sync`/`scripts` have their own per-id stores so a single edit doesn't force a wholesale trait swap.
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
// `serdes`/`handle` are derived; hashing either would make every re-declaration look like a content change.
const commandHash = (c: CommandDef) => structuralHash({ id: c.id, direction: c.direction, schema: c.schema });
const configHash = (c: Config) => structuralHash(c);

// `duration` flows the codegen barrel's in-place mutation as a `changed` event; `version`/`name` deliberately excluded.
const soundHash = (s: SoundDef) => structuralHash({ soundId: s.soundId, src: s.src, long: s.long, duration: s.duration });

export const tileStore = kind<TileDef, TileHandle>({
    name: 'tiles',
    hash: tileHash,
    // signature over the frames only: `block()` reads a tile's resolved texture id at declaration time to derive dust.
    hmr: { signature: (t) => structuralHash(t.frames) },
    handle: (id) => ({ id }),
});

export const blockStore = kind<BlockDef, BlockHandle>({
    name: 'blocks',
    hash: blockHash,
    deps: extractBlockDeps,
    // methods read the schema off `this.def`, never a closure capture, so the handle outlives every re-declaration.
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
    // forwarding accessors rather than copied fields: a re-declaration re-points `def`, and holders see the new data through these.
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
    // scripts destructure trait fields by name, so any body delta needs fresh script closures rather than a patch.
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
    // opts in with no signature: importers bind to which script ids exist, not their bodies.
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
    // `node`, `voxels` and `version` are filled in by `Content.populateScene` off the def's `_payload`.
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
    // a computed texture's sources are `DepKey`s in the def, invisible to `hash` as content, so the edges go to DepGraph.
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

type BlockContainer = Omit<BlockHandle, 'def' | 'dependency'> & ThisType<BlockHandle>;
type ModelContainer = Omit<ModelHandle, 'def' | 'dependency'> & ThisType<ModelHandle>;

/** assemble the singleton, collecting the kinds and owning what's genuinely cross-kind: `blockRegistry` and the protocol. */
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
        slotToTrait: [] as Array<TraitHandle | undefined>,
        blockRegistry: createBlockRegistry(),
        protocol: { traits: buildProtocolTable([]), commands: buildProtocolTable([]) },
    } as Registry;

    // tests only: wipes every store so the next test's setup starts from a virgin registry.
    reg._reset = () => {
        _resetStores();
        reg.version = 0;
        // block state-id reservations are process-lifetime; reset so a suite declaring a different block set per case doesn't grow it.
        _resetBlockSlots();
        reindexRegistry(reg);
    };

    return reg;
}

/** bump once per dispatch drain, called by `applyRegistryChanges*` after every branch has reacted. */
export function bumpVersion(reg: Registry): void {
    reg.version++;
}

/** module-scope singleton, every declarative API upserts into this. */
export const registry = init();

/** stable mapping from trait string id to runtime slot, cached for the process lifetime; the key into `node._traits`. */
export const traitSlots: Record<string, number> = {};

let slotCounter = 0;

/** define a trait; registers it in the global capture area and returns a handle used with getTrait, addTrait, hasTrait, query, etc. */
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
    const icon = options?.icon ?? null;

    const handle = declare(traitStore, id, {
        id,
        name,
        body: nextBody,
        persist,
        icon,
        // control()/sync()/script() re-register into these right after; starting empty lets a body edit actually land.
        controls: [],
        sync: [],
        scripts: [],
    }) as TraitHandle<TraitInstance<S>>;

    return handle;
}

/** register a control on a trait, callable multiple times per trait; `controlId` is the persisted key in scene files. */
export function control<T extends TraitBase, V>(handle: TraitHandle<T>, controlId: string, body: ControlBody<T, V>): void {
    const target = handle.def;
    if (target.controls.some((c) => c.controlId === controlId)) {
        console.warn(`[bongle] trait '${target.id}' already has a control with id '${controlId}'; ignoring re-register`);
        return;
    }
    // into the per-kind store so HMR detects individual control edits without flipping the parent trait hash.
    const key = `${target.id}.${controlId}`;
    const reg = declare(controlStore, key, { ...body, traitId: target.id, controlId } as unknown as ControlDef).def;
    target.controls.push(reg);
}

/** register a sync on a trait, callable multiple times per trait; returns a SyncHandle for producer-side dirty hints. */
export function sync<T extends TraitBase, S>(handle: TraitHandle<T>, syncId: string, body: SyncBody<T, S>): SyncHandle<T> {
    const target = handle.def;
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
/** declare a particle type; called at module scope, returns a pure-data handle resolved by id at spawn time. */
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
/** declare a texture: one picture, from disk or computed from other textures; a consumer's `frames` is where animation lives. */
export function texture<I extends Record<string, TextureHandle>, P extends DrawParams>(
    id: string,
    options: TextureOptions<I, P>,
): TextureHandle {
    if (isRegionOptions(options)) {
        return declare(textureStore, id, { id, from: 'region', of: options.of.dependency, region: options.region });
    }
    if (!isComputedOptions(options)) {
        return declare(textureStore, id, { id, from: 'file', src: options.src });
    }
    // handles in, DepKeys out: the stored def stays plain hashable data.
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
/** declare a sprite; single entry gives a static sprite, array gives flipbook frames. */
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

/** turn a consumer's `src` into declared textures and return refs to them; a single frame keeps the owner's id, multiple are `id:0`, `id:1`. */
function declareFrames(
    ownerId: string,
    src: ImageSource | ImageSource[] | undefined,
    frames: TextureHandle[] | undefined,
): DepKey[] {
    if (frames) return frames.map((f) => f.dependency);
    if (src === undefined) throw new Error(`[bongle] '${ownerId}' needs either a 'src' or 'frames'`);
    const sources = Array.isArray(src) ? src : [src];
    const single = sources.length === 1;
    return sources.map((source, i) => texture(single ? ownerId : `${ownerId}:${i}`, { src: source }).dependency);
}

/*#__NO_SIDE_EFFECTS__*/
/** declare an audio clip; called at module scope, returns the codegen'd `SoundHandle`. */
export function sound<const Id extends string>(
    id: Id,
    options: SoundOptions,
): Id extends keyof SoundHandleMap ? SoundHandleMap[Id] : SoundHandle {
    const long = options.long ?? false;
    const src = options.src;
    const meta = resolveAssetMeta(id, options);
    // minting a placeholder is the normal cold-start path: every declared sound hits it before the barrel's first flush.
    const previous: SoundDef | undefined = get(soundStore, id);
    const def: SoundDef = previous ? { ...previous, src, long, ...meta } : createSoundPlaceholderDef(id, src, long, meta);
    return declare(soundStore, id, def) as never;
}

/** declare per-game config; call once at module scope, before scripts/traits/etc. */
export function config(c: Config): Config {
    const server = c.server;
    if (server) {
        const maxPlayers = server.maxPlayers;
        if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > HARD_MAX_PLAYERS_PER_ROOM) {
            throw new Error(
                `config({ server: { maxPlayers } }): expected integer in [1, ${HARD_MAX_PLAYERS_PER_ROOM}], got ${maxPlayers}`,
            );
        }
        const tickRate = server.tickRate;
        if (tickRate !== undefined && (!Number.isInteger(tickRate) || tickRate < MIN_TICK_RATE || tickRate > MAX_TICK_RATE)) {
            throw new Error(
                `config({ server: { tickRate } }): expected integer in [${MIN_TICK_RATE}, ${MAX_TICK_RATE}], got ${tickRate}`,
            );
        }
    }
    declare(configStore, CONFIG_ID, c);
    return c;
}

/** define a command: a typed network message; handlers aren't part of the definition, they're registered via listen(). */
export function command<S extends pack.Schema, D extends RpcDirection>(id: string, direction: D, schema: S): CommandHandle<S, D> {
    const serdes = pack.build(schema);

    const handle = declare(commandStore, id, { id, direction, schema, serdes: serdes as CommandDef['serdes'] });
    return handle as unknown as CommandHandle<S, D>;
}

/*#__NO_SIDE_EFFECTS__*/
/** declare a model; called at module scope, returns the codegen'd `ModelHandle`. */
export function model<const Id extends string>(
    id: Id,
    options: ModelOptions,
): Id extends keyof ModelHandleMap ? ModelHandleMap[Id] : ModelHandle {
    const src = options.src;
    const meta = resolveAssetMeta(id, options);
    // minting a placeholder is the normal cold-start path: every declared model hits it before the barrel's first flush.
    const previous: ModelDef | undefined = get(modelStore, id);
    const def: ModelDef = previous ? { ...previous, src, ...meta } : createModelPlaceholderDef(id, src, meta);
    return declare(modelStore, id, def) as never;
}

/** declare a scene resource at module scope; returns a stable handle whose fields the engine populates once the scene loads. */
export function scene(id: string, options?: SceneOptions): SceneHandle {
    // identity-stable: only the first call decides client/server; `name` and `_payload` ride the previous def.
    const previous: SceneDef | undefined = get(sceneStore, id);
    const def: SceneDef = previous ? { ...previous, ...resolveAssetMeta(id, options) } : createSceneDef(id, options);
    return declare(sceneStore, id, def);
}

/** register a script (behavior) on a trait, callable multiple times per trait; attaching the trait instantiates one ScriptInstance per script. */
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
    // upsert into the trait def's script list: reuse the slot if this id already exists, else append.
    const found = target.scripts.findIndex((s) => s.scriptId === scriptId);
    const index = found === -1 ? target.scripts.length : found;
    target.scripts[index] = def;
    // into the per-kind store so HMR detects individual script factory edits without flipping the parent trait hash.
    declare(scriptStore, key, def);
    // wire dep edges so the dirty set covers scripts whose closed-over producers changed even when the factory body didn't.
    setDeps({ registry: 'scripts', id: key }, opts?.deps ? opts.deps.map((d) => d.dependency) : []);
    return def;
}

/*#__NO_SIDE_EFFECTS__*/
/** declare a tile: one 16x16 entry in the voxel atlas, made of textures; returns a handle passed to block model definitions. */
export function tile(id: string, options: TileOptions): TileHandle {
    const frames = declareFrames(id, options.src, options.frames);
    const fps = options.fps ?? 1;
    const interpolate = options.interpolate ?? false;
    // computed frames carry their size, checked here; a file frame's size isn't known until the pipeline loads it.
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
/** declare a block type; called at module scope, returns a handle used for getting global state ids in gameplay code. */
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

    // methods read the schema off `this.def`, never a closure capture, so the handle outlives every re-declaration.
    const handle = declare(blockStore, id, def as BlockDef) as BlockHandle<P>;

    // derived here, not at freeze, so the texture/sprite/particle entries it declares are owned by the declaring module.
    handle._defaultDust = deriveDefaultDust(def as BlockDef);
    return handle;
}

/** the block's dust particles, from the default state's model, shared as the fallback for unset particle slots. */
function deriveDefaultDust(def: BlockDef): readonly ParticleHandle[] | null {
    if (def.particles === false || !def.model) return null;
    const model = def.model(def.states.decode(0));
    const primary = Array.isArray(model) ? model[0] : model;
    if (!primary) return null;
    return deriveBlockDust(def.id, primary);
}

/** called by the per-project barrel `src/generated/models.ts` at module-eval to populate each handle's runtime fields. */
export function _registerModelDef(id: string, def: ModelDef): void {
    declare(modelStore, id, def, PLACEHOLDER_OWNER);
}

/** called by the per-project barrel `src/generated/sounds.ts` at module-eval to populate each handle's codegen'd fields. */
export function _registerSoundDef(id: string, def: SoundDef): void {
    declare(soundStore, id, def, PLACEHOLDER_OWNER);
}

/** called at module-eval by the per-project codegen barrel `src/generated/scenes.ts`, one call per discovered scene file. */
export function _registerScenePayload(id: string, payload: ScenePayload): void {
    const previous: SceneDef | undefined = get(sceneStore, id);
    const def: SceneDef = { ...(previous ?? createSceneDef(id)), _payload: payload };
    declare(sceneStore, id, def, PLACEHOLDER_OWNER);
}

/** declare a prefab def at module scope. */
// generic (args-bearing) overload must come first, or TS pins `fn`'s `args` type from the no-args overload.
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
    setDeps(
        { registry: 'prefabs', id },
        deps.map((d) => d.dependency),
    );
    return handle as PrefabHandle<SchemaType<S>>;
}

/** replace a scene's authored payload from the engine rather than from a declaration. */
export function setScenePayload(id: string, payload: ScenePayload | null): void {
    const previous = get(sceneStore, id);
    if (!previous) return;
    declare(sceneStore, id, { ...previous, _payload: payload }, PLACEHOLDER_OWNER);
}
