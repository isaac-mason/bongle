import type { DepKey } from '../capture/dep-graph';
import type { pack } from './pack';
import type { prop } from './prop';
import type { Node } from './scene-tree';
import type { ScriptDef } from './scripts';

/** Trait body: literal values are shared as the default, factories build a fresh value per instance. */
export type TraitBody = Record<string, unknown>;

export type TraitOptions = {
    name?: string;
    /** Default true; false for runtime-only traits. */
    persist?: boolean;
    /** sprite id drawn for the trait in the hierarchy, inspector and markers. */
    icon?: string;
};

type Factory<T> = () => T;

export const SELF_SLOT = -1;

declare const SELF_MARKER: unique symbol;
/** Placeholder for a field referencing this trait's own instance type; TraitInstance substitutes the real type. */
export type Self = TraitBase & { readonly [SELF_MARKER]: true };

/** Stand-in handle for the trait being defined; resolved at registration, must not reach addTrait. */
export const Self = { id: 'bongle.self', slot: SELF_SLOT } as unknown as TraitHandle<Self>;

type ReservedTraitKey = '_node' | '_def' | '_sync';

export type TraitInstance<S extends TraitBody> = TraitBase & {
    [K in keyof S as K extends ReservedTraitKey ? never : K]: ResolveField<S[K], TraitInstance<S>>;
};

type ResolveField<V, TSelf> = V extends Factory<infer R> ? SubstituteSelf<R, TSelf> : SubstituteSelf<V, TSelf>;

// `[Self] extends [V]` checks whether V contains the marker, not whether V is assignable to it.
type SubstituteSelf<V, TSelf> = 0 extends 1 & V ? V : [Self] extends [V] ? ([null] extends [V] ? TSelf | null : TSelf) : V;

type TraitChildStamp<KindIdKey extends string> = { traitId: string } & { [K in KindIdKey]: string };

export type ControlBody<T extends TraitBase = TraitBase, V = unknown> = {
    label?: string;
    schema: prop.Schema;
    get: (instance: T) => V;
    set: (instance: T, value: V) => void;
    category?: string;
    hidden?: boolean;
};

/** Stored ControlDef, body + `{ traitId, controlId }`. */
export type ControlDef<T extends TraitBase = TraitBase, V = unknown> = ControlBody<T, V> & TraitChildStamp<'controlId'>;

/** What counts as a change worth sending: 'diff' (default) fires when the packed bytes differ, 'explicit' only via SyncHandle.dirty(). */
export type DirtyConfig = 'diff' | 'explicit';

/** Max send cadence for a dirty value: 'realtime' (default) sends every dirty tick, `{ hz }` caps the rate and sends the latest value once it elapses. */
export type RateConfig = 'realtime' | { hz: number };

export type SyncBody<T extends TraitBase = TraitBase, S = unknown> = {
    schema: pack.Schema;
    pack: (instance: T) => S;
    unpack: (value: S, instance: T) => void;
    dirty?: DirtyConfig;
    rate?: RateConfig;
    authority?: 'server' | 'owner';
};

/** Stored SyncDef, body + `{ traitId, syncId }`; wire envelope keys by registration index, not syncId. */
export type SyncDef<T extends TraitBase = TraitBase, S = unknown> = SyncBody<T, S> & TraitChildStamp<'syncId'>;

/** Returned by sync() at registration time; dirty(instance) marks it changed without byte-diffing. */
export type SyncHandle<T extends TraitBase = TraitBase> = {
    readonly index: number;
    dirty(instance: T): void;
};

export type TraitSyncState = {
    dirty: Uint32Array;
    /** [i] = last-emitted bytes for slice i. */
    bytes: Array<Uint8Array | undefined>;
    /** [i] = replication version for slice i; f64 so the counter can't wrap an int32. */
    versions: Float64Array;
    traitVersion: number;
};

export type TraitBase = {
    _node: Node;
    _def: TraitDef;
    /** Allocated only when the trait has syncs. */
    _sync?: TraitSyncState;
};

/** Flags sync `idx` as locally dirty so the next diff pass emits it. */
export function setSyncDirty(instance: TraitBase, idx: number): void {
    const s = instance._sync;
    if (!s) return;
    s.dirty[idx >> 5] |= 1 << (idx & 31);
}

/** Clears the dirty flag for sync `idx`; used after a replicated write from the wire is applied. */
export function clearSyncDirty(instance: TraitBase, idx: number): void {
    const s = instance._sync;
    if (!s) return;
    s.dirty[idx >> 5] &= ~(1 << (idx & 31));
}

/** The handle returned by trait(). Used with getTrait, addTrait, hasTrait, query, findAncestor, etc. */
export type TraitHandle<T extends TraitBase = TraitBase> = {
    readonly id: string;
    /** Stable integer identity assigned the first time trait(id, ...) runs; distinct from netIndex. */
    readonly slot: number;
    readonly dependency: DepKey;
    def: TraitDef;
    /** Wire position stamped by reindexRegistry each flush; survives re-declaration. */
    netIndex: number | undefined;

    /** Phantom; carries the instance type for inference, not present at runtime. */
    readonly __type: T;
};

const constructors = new WeakMap<TraitDef, () => TraitBase>();

export function construct(handle: TraitHandle): () => TraitBase {
    const def = handle.def;
    let compiled = constructors.get(def);
    if (compiled === undefined) {
        compiled = compileConstructor(def);
        constructors.set(def, compiled);
    }
    return compiled;
}

// scripts isn't memoised this way: pruneRemovedScript splices def.scripts in place, which a def-identity memo would miss
const controlIndexes = new WeakMap<TraitDef, Map<string, { reg: ControlDef; index: number }>>();
const syncIndexes = new WeakMap<TraitDef, Map<string, { reg: SyncDef; index: number }>>();

/** `controlId` to its registration and slot index, as a view over `def.controls`. */
export function controlsById(handle: TraitHandle): Map<string, { reg: ControlDef; index: number }> {
    const def = handle.def;
    let index = controlIndexes.get(def);
    if (index === undefined) {
        index = indexBy(def.controls, (c) => c.controlId);
        controlIndexes.set(def, index);
    }
    return index;
}

/** `syncId` to its registration and slot index, as a view over `def.sync`. */
export function syncById(handle: TraitHandle): Map<string, { reg: SyncDef; index: number }> {
    const def = handle.def;
    let index = syncIndexes.get(def);
    if (index === undefined) {
        index = indexBy(def.sync, (s) => s.syncId);
        syncIndexes.set(def, index);
    }
    return index;
}

/** `scriptId` to its registration and slot index, over `def.scripts`; built fresh each call. */
export function scriptsById(handle: TraitHandle): Map<string, { reg: ScriptDef; index: number }> {
    return indexBy(handle.def.scripts, (s) => s.scriptId);
}

function indexBy<R>(regs: R[], keyOf: (reg: R) => string): Map<string, { reg: R; index: number }> {
    const out = new Map<string, { reg: R; index: number }>();
    for (let i = 0; i < regs.length; i++) out.set(keyOf(regs[i]!), { reg: regs[i]!, index: i });
    return out;
}

export type TraitType<H extends TraitHandle> = H['__type'];

/** The authored data for one trait; pure data, no back-references. */
export type TraitDef = {
    id: string;
    name: string;
    body: Record<string, unknown>;
    persist: boolean;
    icon: string | null;
    controls: ControlDef[];
    sync: SyncDef[];
    scripts: ScriptDef[];
};

/** Deep-copies a trait value (control values in and out of scene files); the typed-array and structuredClone branches are a safety net for game-defined traits. */
export function cloneTraitValue<T extends object>(value: T): T {
    if (Array.isArray(value)) {
        const length = value.length;
        const out = new Array(length);
        for (let i = 0; i < length; i++) {
            const item = (value as unknown[])[i];
            out[i] = item !== null && typeof item === 'object' ? cloneTraitValue(item as object) : item;
        }
        return out as T;
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        return (value as unknown as Uint8Array).slice() as unknown as T;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
        const source = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(source)) {
            const item = source[key];
            out[key] = item !== null && typeof item === 'object' ? cloneTraitValue(item as object) : item;
        }
        return out as T;
    }
    return structuredClone(value);
}

function primitiveSource(value: unknown): string | null {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    switch (typeof value) {
        case 'boolean':
            return value ? 'true' : 'false';
        // String() renders NaN and +/-Infinity as valid source; only -0 needs help.
        case 'number':
            return Object.is(value, -0) ? '-0' : String(value);
        case 'string':
            return JSON.stringify(value);
        case 'bigint':
            return `${value}n`;
        default:
            return null;
    }
}

function arraySource(value: object): string | null {
    if (!Array.isArray(value)) return null;
    const items: string[] = [];
    for (const item of value) {
        const source = primitiveSource(item);
        if (source === null) return null;
        items.push(source);
    }
    return `[${items.join(',')}]`;
}

/** Compiles a constructor that returns a whole instance as one object literal, keeping it in V8 fast-property mode. */
export function compileConstructor(def: TraitDef): () => TraitBase & Record<string, unknown> {
    const fields: string[] = ['_node: null', '_def: d', '_sync: undefined'];
    const captured: unknown[] = [];

    for (const key of Object.keys(def.body)) {
        const value = def.body[key];
        const name = JSON.stringify(key);

        if (typeof value === 'function') {
            fields.push(`${name}: v[${captured.length}]()`);
            captured.push(value);
        } else if (value !== null && typeof value === 'object') {
            const inline = arraySource(value);
            if (inline !== null) {
                fields.push(`${name}: ${inline}`);
            } else {
                fields.push(`${name}: c(v[${captured.length}])`);
                captured.push(value);
            }
        } else {
            const source = primitiveSource(value);
            if (source !== null) {
                fields.push(`${name}: ${source}`);
            } else {
                fields.push(`${name}: v[${captured.length}]`);
                captured.push(value);
            }
        }
    }

    const build = new Function('d', 'c', 'v', `return () => ({ ${fields.join(', ')} });`) as (
        d: TraitDef,
        c: typeof cloneTraitValue,
        v: unknown[],
    ) => () => TraitBase & Record<string, unknown>;
    return build(def, cloneTraitValue, captured);
}

/** Builds a trait instance from a TraitDef and optional control-keyed override props; override values are taken by reference. */
export function buildTraitInstance(handle: TraitHandle, overrides?: Record<string, unknown>): TraitBase {
    const instance = construct(handle)() as TraitBase & Record<string, unknown>;

    if (overrides) {
        for (const [key, value] of Object.entries(overrides)) {
            // control-backed fields go through reg.set so side effects fire as if the field was edited
            const controlEntry = controlsById(handle).get(key);
            if (controlEntry) {
                controlEntry.reg.set(instance as TraitBase, value);
            } else {
                instance[key] = value;
            }
        }
    }

    if (handle.def.sync.length > 0) {
        instance._sync = {
            dirty: new Uint32Array(Math.ceil(handle.def.sync.length / 32)),
            bytes: new Array(handle.def.sync.length),
            versions: new Float64Array(handle.def.sync.length),
            traitVersion: 0,
        };
    }

    return instance;
}
