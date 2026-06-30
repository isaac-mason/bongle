import { recordTrait } from '../capture/module-scope';
import { registry, structuralHash, upsert } from '../registry';
import type { Node } from './nodes';
import type { pack } from './pack';
import type { prop } from './prop';
import type { ScriptDef } from './scripts';

/* ── trait body types ── */

/**
 * trait body, a plain object literal whose values are either:
 * - a literal (number, string, boolean, null) shared as the default, or
 * - a factory `() => T` called once per instance to build a fresh value
 *   (required for any mutable default, Vec3, Quat, Mat4, arrays, objects).
 *
 * trait-level options (e.g. persist) live in the third arg to `trait()`,
 * keeping the body purely instance-field shaped.
 */
export type TraitBody = Record<string, unknown>;

/** trait-level options, passed as the third arg to `trait()`. */
export type TraitOptions = {
    /** human-readable display name for editor UIs (trait pickers,
     *  inspectors). falls back to the string id when omitted. */
    name?: string;
    /**
     * whether instances of this trait round-trip through scene files.
     * default `true`. set to `false` for traits attached at runtime that
     * should never appear on disk (e.g. character controllers, gizmos).
     * for tag traits (no controls), `persist: false` still strips the
     * trait from saved scenes, its mere presence on the node is the data
     * being filtered.
     */
    persist?: boolean;
};

/** factory marker: a value-producing function called once per instance. */
type Factory<T> = () => T;

/** field names that cannot be used in trait definitions. */
type ReservedTraitKey = '_node' | '_def' | '_sync';

/**
 * map a TraitBody to its instance shape: factory values are unwrapped
 * to their return type, literals pass through.
 */
export type TraitInstance<S extends TraitBody> = TraitBase & {
    [K in keyof S as K extends ReservedTraitKey ? never : K]: S[K] extends Factory<infer R> ? R : S[K];
};

/* ── trait-level registrations: control & sync ───────────────────────
 *
 * each kind follows the same shape: a `Body` describes what the user
 * passes; the corresponding `Def` is `Body & Stamp`, where the stamp is
 * the trait id + the per-kind local id. authoring stays declarative,
 * stored defs are self-describing (consumers don't need traitId threaded
 * through args), and adding a body field only touches the Body type.
 */

/** identifying stamp shared by every per-trait registration. */
type TraitChildStamp<KindIdKey extends string> = { traitId: string } & { [K in KindIdKey]: string };

/** body passed by the user to `control()`, fields only, no stamps. */
export type ControlBody<T extends TraitBase = TraitBase, V = unknown> = {
    label?: string;
    schema: prop.Schema;
    get: (instance: T) => V;
    set: (instance: T, value: V) => void;
    // optional inspector hints
    category?: string;
    hidden?: boolean;
};

/** stored ControlDef. body + `{ traitId, controlId }`. */
export type ControlDef<T extends TraitBase = TraitBase, V = unknown> = ControlBody<T, V> & TraitChildStamp<'controlId'>;

/** measures how much a sync value changed, receives the previously-emitted value
 *  and the current one, returns a magnitude compared against a `ThresholdRate`'s
 *  `threshold`. `syncMetric.{distance,angle,scalar}` cover the common shapes. */
export type SyncMetric = (previous: any, current: any) => number;

/** threshold-gated rate: re-emit only once `metric(previous, current)` reaches
 *  `threshold` since the last emit. sub-threshold changes accumulate against the
 *  last emitted value, so slow drift still reconciles. body-agnostic, it reads the
 *  field's own value, so it works for any field and any driver (rigid body, AABB
 *  body, script, animation). this replaces the old velocity-based 'movement' rate. */
export type ThresholdRate = { threshold: number; metric: SyncMetric };

/**
 * sync rate category or explicit Hz cap for per-sync rate gating.
 * - 'realtime', emit whenever bytes change (no throttle)
 * - 'dirty', never auto-emit; only when SyncHandle.dirty() is called
 * - number, explicit Hz cap for the cold-path byte diff
 * - ThresholdRate, emit only on a significant value change (movement/rotation/etc.)
 */
export type SyncRateConfig = 'realtime' | 'dirty' | number | ThresholdRate;

/** body passed by the user to `sync()`, fields only, no stamps. */
export type SyncBody<T extends TraitBase = TraitBase, S = unknown> = {
    schema: pack.Schema;
    pack: (instance: T) => S;
    unpack: (value: S, instance: T) => void;
    /** tick-rate gate for the cold (byte-diff) path. 'realtime' default. */
    rate?: SyncRateConfig;
    /** authority for accepting writes. default 'server'. */
    authority?: 'server' | 'owner';
};

/** stored SyncDef. body + `{ traitId, syncId }`. wire envelope keys by
 *  registration index (`SyncHandle.index`), not `syncId`. */
export type SyncDef<T extends TraitBase = TraitBase, S = unknown> = SyncBody<T, S> & TraitChildStamp<'syncId'>;

/**
 * returned by sync() at registration time. carries the sync index and a
 * producer-side hint to skip byte-diffing.
 *   const poseSync = sync(TransformTrait, { schema, pack, unpack });
 *   poseSync.dirty(t);   // "I changed this, emit on next diff pass
 *                        //  without bothering to byte-diff."
 */
export type SyncHandle<T extends TraitBase = TraitBase> = {
    readonly index: number;
    dirty(instance: T): void;
};

/* ── instance base ── */

/**
 * per-instance replication working-state, array-indexed by sync slice (parallel
 * to `_def.sync`), so the diff is array indexing, not keyed side-map lookups.
 */
export type TraitSyncState = {
    /** one "locally dirty" bit per slice, set by producers (SyncHandle.dirty),
     *  consumed + cleared by the diff pass; cleared by clearSyncDirty on an
     *  applied replicated write. */
    dirty: Uint32Array;
    /** [i] = last-emitted serialized bytes for slice i (the byte-diff snapshot). */
    bytes: Array<Uint8Array | undefined>;
    /** [i] = last-emitted value for slice i, ThresholdRate slices only. */
    values: unknown[];
    /** [i] = monotonic replication version for slice i. f64 because the version
     *  counter grows unbounded and must not wrap an int32. */
    versions: Float64Array;
    /** max of this trait's field versions, the send-path trait-level gate. */
    traitVersion: number;
};

/** base shape of every trait instance, has `_node` back-ref + def back-ref. */
export type TraitBase = {
    /** reference to the node this trait instance belongs to */
    _node: Node;
    /** the TraitDef this instance was built from */
    _def: TraitDef;
    /**
     * per-instance replication working-state, dirty bits + diff snapshots,
     * array-indexed by sync slice. allocated in buildTraitInstance when the
     * trait has syncs; undefined otherwise (helpers no-op in that case).
     */
    _sync?: TraitSyncState;
};

/**
 * flag sync `idx` as locally dirty so the next diff pass emits it. `idx`
 * is the SyncDef's position in `_def.sync` (also the SyncHandle.index
 * returned from the original `sync()` call).
 */
export function setSyncDirty(instance: TraitBase, idx: number): void {
    const s = instance._sync;
    if (!s) return;
    s.dirty[idx >> 5] |= 1 << (idx & 31);
}

/**
 * clear the dirty flag for sync `idx`. used when a replicated write is
 * applied, the value was just synced from the wire, so it isn't a local
 * change to re-emit. (`idx >> 5` picks the Uint32 word, `idx & 31` is the
 * bit inside it.)
 */
export function clearSyncDirty(instance: TraitBase, idx: number): void {
    const s = instance._sync;
    if (!s) return;
    s.dirty[idx >> 5] &= ~(1 << (idx & 31));
}

/* ── trait handle ── */

/**
 * the handle returned by trait(). used with getTrait, addTrait, hasTrait,
 * query, findAncestor, etc. the __type field carries the instance type for
 * inference; it does not exist at runtime.
 */
export type TraitHandle<T extends TraitBase = TraitBase> = {
    readonly _id: string;
    /**
     * runtime slot, stable integer identity assigned the first time `trait(id, ...)`
     * runs, cached in `traitSlots[id]` for the process lifetime. Used as the key
     * in `node._traits: Map<number, TraitBase>` and anywhere runtime code indexes
     * a trait. Distinct from the *wire index* (sort-by-id position computed at flush,
     * lives only on the rpc/replication layer).
     */
    readonly _slot: number;
    readonly _def: TraitDef;
    /** DepGraph dependency, see SceneHandle.dependency. */
    dependency: { registry: 'traits'; id: string };
    /** phantom, carries the instance type for inference. not present at runtime. */
    readonly __type: T;
};

/** extract the instance type from a trait handle. */
export type TraitType<H extends TraitHandle> = H['__type'];

/* ── trait definition ── */

export type TraitDef = {
    id: string;
    /** human-readable display name for editor UIs. always set,
     *  defaults to `id` when the author didn't supply one. */
    name: string;
    /**
     * runtime slot, see `TraitHandle._slot`. Distinct from any wire index;
     * `node._traits` is keyed by `slot`, while the wire encoding uses a
     * sort-by-id position computed fresh per flush at the rpc/replication layer.
     */
    slot: number;
    /** raw body of the trait, literals + factories, indexed by field name. */
    body: Record<string, unknown>;
    /** whether instances of this trait are saved to scene files. default true. */
    persist: boolean;

    /** control registrations in registration order. */
    controls: ControlDef[];
    /** lookup by control id. */
    controlsById: Map<string, { reg: ControlDef; index: number }>;
    /** sync registrations in registration order. position in this array is
     *  the trait-local sync key used in wire packing (`${wireIndex}:${syncPos}`). */
    sync: SyncDef[];
    /** lookup by sync id. */
    syncById: Map<string, { reg: SyncDef; index: number }>;
    /** script registrations in registration order. one ScriptInstance per
     *  script per attached trait, instantiated when the trait attaches to a
     *  live node. */
    scripts: ScriptDef[];
    /** lookup by script id (user-supplied, within this trait). */
    scriptsById: Map<string, { reg: ScriptDef; index: number }>;
    /**
     * canonical handle for this def. populated by `trait()` immediately
     * after the def is constructed, so any registry lookup yields the
     * same handle the original `trait()` call returned. Used for
     * by-id attach paths (e.g. optional/conditionally-loaded traits like
     * the editor trait) where the call site cannot import the handle
     * directly. Forms a `def.handle._def === def` cycle, fine for GC,
     * but means TraitDef must never be JSON.stringify'd.
     */
    handle: TraitHandle;
};

/* ── global trait registry ── */

let slotCounter = 0;

/**
 * stable mapping from trait string id to runtime slot. Cached for the
 * process lifetime, a trait id always gets the same slot, even if its
 * registry entry is removed and re-added during HMR. Used as the integer
 * key into `node._traits` and friends.
 */
export const traitSlots: Record<string, number> = {};

/* ── trait() ── */

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

    const def: TraitDef = {
        id,
        name: options?.name ?? id,
        slot,
        body: body ?? ({} as S),
        persist: options?.persist ?? true,
        controls: [],
        controlsById: new Map(),
        sync: [],
        syncById: new Map(),
        scripts: [],
        scriptsById: new Map(),
        handle: null!,
    };
    const handle: TraitHandle<TraitInstance<S>> = {
        _id: id,
        _slot: slot,
        _def: def,
        dependency: { registry: 'traits', id },
        __type: null!,
    };
    def.handle = handle;

    upsert(registry.traits, id, def);
    // bodyHash = structural hash of the trait body (literals by value,
    // factories by toString). any body delta, added/removed key, default
    // tweak, factory swap, flips the hash and forces importer cascade.
    // a default change can silently be a type change (e.g. number → string,
    // vec3 factory → quat factory), so we treat any body delta as needing
    // fresh script closures rather than try to classify "safe" tweaks.
    recordTrait(id, structuralHash(def.body));

    return handle;
}

/* ── trait-level registrars ── */

/**
 * register a control on a trait. callable multiple times per trait.
 * declared *after* the trait() literal so `t` is fully typed in get/set.
 * `id` is a stable string used as the persisted key in scene files and
 * the inspector lookup key.
 */
export function control<T extends TraitBase, V>(handle: TraitHandle<T>, controlId: string, body: ControlBody<T, V>): void {
    const target = handle._def;
    if (target.controlsById.has(controlId)) {
        console.warn(`[bongle] trait '${target.id}' already has a control with id '${controlId}'; ignoring re-register`);
        return;
    }
    const reg = { ...body, traitId: target.id, controlId } as unknown as ControlDef;
    target.controlsById.set(controlId, { reg, index: target.controls.length });
    target.controls.push(reg);
    // upsert into the per-kind store so HMR detects individual control
    // edits without flipping the parent trait hash. key matches the
    // composed `${traitId}.${controlId}` shape used elsewhere.
    upsert(registry.controls, `${target.id}.${controlId}`, reg);
}

/**
 * register a sync on a trait. callable multiple times per trait.
 * `id` is a stable string used for debug and per-attachment diff tracking.
 * returns a SyncHandle for producer-side dirty hints; wire envelope still
 * keys by `SyncHandle.index` (the slot in def.sync).
 */
export function sync<T extends TraitBase, S>(handle: TraitHandle<T>, syncId: string, body: SyncBody<T, S>): SyncHandle<T> {
    const target = handle._def;
    if (target.syncById.has(syncId)) {
        console.warn(`[bongle] trait '${target.id}' already has a sync with id '${syncId}'; ignoring re-register`);
        return {
            index: target.syncById.get(syncId)!.index,
            dirty(instance: T) {
                setSyncDirty(instance, target.syncById.get(syncId)!.index);
            },
        };
    }
    const reg = { ...body, traitId: target.id, syncId } as unknown as SyncDef;
    const index = target.sync.length;
    target.syncById.set(syncId, { reg, index });
    target.sync.push(reg);
    // upsert into the per-kind store so HMR detects individual sync
    // edits without flipping the parent trait hash.
    upsert(registry.sync, `${target.id}.${syncId}`, reg);
    return {
        index,
        dirty(instance: T) {
            setSyncDirty(instance, index);
        },
    };
}

/* ── instance construction ── */

/**
 * build a trait instance from a TraitDef and optional override props
 * (from scene-pack deserialization). overrides keyed by control id,
 * fields without a matching control just take the body default.
 *
 * override values are taken by reference, callers that pass cached/
 * shared source data are responsible for cloning so runtime mutations
 * don't bleed back.
 */
export function buildTraitInstance(def: TraitDef, overrides?: Record<string, unknown>): TraitBase {
    const instance: TraitBase & Record<string, unknown> = { _node: null!, _def: def };

    for (const [key, value] of Object.entries(def.body)) {
        if (typeof value === 'function') {
            instance[key] = (value as Factory<unknown>)();
        } else if (value !== null && typeof value === 'object') {
            // structuredClone to avoid sharing object/array literals across instances
            instance[key] = structuredClone(value);
        } else {
            instance[key] = value;
        }
    }

    if (overrides) {
        for (const [key, value] of Object.entries(overrides)) {
            // overrides for control-backed fields go through reg.set so any
            // side effects (markDirty, etc.) fire as if the field was edited.
            // overrides for plain fields land via direct assignment.
            const ci = def.controlsById.get(key);
            if (ci) {
                ci.reg.set(instance as TraitBase, value);
            } else {
                instance[key] = value;
            }
        }
    }

    // per-instance sync working-state: one dirty bit per slice (Uint32 words,
    // realistic counts < 32 fit a single word) + the diff snapshot arrays
    // (bytes/values), indexed by slice.
    if (def.sync.length > 0) {
        instance._sync = {
            dirty: new Uint32Array(Math.ceil(def.sync.length / 32)),
            bytes: new Array(def.sync.length),
            values: new Array(def.sync.length),
            versions: new Float64Array(def.sync.length),
            traitVersion: 0,
        };
    }

    return instance;
}
