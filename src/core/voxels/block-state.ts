/** a boolean property (false=0, true=1). cardinality 2. */
export type BoolPropDef = {
    readonly type: 'bool';
    readonly cardinality: 2;
};

/** an enum property with string literal values. cardinality = values.length. */
export type EnumPropDef<V extends readonly string[]> = {
    readonly type: 'enum';
    readonly values: V;
    readonly cardinality: V['length'];
};

/** an integer range property [min, max] inclusive. cardinality = max - min + 1. */
export type IntPropDef<Min extends number = number, Max extends number = number> = {
    readonly type: 'int';
    readonly min: Min;
    readonly max: Max;
    readonly cardinality: number;
};

export type PropDef = BoolPropDef | EnumPropDef<readonly string[]> | IntPropDef;

/** map from property name to property definition. */
export type PropsDef = { readonly [key: string]: PropDef };

/** boolean property (false=0, true=1). */
export const bool = (): BoolPropDef => ({ type: 'bool', cardinality: 2 }) as const;

/** enum property from string literal values. */
export const enumeration = <const V extends readonly string[]>(values: V): EnumPropDef<V> => {
    if (values.length === 0) {
        throw new Error('bs.enumeration requires at least one value');
    }
    return { type: 'enum', values, cardinality: values.length } as const as EnumPropDef<V>;
};

/** integer range property [min, max] inclusive. */
export const int = <const Min extends number, const Max extends number>(min: Min, max: Max): IntPropDef<Min, Max> => {
    if (max < min) {
        throw new Error(`bs.int: max (${max}) must be >= min (${min})`);
    }
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
        throw new Error('bs.int: min and max must be integers');
    }
    return {
        type: 'int',
        min,
        max,
        cardinality: max - min + 1,
    } as const as IntPropDef<Min, Max>;
};

/** infer the ts type for a single property value. */
export type PropValue<P extends PropDef> = P extends BoolPropDef
    ? boolean
    : P extends EnumPropDef<infer V>
      ? V[number]
      : P extends IntPropDef
        ? number
        : never;

/** infer a full property values object from a props definition. */
export type PropsValues<P extends PropsDef> = {
    readonly [K in keyof P]: PropValue<P[K]>;
};

// ── compiled property (internal) ────────────────────────────────────
//
// for properties [a(card=4), b(card=2), c(card=5)]:
//   strides:     [1, 4, 8]
//   totalStates: 4 * 2 * 5 = 40
//   index = a_idx * 1 + b_idx * 4 + c_idx * 8
//
// property ordering follows Object.keys insertion order.

type CompiledProp = {
    readonly def: PropDef;
    readonly stride: number;
    readonly cardinality: number;
};

// ── encode/decode helpers (property value <-> integer index) ────────

function encodePropValue(def: PropDef, value: boolean | string | number): number {
    switch (def.type) {
        case 'bool':
            return value ? 1 : 0;
        case 'enum': {
            const idx = (def as EnumPropDef<readonly string[]>).values.indexOf(value as string);
            if (idx === -1) {
                throw new Error(
                    `invalid enum value: ${String(value)}, expected one of: ${(def as EnumPropDef<readonly string[]>).values.join(', ')}`,
                );
            }
            return idx;
        }
        case 'int': {
            const v = value as number;
            const intDef = def as IntPropDef;
            if (v < intDef.min || v > intDef.max || !Number.isInteger(v)) {
                throw new Error(`invalid int value: ${v}, expected integer in [${intDef.min}, ${intDef.max}]`);
            }
            return v - intDef.min;
        }
    }
}

function decodePropValue(def: PropDef, index: number): boolean | string | number {
    switch (def.type) {
        case 'bool':
            return index !== 0;
        case 'enum':
            return (def as EnumPropDef<readonly string[]>).values[index]!;
        case 'int':
            return (def as IntPropDef).min + index;
    }
}

export type BlockStateDef<P extends PropsDef = PropsDef> = {
    /** the property definitions. */
    readonly props: P;

    /** total number of states (product of all property cardinalities). */
    readonly totalStates: number;

    /**
     * pack property values into a local state index (0..totalStates-1).
     * all properties must be provided. O(n) where n = property count.
     */
    encode(values: PropsValues<P>): number;

    /**
     * unpack a local state index into property values.
     * O(n) where n = property count.
     */
    decode(index: number): PropsValues<P>;

    /**
     * extract a single property value from a local state index. O(1).
     */
    get<K extends string & keyof P>(index: number, prop: K): PropValue<P[K]>;

    /**
     * return a new local state index with one property changed. O(1).
     */
    with<K extends string & keyof P>(index: number, prop: K, value: PropValue<P[K]>): number;

    /**
     * the stride (place-value multiplier) of a single property, the
     * amount the encoded local index changes when this prop's value
     * advances by 1. for an all-bool schema the strides are 1, 2, 4, 8…
     * (a bitmask); for mixed schemas they're a mixed-radix sequence.
     *
     * use to inline encode in a hot path without allocating a props
     * object: capture each stride at module scope and sum the
     * contributions positionally. O(1).
     *
     * ```ts
     * const N = FenceState.stride('north');
     * const E = FenceState.stride('east');
     * // hot path:
     * const localIdx = (north ? N : 0) + (east ? E : 0) + ...;
     * ```
     */
    stride<K extends string & keyof P>(prop: K): number;
};

/**
 * create a block state schema. self-contained object with encode/decode
 * operations on local state indices (0..totalStates-1).
 *
 * ```ts
 * import * as bs from './block-states';
 *
 * const LogStates = bs.create({
 *     axis: bs.enumeration(['x', 'y', 'z'] as const),
 * });
 *
 * LogStates.encode({ axis: 'y' }); // → 1
 * LogStates.decode(1);             // → { axis: 'y' }
 * LogStates.get(2, 'axis');        // → 'z'
 * LogStates.with(0, 'axis', 'z');  // → 2
 * ```
 */
export function create<const P extends PropsDef>(props: P): BlockStateDef<P> {
    // compile strides
    const propNames = Object.keys(props);
    const compiled: { [name: string]: CompiledProp } = {};

    let stride = 1;
    for (const name of propNames) {
        const def = props[name]!;
        compiled[name] = { def, stride, cardinality: def.cardinality };
        stride *= def.cardinality;
    }

    const totalStates = stride; // 1 if no props

    function resolveCompiled(prop: string): CompiledProp {
        const cp = compiled[prop];
        if (!cp) throw new Error(`unknown property '${prop}'`);
        return cp;
    }

    return {
        props,
        totalStates,

        encode(values) {
            let index = 0;
            for (const name of propNames) {
                const cp = compiled[name]!;
                const value = (values as Record<string, unknown>)[name];
                if (value === undefined) {
                    throw new Error(`missing property '${name}'`);
                }
                index += encodePropValue(cp.def, value as boolean | string | number) * cp.stride;
            }
            return index;
        },

        decode(index) {
            const result: Record<string, unknown> = {};
            let remaining = index;
            for (const name of propNames) {
                const cp = compiled[name]!;
                const propIndex = remaining % cp.cardinality;
                remaining = (remaining - propIndex) / cp.cardinality;
                result[name] = decodePropValue(cp.def, propIndex);
            }
            return result as PropsValues<P>;
        },

        get(index, prop) {
            const cp = resolveCompiled(prop);
            const propIndex = Math.floor(index / cp.stride) % cp.cardinality;
            return decodePropValue(cp.def, propIndex) as PropValue<P[typeof prop]>;
        },

        with(index, prop, value) {
            const cp = resolveCompiled(prop);
            const currentPropIndex = Math.floor(index / cp.stride) % cp.cardinality;
            const newPropIndex = encodePropValue(cp.def, value as boolean | string | number);
            return index - currentPropIndex * cp.stride + newPropIndex * cp.stride;
        },

        stride(prop) {
            return resolveCompiled(prop).stride;
        },
    };
}
