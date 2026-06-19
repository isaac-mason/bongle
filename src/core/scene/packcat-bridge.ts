import type { Schema as PackcatSchema } from 'packcat';
import * as p from 'packcat';
import type { Node } from './nodes';
import type { Schema as PropSchema } from './prop/prop';
import { enumValue } from './prop/prop';
import { clearSyncDirty, type SyncDef, type TraitBase, type TraitDef } from './traits';

/* ── per-sync codecs (replication) ── */

/**
 * pack/apply closures for a single SyncDef on a trait. positional —
 * the array index matches the SyncDef's index in `def.syncDefs`, which
 * is also its wire key in the BinaryField envelope.
 */
export type SyncCodec = {
    /** pack the sync slice from a trait instance to bytes. `node` is the
     *  owning node — only read (id/name) on error to enrich the log. */
    pack(instance: TraitBase, node: Node): Uint8Array;
    /** pack into a caller-provided buffer — the zero-alloc path for per-tick
     *  diffing. returns the byte length written (>0), `0` when there's nothing
     *  to pack (no serdes / pack error → caller skips the slice), or the negated
     *  required size (<0) when `u8` was too small — the caller grows to exactly
     *  `-n` and retries once. */
    packInto(instance: TraitBase, node: Node, u8: Uint8Array, offset: number): number;
    /** unpack bytes and apply to an existing instance via syncDef.unpack */
    apply(data: Uint8Array, instance: TraitBase): void;
};

const syncCodecsCache = new WeakMap<TraitDef, SyncCodec[] | null>();

/**
 * positional array of per-sync codecs, parallel to `def.syncDefs`.
 * returns null when the trait has no syncs registered.
 */
export function getSyncCodecs(def: TraitDef): SyncCodec[] | null {
    const cached = syncCodecsCache.get(def);
    if (cached !== undefined) return cached;

    const result = buildSyncCodecs(def);
    syncCodecsCache.set(def, result);
    return result;
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
                // ok → bytes written; too small → negated required size, so the
                // caller can grow to exactly that and retry once.
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
                console.error(
                    `[bongle] failed to apply sync '${label}' (bytes=${data.byteLength}):`,
                    e,
                );
            }
            // an applied (replicated) write is by definition not a local
            // change to re-emit. unpack callbacks may call back into
            // sync.dirty() (e.g. transform.unpack → markTransformDirty →
            // poseSync.dirty), which would otherwise cause the next diff
            // pass to re-bump this field's version and echo it back to the
            // sender. clear the bit so dirty stays purely a local-write hint.
            clearSyncDirty(instance, idx);
        },
    };
}

/* ── per-control codecs (scene-pack persistence) ── */

/**
 * pack/unpack/apply closures for a single ControlDef on a trait.
 * positional — the array index matches the control's index in
 * `def.controls`, which is also its wire key in the persisted format.
 */
export type ControlCodec = {
    /** pack the control's current value from an instance to bytes. `node`
     *  is the owning node — only read (id/name) on error to enrich the log. */
    pack(instance: TraitBase, node: Node): Uint8Array;
    /** unpack bytes to a value (used when constructing a fresh instance via props) */
    unpack(data: Uint8Array): unknown;
    /** unpack and apply to an existing instance via control.set */
    apply(data: Uint8Array, instance: TraitBase): void;
};

const controlCodecsCache = new WeakMap<TraitDef, ControlCodec[] | null>();

/**
 * positional array of per-control codecs, parallel to `def.controls`.
 * returns null when the trait has no controls registered.
 */
export function getControlCodecs(def: TraitDef): ControlCodec[] | null {
    const cached = controlCodecsCache.get(def);
    if (cached !== undefined) return cached;

    const result = buildControlCodecs(def);
    controlCodecsCache.set(def, result);
    return result;
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

/* ── diagnostics ── */

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

/* ── schema conversion: prop.* → packcat ── */

/**
 * convert a prop schema (prop.number, prop.vec3, etc.) to a packcat
 * schema for binary serialization. returns null for types that can't
 * be cleanly mapped (shouldn't happen for well-formed schemas).
 */
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
            // compound { modelId: string, meshName: string }. nullable because
            // MeshTrait.meshId defaults to null.
            return p.nullable(
                p.object({
                    modelId: p.string(),
                    meshName: p.string(),
                }),
            );
        case 'node':
        case 'prefab':
        case 'block':
            // refs serialize as bare strings (UUID / id / block-key). wrap with
            // nullable() at the schema level if "unset" needs to roundtrip.
            return p.string();
        default:
            return null;
    }
}
