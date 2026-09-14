import type { Schema as PackcatSchema } from 'packcat';
import * as p from 'packcat';
import type { Schema as PropSchema } from './prop/prop';
import { enumValue } from './prop/prop';
import type { Node } from './scene-tree';
import { clearSyncDirty, type SyncDef, type TraitBase, type TraitDef, type TraitHandle } from './traits';

/** Pack/apply closures for a single SyncDef on a trait. Positional: the array index matches the SyncDef's index in `def.syncDefs`, which is also its wire key in the BinaryField envelope. */
export type SyncCodec = {
    /** Packs the sync slice from a trait instance to bytes. `node` is only read (id/name) on error, to enrich the log. */
    pack(instance: TraitBase, node: Node): Uint8Array;
    /** Zero-alloc path for per-tick diffing: packs into a caller-provided buffer. Returns bytes written (>0), 0 when there's nothing to pack, or the negated required size (<0) when `u8` was too small, so the caller can grow to exactly `-n` and retry once. */
    packInto(instance: TraitBase, node: Node, u8: Uint8Array, offset: number): number;
    apply(data: Uint8Array, instance: TraitBase): void;
};

/** Positional array of per-sync codecs, parallel to `def.syncDefs`. Null when the trait has no syncs registered. */
const syncCodecs = new WeakMap<TraitDef, { codecs: SyncCodec[] | null }>();

export function getSyncCodecs(handle: TraitHandle): SyncCodec[] | null {
    // Memoised on def identity, so a re-declaration rebuilds these with nothing to invalidate. Boxed since the built value is legitimately `null` for a trait with no syncs.
    const def = handle.def;
    let entry = syncCodecs.get(def);
    if (entry === undefined) {
        entry = { codecs: buildSyncCodecs(def) };
        syncCodecs.set(def, entry);
    }
    return entry.codecs;
}

function buildSyncCodecs(def: TraitDef): SyncCodec[] | null {
    if (def.sync.length === 0) return null;
    const out: SyncCodec[] = [];
    for (let i = 0; i < def.sync.length; i++) {
        out.push(buildOneSyncCodec(i, def.sync[i]));
    }
    return out;
}

function buildOneSyncCodec(idx: number, syncDef: SyncDef): SyncCodec {
    const label = `${syncDef.traitId}.${syncDef.syncId}`;
    let serdes: ReturnType<typeof p.build> | null = null;
    try {
        serdes = p.build(syncDef.schema as PackcatSchema);
    } catch (e) {
        console.error(`[bongle] failed to build sync serdes for '${label}':`, e);
    }
    if (!serdes) {
        return {
            pack: () => new Uint8Array(0),
            packInto: () => 0,
            apply: () => {},
        };
    }
    const s = serdes;
    return {
        pack(instance, node) {
            let value: unknown;
            try {
                value = syncDef.pack(instance);
                return s.pack(value);
            } catch (e) {
                console.error(
                    `[bongle] failed to pack sync '${label}' @node#${node.id}${node.name ? `(${node.name})` : ''} (value=${describeValue(value)}, schema=${describeSchema(syncDef.schema)}):`,
                    e,
                );
                return new Uint8Array(0);
            }
        },
        packInto(instance, node, u8, offset) {
            let value: unknown;
            try {
                value = syncDef.pack(instance);
                const res = s.packInto(value, u8, offset);
                return res.ok ? res.size : -res.size;
            } catch (e) {
                console.error(
                    `[bongle] failed to pack sync '${label}' @node#${node.id}${node.name ? `(${node.name})` : ''} (value=${describeValue(value)}, schema=${describeSchema(syncDef.schema)}):`,
                    e,
                );
                return 0;
            }
        },
        apply(data, instance) {
            try {
                syncDef.unpack(s.unpack(data), instance);
            } catch (e) {
                console.error(`[bongle] failed to apply sync '${label}' (bytes=${data.byteLength}):`, e);
            }
            // An applied write is not a local change to re-emit. unpack callbacks may call
            // back into sync.dirty() (e.g. transform.unpack -> markTransformDirty ->
            // poseSync.dirty), which would otherwise echo this field back to the sender.
            clearSyncDirty(instance, idx);
        },
    };
}

/** Pack/unpack/apply closures for a single ControlDef on a trait. Positional: the array index matches the control's index in `def.controls`, which is also its wire key in the persisted format. */
export type ControlCodec = {
    /** Packs the control's current value from an instance to bytes. `node` is only read (id/name) on error, to enrich the log. */
    pack(instance: TraitBase, node: Node): Uint8Array;
    /** Unpacks bytes to a value, used when constructing a fresh instance via props. */
    unpack(data: Uint8Array): unknown;
    apply(data: Uint8Array, instance: TraitBase): void;
};

/** Positional array of per-control codecs, parallel to `def.controls`. Null when the trait has no controls registered. */
const controlCodecs = new WeakMap<TraitDef, { codecs: ControlCodec[] | null }>();

export function getControlCodecs(handle: TraitHandle): ControlCodec[] | null {
    const def = handle.def;
    let entry = controlCodecs.get(def);
    if (entry === undefined) {
        entry = { codecs: buildControlCodecs(def) };
        controlCodecs.set(def, entry);
    }
    return entry.codecs;
}

function buildControlCodecs(def: TraitDef): ControlCodec[] | null {
    if (def.controls.length === 0) return null;
    const out: ControlCodec[] = [];
    for (let i = 0; i < def.controls.length; i++) {
        out.push(buildOneControlCodec(def.controls[i]));
    }
    return out;
}

function buildOneControlCodec(reg: TraitDef['controls'][number]): ControlCodec {
    const label = `${reg.traitId}.${reg.controlId}`;
    const packcatSchema = propToPack(reg.schema);
    let serdes: ReturnType<typeof p.build> | null = null;
    if (packcatSchema) {
        try {
            serdes = p.build(packcatSchema);
        } catch (e) {
            console.error(`[bongle] failed to build control serdes for '${label}':`, e);
        }
    } else {
        console.error(`[bongle] failed to convert prop schema for control '${label}'`);
    }
    if (!serdes) {
        return {
            pack: () => new Uint8Array(0),
            unpack: () => undefined,
            apply: () => {},
        };
    }
    const s = serdes;
    return {
        pack(instance, node) {
            let value: unknown;
            try {
                value = reg.get(instance);
                return s.pack(value);
            } catch (e) {
                console.error(
                    `[bongle] failed to pack control '${label}' @node#${node.id}${node.name ? `(${node.name})` : ''} (value=${describeValue(value)}):`,
                    e,
                );
                return new Uint8Array(0);
            }
        },
        unpack(data) {
            try {
                return s.unpack(data);
            } catch (e) {
                console.error(`[bongle] failed to unpack control '${label}':`, e);
                return undefined;
            }
        },
        apply(data, instance) {
            try {
                reg.set(instance, s.unpack(data));
            } catch (e) {
                console.error(`[bongle] failed to apply control '${label}':`, e);
            }
        },
    };
}

function describeValue(v: unknown): string {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v === 'string') return `string(len=${v.length})${v.length < 40 ? ` '${v}'` : ''}`;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return `array(len=${v.length})`;
    if (typeof v === 'object') {
        try {
            return `object(keys=${Object.keys(v as object).join(',')})`;
        } catch {
            return 'object';
        }
    }
    return typeof v;
}

function describeSchema(s: unknown): string {
    if (s && typeof s === 'object' && 'type' in s) {
        const t = (s as { type: unknown }).type;
        return typeof t === 'string' ? t : 'unknown';
    }
    return 'unknown';
}

/** Converts a prop schema (prop.number, prop.vec3, etc.) to a packcat schema for binary serialization. Returns null for types that can't be cleanly mapped. */
export function propToPack(schema: PropSchema): PackcatSchema | null {
    switch (schema.type) {
        case 'boolean':
            return p.boolean();
        case 'string':
            return p.string();
        case 'number':
            return p.float64();
        case 'vector2':
            return p.list(p.float64(), 2);
        case 'vector3':
            return p.list(p.float64(), 3);
        case 'vector4':
        case 'quaternion':
            return p.list(p.float64(), 4);
        case 'list': {
            const inner = propToPack(schema.of);
            if (!inner) return null;
            return schema.length !== undefined ? p.list(inner, schema.length) : p.list(inner);
        }
        case 'tuple': {
            const elements = schema.of.map(propToPack);
            if (elements.some((e) => e === null)) return null;
            return p.tuple(elements as PackcatSchema[]);
        }
        case 'object': {
            const fields: Record<string, PackcatSchema> = {};
            for (const [k, v] of Object.entries(schema.fields)) {
                const converted = propToPack(v);
                if (!converted) return null;
                fields[k] = converted;
            }
            return p.object(fields);
        }
        case 'record': {
            const fieldSchema = propToPack(schema.field);
            if (!fieldSchema) return null;
            return p.record(fieldSchema);
        }
        case 'literal':
            return p.literal(schema.value as string | number | boolean);
        case 'enumeration':
            return p.enumeration(schema.values.map(enumValue) as (string | number)[]);
        case 'nullable': {
            const of = propToPack(schema.of);
            if (!of) return null;
            return p.nullable(of);
        }
        case 'optional': {
            const of = propToPack(schema.of);
            if (!of) return null;
            return p.optional(of);
        }
        case 'nullish': {
            const of = propToPack(schema.of);
            if (!of) return null;
            return p.nullish(of);
        }
        case 'union': {
            const variants = schema.variants.map((v) => {
                const fields: Record<string, PackcatSchema> = {};
                for (const [k, fv] of Object.entries(v.fields)) {
                    const converted = propToPack(fv);
                    if (!converted) return null;
                    fields[k] = converted;
                }
                return p.object(fields);
            });
            if (variants.some((v) => v === null)) return null;
            return p.union(schema.key, variants as any);
        }
        case 'mesh':
            // Nullable because MeshTrait.meshId defaults to null.
            return p.nullable(
                p.object({
                    modelId: p.string(),
                    meshName: p.string(),
                }),
            );
        case 'prefab':
        case 'block':
            // Refs serialize as bare strings (prefab id / block-key); wrap with nullable() at the schema level if "unset" needs to roundtrip.
            return p.string();
        default:
            return null;
    }
}
