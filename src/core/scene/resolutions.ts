// nearest-trait resolutions: "which trait at or above me answers this, and
// keep it current".
//
// A resolution is declared in a trait body with `my()`, the way `control()` and
// `sync()` annotate a trait, and the scene tree maintains it: re-resolved
// whenever the tree changes shape or the target trait is added or removed, so
// the field can never hold a stale pointer. `TransformTrait._parent` is one.
//
// The same `Resolution` shape also backs a query's `Up` / `Ancestor` terms,
// whose `apply` writes a match tuple instead of a field. One mechanism, two
// consumers; the walk that maintains them lives in `scene-tree`.
//
// A declared resolution is global (every scene tree walks it) and permanent,
// unlike a query term which is reaped with its query. Prefer a query term when
// the relationship belongs to the consumer rather than to the trait:
// `MeshTrait` shouldn't import `ModelTrait` to say that meshes are lit in
// groups. Prefer `my()` when the reader pulls from arbitrary call sites rather
// than iterating — which is why transform uses it and the renderers don't.
//
// Leaf module: imports nothing that imports it back, so a trait body can
// declare a resolution at module scope without a module-init cycle.

import { registry } from '../registry';
import { type Condition, type Oper, Src } from './conditions';
import type { Node } from './scene-tree';
import { $directive, type Directive, SELF_SLOT, type TraitBase, type TraitHandle, type TraitType } from './traits';

/**
 * one maintained "nearest trait at or above me" relationship.
 *
 * `traitSlot` is both what gets resolved and where the walk prunes: below a
 * node bearing it, the answer is that node and cannot have been changed by
 * anything above.
 */
export type Resolution = {
    traitSlot: number;
    /** `Up` counts the node itself; `Ancestor` starts at the parent. */
    inclusive: boolean;
    /**
     * write the resolved value wherever this resolution keeps it. Called for every
     * node the walk visits; implementations that only care about some of them
     * (a query's members, or nodes bearing the owning trait) filter here.
     */
    apply(node: Node, resolved: TraitBase | undefined): void;
};

/** a declared resolution, as stored on its owning `TraitDef`. */
export type ResolutionDef = Resolution & { field: string };

/**
 * Flattened view of every declared resolution, rebuilt when a declaration is added or
 * the trait registry changes shape. The walk reads this per structural
 * mutation, so it has to be a plain array rather than a registry crawl.
 */
let _cache: Resolution[] | null = null;
let _cachedRevision = -1;

/** every declared resolution. Scene trees walk these plus their own query terms. */
export function declaredResolutions(): Resolution[] {
    // `trait()` registers directives, so a new or re-evaluated trait def bumps
    // the registry revision — that is the only way the set can change.
    if (_cache === null || _cachedRevision !== registry.traits.revision) {
        const out: Resolution[] = [];
        for (const [, def] of registry.traits.byId) {
            for (const l of def.resolutions) out.push(l);
        }
        _cache = out;
        _cachedRevision = registry.traits.revision;
    }
    return _cache;
}

/**
 * Declare that this field holds the trait resolved by `source`, and have the
 * scene tree keep it correct. Used as a trait-body value — a *directive*, not
 * a default:
 *
 * ```ts
 * export const TransformTrait = trait('transform', {
 *     position: () => vec3.create(),
 *     parent: my(Ancestor(Self), { onResolve: (node) => markAncestryChanged(node) }),
 * });
 * ```
 *
 * The field is always `T | null` — a resolution has no membership to gate, so there
 * is no required/optional distinction and `Optional(...)` is not accepted. It
 * is derived, so it is excluded from `addTrait` props and must never also be
 * `control()`ed or `sync()`ed; persisting or replicating it would fight the
 * maintainer.
 *
 * `onResolve` fires whenever the resolution ran for that node, changed or
 * not — which is what `TransformTrait` needs, since a re-point invalidates the
 * subtree's world matrices either way. The old and new values are passed so a
 * consumer that only cares about actual changes can compare them itself.
 */
export function my<T extends TraitHandle>(
    source: Condition<T, Oper.And, Src.Up | Src.Ancestor>,
    opts?: { onResolve?(node: Node, next: TraitBase | null, prev: TraitBase | null): void },
): Directive<TraitType<T> | null> {
    return { [$directive]: 'resolution', source, opts } as unknown as Directive<TraitType<T> | null>;
}

/**
 * Build the `Resolution` a `my()` directive describes. Called by `trait()`
 * for each directive in a body; `ownerSlot` is the trait being defined, which
 * is also what `Self` resolves to.
 */
export function buildResolution(ownerSlot: number, field: string, directive: Directive<unknown>): ResolutionDef | null {
    const source = directive.source as Condition<TraitHandle, Oper.And, Src>;
    const declared = source.trait._slot;
    if (declared === undefined) return null;
    // `Self` carries a sentinel slot; a self-referential resolution targets the
    // trait currently being defined.
    const traitSlot = declared === SELF_SLOT ? ownerSlot : declared;
    const onResolve = (directive.opts as { onResolve?: (n: Node, a: TraitBase | null, b: TraitBase | null) => void } | undefined)
        ?.onResolve;

    return {
        field,
        traitSlot,
        inclusive: source.src === Src.Up,
        apply(node, resolved) {
            const instance = node._traits.get(ownerSlot) as Record<string, unknown> | undefined;
            // the walk visits every node on its way down; only nodes bearing the
            // owning trait have a field to write.
            if (instance === undefined) return;
            const next = (resolved ?? null) as TraitBase | null;
            const prev = (instance[field] ?? null) as TraitBase | null;
            instance[field] = next;
            onResolve?.(node, next, prev);
        },
    };
}
