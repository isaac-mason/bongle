export type BooleanSchema = {
    type: 'boolean';
};

export type StringSchema = {
    type: 'string';
};

export type NumberSubtype = 'radius' | 'angle';

export type NumberSchema = {
    type: 'number';
    min?: number;
    max?: number;
    step?: number;
    subtype?: NumberSubtype;
};

export type Vector2Schema = {
    type: 'vector2';
};

export type Vector3Subtype = 'point' | 'direction';

export type Vector3Schema = {
    type: 'vector3';
    subtype?: Vector3Subtype;
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

/** an object with a fixed layout the editor knows: shapes get outlines and handles, a pose frames its sibling fields. */
export type ObjectKind = 'sphere' | 'box3' | 'segment' | 'pose';

export type ObjectSchema = {
    type: 'object';
    fields: Record<string, Schema>;
    kind?: ObjectKind;
    /** 'world' expresses this object's frame absolutely instead of under the node and its enclosing poses. */
    space?: 'local' | 'world';
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

export type PrefabRefSchema = {
    type: 'prefab';
};

export type BlockRefSchema = {
    type: 'block';
};

/** a sprite id. */
export type SpriteRefSchema = {
    type: 'sprite';
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
    | PrefabRefSchema
    | BlockRefSchema
    | SpriteRefSchema;

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

// biome-ignore format: readability
export type SchemaType<S extends Schema> =
    // guard: when S is still the bare `Schema` constraint (nothing inferred yet, e.g. signature help while
    // typing `prefab(`), don't expand the mapping. The full union distributed recursively is a combinatorial
    // blow-up that OOMs the TS worker, so short-circuit to `any`. A concrete inferred schema never matches
    // this and gets its precise type below.
    [Schema] extends [S] ? any :
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
            ? RepeatType<SchemaType<S['of']>, S['length']>
            : SchemaType<S['of']>[]
    ) :
    S extends TupleSchema ? (
        S['of'] extends [...infer El]
            ? { [K in keyof El]: El[K] extends Schema ? SchemaType<El[K]> : never }
            : never
    ) :
    S extends ObjectSchema ? Simplify<{ [K in keyof S['fields']]: SchemaType<S['fields'][K]> }> :
    S extends RecordSchema ? Record<string, SchemaType<S['field']>> :
    S extends LiteralSchema ? S['value'] :
    S extends EnumerationSchema ? (S['values'][number] extends { value: infer V } ? V : S['values'][number]) :
    S extends NullableSchema ? SchemaType<S['of']> | null :
    S extends OptionalSchema ? SchemaType<S['of']> | undefined :
    S extends NullishSchema ? SchemaType<S['of']> | null | undefined :
    S extends UnionSchema ? SchemaType<S['variants'][number]> :
    S extends PrefabRefSchema ? string :
    S extends BlockRefSchema ? string :
    S extends SpriteRefSchema ? string :
    never;

/* lightweight helpers that just return objects */

export const boolean = (): { type: 'boolean' } => ({ type: 'boolean' });

export const string = (): { type: 'string' } => ({ type: 'string' });

export const number = (opts?: { min?: number; max?: number; step?: number }): NumberSchema => ({
    type: 'number',
    ...opts,
});

/** a length from a centre; never negative. */
export const radius = (opts?: {
    max?: number;
    step?: number;
}): { type: 'number'; subtype: 'radius'; min: number; max?: number; step?: number } => ({
    type: 'number',
    subtype: 'radius',
    min: 0,
    ...opts,
});

/** radians. */
export const angle = (opts?: {
    min?: number;
    max?: number;
    step?: number;
}): { type: 'number'; subtype: 'angle'; min?: number; max?: number; step?: number } => ({
    type: 'number',
    subtype: 'angle',
    ...opts,
});

export const vec2 = (): Vector2Schema => ({ type: 'vector2' });

export const vec3 = (): Vector3Schema => ({ type: 'vector3' });

/** a position in the owning node's frame. */
export const point = (): { type: 'vector3'; subtype: 'point' } => ({ type: 'vector3', subtype: 'point' });

/** a unit vector in the owning node's frame. */
export const direction = (): { type: 'vector3'; subtype: 'direction' } => ({ type: 'vector3', subtype: 'direction' });

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

export type ShapeOptions = { space?: 'local' | 'world' };

/** value `{ type: 'sphere', center, radius }`; `center` is in the enclosing frame. */
export const sphere = (
    opts?: ShapeOptions,
): {
    type: 'object';
    kind: 'sphere';
    fields: { type: { type: 'literal'; value: 'sphere' }; center: { type: 'vector3'; subtype: 'point' }; radius: NumberSchema };
    space?: 'local' | 'world';
} => ({
    type: 'object',
    kind: 'sphere',
    fields: { type: literal('sphere'), center: point(), radius: radius() },
    ...opts,
});

/** value `{ type: 'box3', center, halfExtents }`; the box is axis-aligned in the enclosing frame, a pose rotates it. */
export const box3 = (
    opts?: ShapeOptions,
): {
    type: 'object';
    kind: 'box3';
    fields: {
        type: { type: 'literal'; value: 'box3' };
        center: { type: 'vector3'; subtype: 'point' };
        halfExtents: Vector3Schema;
    };
    space?: 'local' | 'world';
} => ({
    type: 'object',
    kind: 'box3',
    fields: { type: literal('box3'), center: point(), halfExtents: vec3() },
    ...opts,
});

/** value `{ type: 'segment', from, to }`; both ends in the enclosing frame. */
export const segment = (
    opts?: ShapeOptions,
): {
    type: 'object';
    kind: 'segment';
    fields: {
        type: { type: 'literal'; value: 'segment' };
        from: { type: 'vector3'; subtype: 'point' };
        to: { type: 'vector3'; subtype: 'point' };
    };
    space?: 'local' | 'world';
} => ({
    type: 'object',
    kind: 'segment',
    fields: { type: literal('segment'), from: point(), to: point() },
    ...opts,
});

/** value `{ position, quaternion }`; an object holding a pose field is framed by it, so its other fields live inside that pose. */
export const pose = (
    opts?: ShapeOptions,
): {
    type: 'object';
    kind: 'pose';
    fields: { position: { type: 'vector3'; subtype: 'point' }; quaternion: QuaternionSchema };
    space?: 'local' | 'world';
} => ({
    type: 'object',
    kind: 'pose',
    fields: { position: point(), quaternion: quaternion() },
    ...opts,
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

export const prefab = (): PrefabRefSchema => ({ type: 'prefab' });

export const block = (): BlockRefSchema => ({ type: 'block' });

export const sprite = (): SpriteRefSchema => ({ type: 'sprite' });
