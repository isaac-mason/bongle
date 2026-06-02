import type { ConditionArgs } from '../nodes';

export type BooleanSchema = {
    type: 'boolean';
};

export type StringSchema = {
    type: 'string';
};

export type NumberSchema = {
    type: 'number';
    min?: number;
    max?: number;
    step?: number;
};

export type Vector2Schema = {
    type: 'vector2';
};

export type Vector3Schema = {
    type: 'vector3';
};

export type Vector4Schema = {
    type: 'vector4';
};

export type QuaternionSchema = {
    type: 'quaternion';
};

export type QuaternionOptions = {
    /** if true, show as euler XYZ angles instead of quaternion XYZW */
    euler?: boolean;
};

export type ListSchema = {
    type: 'list';
    of: Schema;
    length?: number;
};

export type TupleSchema = {
    type: 'tuple';
    of: Schema[];
};

export type ObjectSchema = {
    type: 'object';
    fields: Record<string, Schema>;
};

export type RecordSchema = {
    type: 'record';
    field: Schema;
};

export type LiteralSchema = {
    type: 'literal';
    value: SchemaType<PrimitiveSchema>;
};

export type EnumOption = string | number | { label: string; value: string | number };

/** extract the raw value from a plain or labeled enum option */
export const enumValue = (opt: EnumOption): string | number => (typeof opt === 'object' ? opt.value : opt);

/** extract the display label from a plain or labeled enum option */
export const enumLabel = (opt: EnumOption): string => (typeof opt === 'object' ? opt.label : String(opt));

export type EnumerationSchema = {
    type: 'enumeration';
    values: readonly EnumOption[];
};

export type NullableSchema = {
    type: 'nullable';
    of: Schema;
};

export type OptionalSchema = {
    type: 'optional';
    of: Schema;
};

export type NullishSchema = {
    type: 'nullish';
    of: Schema;
};

export type MeshSchema = {
    type: 'mesh';
};

export type NodeRefSchema = {
    type: 'node';
    requires?: ConditionArgs[];
};

export type PrefabRefSchema = {
    type: 'prefab';
};

export type BlockRefSchema = {
    type: 'block';
};

export type UnionSchema = {
    type: 'union';
    key: string;
    variants: Array<ObjectSchema>;
};

export type PrimitiveSchema =
    | BooleanSchema
    | StringSchema
    | NumberSchema
    | Vector2Schema
    | Vector3Schema
    | Vector4Schema
    | QuaternionSchema;

export type Schema =
    | PrimitiveSchema
    | ListSchema
    | TupleSchema
    | ObjectSchema
    | RecordSchema
    | UnionSchema
    | LiteralSchema
    | EnumerationSchema
    | NullableSchema
    | OptionalSchema
    | NullishSchema
    | MeshSchema
    | NodeRefSchema
    | PrefabRefSchema
    | BlockRefSchema;

type RepeatTypeMap<T> = {
    0: [];
    1: [T];
    2: [T, T];
    3: [T, T, T];
    4: [T, T, T, T];
    5: [T, T, T, T, T];
    6: [T, T, T, T, T, T];
    7: [T, T, T, T, T, T, T];
    8: [T, T, T, T, T, T, T, T];
    9: [T, T, T, T, T, T, T, T, T];
    10: [T, T, T, T, T, T, T, T, T, T];
    11: [T, T, T, T, T, T, T, T, T, T, T];
    12: [T, T, T, T, T, T, T, T, T, T, T, T];
    13: [T, T, T, T, T, T, T, T, T, T, T, T, T];
    14: [T, T, T, T, T, T, T, T, T, T, T, T, T, T];
    15: [T, T, T, T, T, T, T, T, T, T, T, T, T, T, T];
    16: [T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T];
};

type RepeatType<T, N extends number> = N extends keyof RepeatTypeMap<T> ? RepeatTypeMap<T>[N] : T[];

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type NextDepth = {
    0: 0;
    1: 0;
    2: 1;
    3: 2;
    4: 3;
    5: 4;
    6: 5;
    7: 6;
    8: 7;
    9: 8;
    10: 9;
    11: 10;
    12: 11;
    13: 12;
    14: 13;
    15: 14;
};

type DecrementDepth<N extends keyof NextDepth> = N extends keyof NextDepth ? NextDepth[N] : 0;

// biome-ignore format: readability
export type SchemaType<S extends Schema, Depth extends keyof NextDepth = 15> =
    Depth extends 0 ? any :
    S extends BooleanSchema ? boolean :
    S extends StringSchema ? string :
    S extends NumberSchema ? number :
    S extends MeshSchema ? { readonly modelId: string; readonly meshName: string } :
    S extends Vector2Schema ? [x: number, y: number] :
    S extends Vector3Schema ? [x: number, y: number, z: number] :
    S extends Vector4Schema ? [x: number, y: number, z: number, w: number] :
    S extends QuaternionSchema ? [x: number, y: number, z: number, w: number] :
    S extends ListSchema ? (
        S['length'] extends number
            ? RepeatType<SchemaType<S['of'], DecrementDepth<Depth>>, S['length']>
            : SchemaType<S['of'], DecrementDepth<Depth>>[]
    ) :
    S extends TupleSchema ? (
        S['of'] extends [...infer El]
            ? { [K in keyof El]: El[K] extends Schema ? SchemaType<El[K], DecrementDepth<Depth>> : never }
            : never 
    ) :
    S extends ObjectSchema ? Simplify<{ [K in keyof S['fields']]: SchemaType<S['fields'][K], DecrementDepth<Depth>> }> :
    S extends RecordSchema ? Record<string, SchemaType<S['field'], DecrementDepth<Depth>>> :
    S extends LiteralSchema ? S['value'] :
    S extends EnumerationSchema ? (S['values'][number] extends { value: infer V } ? V : S['values'][number]) :
    S extends NullableSchema ? SchemaType<S['of'], DecrementDepth<Depth>> | null :
    S extends OptionalSchema ? SchemaType<S['of'], DecrementDepth<Depth>> | undefined :
    S extends NullishSchema ? SchemaType<S['of'], DecrementDepth<Depth>> | null | undefined :
    S extends UnionSchema ? SchemaType<S['variants'][number], DecrementDepth<Depth>> :
    S extends NodeRefSchema ? string :
    S extends PrefabRefSchema ? string :
    S extends BlockRefSchema ? string :
    never;

/* lightweight helpers that just return objects */

export const boolean = (): { type: 'boolean' } => ({ type: 'boolean' });

export const string = (): { type: 'string' } => ({ type: 'string' });

export const number = (opts?: { min?: number; max?: number; step?: number }): NumberSchema => ({
    type: 'number',
    ...opts,
});

export const vec2 = (): Vector2Schema => ({ type: 'vector2' });

export const vec3 = (): Vector3Schema => ({ type: 'vector3' });

export const vec4 = (): Vector4Schema => ({ type: 'vector4' });

export const quaternion = (): QuaternionSchema => ({ type: 'quaternion' });

export function list<T extends Schema>(of: T): { type: 'list'; of: T };
export function list<T extends Schema, L extends number>(of: T, length: L): { type: 'list'; of: T; length: L };
export function list<T extends Schema, L extends number>(of: T, length?: L) {
    return (length === undefined ? { type: 'list', of } : { type: 'list', of, length }) as any;
}

export const tuple = <T extends Schema[]>(of: [...T]): { type: 'tuple'; of: [...T] } => ({
    type: 'tuple',
    of,
});

export const object = <F extends Record<string, Schema>>(fields: F): { type: 'object'; fields: F } => ({
    type: 'object',
    fields,
});

export const record = <F extends Schema>(field: F): { type: 'record'; field: F } => ({
    type: 'record',
    field,
});

export const literal = <S extends PrimitiveSchema, V extends SchemaType<S>>(
    value: V,
): {
    type: 'literal';
    value: V;
} => {
    return { type: 'literal', value };
};

export const enumeration = <V extends EnumOption[]>(values: [...V]): { type: 'enumeration'; values: [...V] } => {
    return { type: 'enumeration', values };
};

export const nullable = <S extends Schema>(of: S): { type: 'nullable'; of: S } => ({ type: 'nullable', of });

export const optional = <S extends Schema>(of: S): { type: 'optional'; of: S } => ({ type: 'optional', of });

export const nullish = <S extends Schema>(of: S): { type: 'nullish'; of: S } => ({ type: 'nullish', of });

export const union = <K extends string, V extends ObjectSchema[]>(
    key: K,
    variants: [...V],
): { type: 'union'; key: K; variants: [...V] } => ({
    type: 'union',
    key,
    variants,
});

export const mesh = (): MeshSchema => ({ type: 'mesh' });

export const node = (opts?: { requires?: ConditionArgs[] }): NodeRefSchema =>
    opts?.requires ? { type: 'node', requires: opts.requires } : { type: 'node' };

export const prefab = (): PrefabRefSchema => ({ type: 'prefab' });

export const block = (): BlockRefSchema => ({ type: 'block' });
