export type Prop<T> = {
    get(): T;
    /** absent ⇒ read-only (a monitor/graph source). */
    set?(value: T): void;
    /** present ⇒ reactive; the control subscribes instead of polling. */
    subscribe?(onChange: () => void): () => void;
    /** display name, used as the default control label. filled in by the obj+key adapter. */
    name?: string;
};

// Vec3/Quat are tuples ([x,y,z] / [x,y,z,w]); widen to number[] to bind array-typed shape controls.
type Widen<T> = T extends readonly number[] ? number[] : T;

/** bind to `object[key]` (read/write). the key becomes the default label. */
export function prop<O, K extends keyof O>(object: O, key: K): Prop<Widen<O[K]>>;
/** bind via a get/set lens for nested, derived, or unit-converted state. */
export function prop<T>(get: () => T, set: (value: T) => void): Prop<T>;
/** bind a getter only, read-only, for monitors/graphs. */
export function prop<T>(get: () => T): Prop<T>;
export function prop(a: unknown, b?: unknown): Prop<unknown> {
    if (typeof a === 'function') {
        return { get: a as () => unknown, set: b as ((value: unknown) => void) | undefined };
    }
    const object = a as Record<string, unknown>;
    const key = b as string;
    return {
        get: () => object[key],
        set: (value) => {
            object[key] = value;
        },
        name: key,
    };
}

/** wrap a getter as a read-only prop with an explicit name (handy for monitors). */
export function watch<T>(name: string, get: () => T): Prop<T> {
    return { get, name };
}
