import { recordTrait } from '../capture/module-scope';
import { registry, structuralHash, upsert } from '../registry';
import type { pack } from './pack';
import type { prop } from './prop';
import { buildResolution, type ResolutionDef } from './resolutions';
import type { Node } from './scene-tree';
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

/**
 * The third kind of trait-body value, beside a literal and a factory: a
 * *directive*, an instruction to `trait()` rather than a default. `my()`
 * returns one. The engine initialises the field (to `null`) and registers
 * whatever the directive declares; the author never assigns it.
 *
 * Branded with a registry symbol rather than `Symbol()` so the check survives
 * an HMR re-evaluation that mints a fresh module scope — a plain unique symbol
 * would silently stop matching markers built by a module copy that didn't
 * re-run, and the field would quietly go unmaintained.
 */
export const $directive: unique symbol = Symbol.for('bongle.directive');

export type Directive<T> = {
    readonly [$directive]: 'resolution';
    /** phantom, carries the resolved field type. not present at runtime. */
    readonly __type: T;
    /** the hierarchy condition this field resolves. */
    readonly source: unknown;
    readonly opts?: unknown;
};

export function isDirective(v: unknown): v is Directive<unknown> {
    return typeof v === 'object' && v !== null && $directive in v;
}

/** sentinel slot marking `Self`; swapped for the owning trait's slot at registration. */
export const SELF_SLOT = -1;

declare const SELF_MARKER: unique symbol;
/**
 * Placeholder for "this trait's own instance type", for a field that points at
 * another instance of the trait it is declared on. A trait body cannot name the
 * type being inferred from it, so `Self` stands in and `TraitInstance`
 * substitutes the real type:
 *
 * ```ts
 * export const TransformTrait = trait('transform', { _parent: my(Ancestor(Self)) });
 * // instance type: { _parent: TransformTrait | null }
 * ```
 *
 * Extends `TraitBase` so it satisfies `TraitHandle`'s constraint; the brand is
 * what `TraitInstance` matches on to make the substitution.
 */
export type Self = TraitBase & { readonly [SELF_MARKER]: true };

/**
 * Stand-in handle for "the trait being defined", so a body can reference itself
 * in a directive: `parent: my(Ancestor(Self))`. Resolved to the enclosing
 * trait's slot when `trait()` registers the directive; it is never a real trait
 * and must not reach `addTrait` or a query.
 */
export const Self = { _id: 'bongle.self', _slot: SELF_SLOT } as unknown as TraitHandle<Self>;

/** field names that cannot be used in trait definitions. */
type ReservedTraitKey = '_node' | '_def' | '_sync';

/**
 * map a TraitBody to its instance shape: factory values are unwrapped
 * to their return type, literals pass through.
 */
export type TraitInstance<S extends TraitBody> = TraitBase & {
    [K in keyof S as K extends ReservedTraitKey ? never : K]: ResolveField<S[K], TraitInstance<S>>;
};

/** unwrap a body field to its instance type: factories to their return type,
 *  `Self` to the instance type being built, literals to themselves. */
// a directive is a declaration, not a default: its field takes the type the
// directive resolves to. Checked first, and in containment form so it doesn't
// distribute over a union.
type ResolveField<V, TSelf> = [V] extends [Directive<infer D>]
    ? SubstituteSelf<D, TSelf>
    : V extends Factory<infer R>
      ? SubstituteSelf<R, TSelf>
      : SubstituteSelf<V, TSelf>;

// `[Self] extends [V]` asks whether V *contains* the marker, rather than
// whether V is assignable to it — the latter also matches `null`, which would
// rewrite every nullable field in the codebase. `0 extends 1 & V` is the
// standard `any` guard: without it an `any`-typed field would match too.
type SubstituteSelf<V, TSelf> = 0 extends 1 & V ? V : [Self] extends [V] ? ([null] extends [V] ? TSelf | null : TSelf) : V;

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

/**
 * DIRTINESS policy: what counts as a change worth sending. orthogonal to `rate`
 * (how often) — nothing un-dirty ever sends, regardless of rate.
 * - 'diff' (default), dirty whenever the packed bytes differ.
 * - 'explicit', never auto-dirty; only `SyncHandle.dirty()` marks it (set-once
 *   fields whose value the byte-diff can't be trusted to catch cheaply).
 */
export type DirtyConfig = 'diff' | 'explicit';

/**
 * RATE policy: the maximum send cadence for a dirty value. orthogonal to `dirty`.
 * - 'realtime' (default), send every tick the value is dirty (no throttle).
 * - { hz }, send at most `hz` times/sec — a dirty value that comes up before the
 *   interval elapses waits, then sends its latest (Quake's snapshotMsec gate).
 */
export type RateConfig = 'realtime' | { hz: number };

/** body passed by the user to `sync()`, fields only, no stamps. */
export type SyncBody<T extends TraitBase = TraitBase, S = unknown> = {
    schema: pack.Schema;
    pack: (instance: T) => S;
    unpack: (value: S, instance: T) => void;
    /** what counts as a change worth sending. default 'diff' (byte-diff). */
    dirty?: DirtyConfig;
    /** max send cadence for a dirty value. default 'realtime'. */
    rate?: RateConfig;
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
    /** nearest-trait resolutions declared in this trait's body (`my()`), in order.
     *  Owned by the def so an HMR re-eval that drops a declaration drops the
     *  resolution with it, the same way controls and syncs are handled. */
    resolutions: ResolutionDef[];

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
        resolutions: [],
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

    // directives in the body are declarations, not defaults: register what they
    // declare now that the def (and its slot, which `Self` resolves to) exists.
    for (const [key, value] of Object.entries(def.body)) {
        if (!isDirective(value)) continue;
        const built = buildResolution(slot, key, value);
        if (built !== null) def.resolutions.push(built);
    }

    upsert(registry.traits, id, def);
    // bodyHash = structural hash of the trait body (literals by value,
    // factories by toString). any body delta, added/removed key, default
    // tweak, factory swap, flips the hash and forces importer cascade.
    // a default change can silently be a type change (e.g. number → string,
    // vec3 factory → quat factory), so we treat any body delta as needing
    // fresh script closures rather than try to classify "safe" tweaks.
    recordTrait(id, structuralHash(hashableBody(def.body)));

    return handle;
}

/**
 * Body with directives reduced to what they declare. A directive holds the
 * condition's trait *handle*, and a handle points back at its def which points
 * back at the handle — hashing that walks a cycle, and hashes unrelated def
 * internals besides. What actually matters for change detection is the target
 * trait, the source kind, and the hook's text.
 */
function hashableBody(body: TraitBody): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
        out[key] = isDirective(value) ? describeDirective(value) : value;
    }
    return out;
}

function describeDirective(d: Directive<unknown>): string {
    const source = (d as { source?: { trait?: { _id?: string }; src?: number } }).source;
    const opts = (d as { opts?: { onResolve?: (...args: unknown[]) => unknown } }).opts;
    return `resolution:${source?.trait?._id ?? '?'}:${source?.src ?? '?'}:${opts?.onResolve?.toString() ?? ''}`;
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
/** deep-copy a trait value; plain arrays/objects directly, anything else via structuredClone. */
export function cloneTraitValue(value: object): unknown {
    if (Array.isArray(value)) {
        const length = value.length;
        const out = new Array(length);
        for (let i = 0; i < length; i++) {
            const item = value[i];
            out[i] = item !== null && typeof item === 'object' ? cloneTraitValue(item) : item;
        }
        return out;
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        return (value as Uint8Array).slice();
    }
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
        const source = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(source)) {
            const item = source[key];
            out[key] = item !== null && typeof item === 'object' ? cloneTraitValue(item) : item;
        }
        return out;
    }
    return structuredClone(value);
}

/** how one body field turns into an instance field. */
enum FieldKind {
    /** a directive: engine-maintained, seeded to null. */
    Directive = 0,
    /** a factory `() => T`, called once per instance. */
    Factory = 1,
    /** an object/array literal, deep-copied per instance. */
    Clone = 2,
    /** a primitive, shared as-is. */
    Literal = 3,
}

type FieldPlan = { key: string; kind: FieldKind; value: unknown };

/** per-def field plan, so `buildTraitInstance` doesn't re-walk `Object.entries` per instance. */
type DefShape = {
    /** the per-instance work left after cloning `template`: Clone and Factory fields only. */
    plan: FieldPlan[];
    /** one fast-properties prototype of an instance, cloned per instance. */
    template: TraitBase & Record<string, unknown>;
};

const defShapes = new WeakMap<TraitDef, DefShape>();

function shapeFor(def: TraitDef): DefShape {
    const cached = defShapes.get(def);
    if (cached !== undefined) return cached;

    const plan: FieldPlan[] = [];
    for (const key of Object.keys(def.body)) {
        const value = def.body[key];
        let kind: FieldKind;
        if (isDirective(value)) kind = FieldKind.Directive;
        else if (typeof value === 'function') kind = FieldKind.Factory;
        else if (value !== null && typeof value === 'object') kind = FieldKind.Clone;
        else kind = FieldKind.Literal;
        plan.push({ key, kind, value });
    }

    // Successive stores put an object of more than ~16 properties into dictionary
    // mode: 6.6x slower to read and 5.6x larger. Building the shape once and
    // spreading it yields fast properties, and cloning that per instance keeps them.
    const seed: Record<string, unknown> = { _node: null, _def: def, _sync: undefined };
    for (const field of plan) seed[field.key] = field.kind === FieldKind.Literal ? field.value : null;
    const template = { ...seed } as TraitBase & Record<string, unknown>;

    // Literal and Directive fields are already correct in the template, so a
    // clone only has to redo the ones that must not be shared between instances.
    const perInstance = plan.filter((f) => f.kind === FieldKind.Clone || f.kind === FieldKind.Factory);

    const shape: DefShape = { plan: perInstance, template };
    defShapes.set(def, shape);
    return shape;
}

export function buildTraitInstance(def: TraitDef, overrides?: Record<string, unknown>): TraitBase {
    const shape = shapeFor(def);
    const instance = { ...shape.template };

    const plan = shape.plan;
    for (let i = 0; i < plan.length; i++) {
        const field = plan[i]!;
        instance[field.key] =
            field.kind === FieldKind.Factory ? (field.value as Factory<unknown>)() : cloneTraitValue(field.value as object);
    }

    if (overrides) {
        for (const [key, value] of Object.entries(overrides)) {
            // a directive-declared field is maintained by the engine; an
            // override would be silently overwritten by the next resolve.
            if (isDirective(def.body[key])) continue;
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
    // realistic counts < 32 fit a single word) + the byte-diff snapshot array
    // (bytes), indexed by slice.
    if (def.sync.length > 0) {
        instance._sync = {
            dirty: new Uint32Array(Math.ceil(def.sync.length / 32)),
            bytes: new Array(def.sync.length),
            versions: new Float64Array(def.sync.length),
            traitVersion: 0,
        };
    }

    return instance;
}
