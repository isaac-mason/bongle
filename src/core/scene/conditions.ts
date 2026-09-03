// query conditions: the terms a query is built from.
//
// A term has two orthogonal axes: an operator (what it does to a match) and a
// source (where it looks). `With(T)` is and/self, `Not(T)` is not/self,
// `Up(T)` and `Ancestor(T)` are and/hierarchy, and `Optional(...)` flips any
// of the non-Not ones to non-filtering.
//
// This is a leaf module on purpose. `scene-tree` and the builtin traits both
// need these constructors, and both import each other, so anything they share
// has to sit below both or a module-init cycle can leave an enum undefined at
// the moment a trait body declares a resolution.

import type { TraitHandle } from './traits';

/**
 * what a term does to the match. orthogonal to `Src`, which says where the
 * term looks. `Optional` neither requires nor excludes: the node matches
 * either way and the tuple slot is `null` when nothing resolved.
 */
export enum Oper {
    And,
    Not,
    Optional,
}

/**
 * where a term looks for its trait.
 *
 * `Self` is the node itself. `Up` is the node or, failing that, its nearest
 * ancestor bearing the trait (so a node carrying both `MeshTrait` and
 * `ModelTrait` resolves to its own). `Ancestor` is strictly upward: parent,
 * then parents of parents, never the node itself.
 *
 * Hierarchy-sourced terms are re-resolved when the tree is restructured or
 * the target trait is added/removed, so a match never holds a stale pointer.
 */
export enum Src {
    Self,
    Up,
    Ancestor,
}

export type Condition<T extends TraitHandle = TraitHandle, O extends Oper = Oper, S extends Src = Src> = {
    trait: T;
    oper: O;
    src: S;
};

/** node has `t`. a bare trait handle in a query arg list means this. */
export function With<T extends TraitHandle>(t: T): Condition<T, Oper.And, Src.Self> {
    return { trait: t, oper: Oper.And, src: Src.Self };
}

/** node does not have `t`. contributes no tuple slot. */
export function Not<T extends TraitHandle>(t: T): Condition<T, Oper.Not, Src.Self> {
    return { trait: t, oper: Oper.Not, src: Src.Self };
}

/** `t` on this node, else on its nearest ancestor bearing it. */
export function Up<T extends TraitHandle>(t: T): Condition<T, Oper.And, Src.Up> {
    return { trait: t, oper: Oper.And, src: Src.Up };
}

/** `t` strictly above this node: parent, then parents of parents. */
export function Ancestor<T extends TraitHandle>(t: T): Condition<T, Oper.And, Src.Ancestor> {
    return { trait: t, oper: Oper.And, src: Src.Ancestor };
}

/**
 * make a term non-filtering: the node matches whether or not the trait
 * resolves, and its tuple slot is `null` when it doesn't. wraps `With`, `Up`
 * or `Ancestor`. `Optional(Not(...))` is meaningless and doesn't typecheck.
 */
export function Optional<T extends TraitHandle>(t: T): Condition<T, Oper.Optional, Src.Self>;
export function Optional<T extends TraitHandle, S extends Src>(c: Condition<T, Oper.And, S>): Condition<T, Oper.Optional, S>;
export function Optional(c: TraitHandle | Condition<any, any, any>): Condition<any, Oper.Optional, any> {
    // bare handle sugars to `Optional(With(t))`, same as a bare handle in a
    // query arg list sugars to `With(t)`.
    if ('_slot' in c) return { trait: c, oper: Oper.Optional, src: Src.Self };
    return { trait: c.trait, oper: Oper.Optional, src: c.src };
}

export type ConditionArgs = TraitHandle | Condition<any, any, any>;

/** query-hash tags, indexed by `Oper` and `Src`. */
export const OPER_TAG = ['W', 'N', 'O'];
export const SRC_TAG = ['', 'U', 'A'];

export type ConditionArgsToConditions<Args extends ConditionArgs[]> = {
    [K in keyof Args]: Args[K] extends TraitHandle
        ? Condition<Args[K], Oper.And, Src.Self>
        : Args[K] extends Condition<any, any, any>
          ? Args[K]
          : never;
};

/**
 * extract trait instance types from the terms that carry values: `Not` terms
 * contribute nothing, `Optional` terms contribute `T | null`, everything else
 * contributes `T`.
 */
export type ExtractTraitsFromConditions<Conditions extends Array<Condition<any, any, any>>> = Conditions extends [
    infer First,
    ...infer Rest extends Array<Condition<any, any, any>>,
]
    ? First extends Condition<TraitHandle<infer T>, infer O, any>
        ? [O] extends [Oper.Not]
            ? ExtractTraitsFromConditions<Rest>
            : [O] extends [Oper.Optional]
              ? [T | null, ...ExtractTraitsFromConditions<Rest>]
              : [T, ...ExtractTraitsFromConditions<Rest>]
        : ExtractTraitsFromConditions<Rest>
    : [];
