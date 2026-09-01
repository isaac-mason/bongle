// ancestor links: "keep the nearest trait at or above me resolved on this
// field, and tell me when it moves".
//
// A link is declared beside a trait, the way `control()` and `sync()` are, and
// the scene tree maintains it: re-resolved whenever the tree changes shape or
// the target trait is added or removed, so a linked field can never hold a
// stale pointer. `TransformTrait._parent` is one of these.
//
// The same `AncestorLink` shape also backs a query's `Up` / `Ancestor` terms,
// which build links whose `apply` writes a match tuple instead of a field. One
// mechanism, two consumers; the walk that maintains them lives in `scene-tree`.
//
// A declared link is global (every scene tree walks it) and permanent, unlike a
// query term which is reaped with its query. Prefer a query term when the
// relationship belongs to the consumer rather than to the trait: `MeshTrait`
// shouldn't import `ModelTrait` to say that meshes are lit in groups.
//
// Leaf module: imports nothing that imports it back, so a trait can declare a
// link at module scope without tripping over a module-init cycle.

import { registry } from '../registry';
import { type Condition, type Oper, Src } from './conditions';
import type { Node } from './scene-tree';
import type { TraitBase, TraitHandle } from './traits';

/**
 * one maintained "nearest trait at or above me" relationship.
 *
 * `traitSlot` is both what gets resolved and where the walk prunes: below a
 * node bearing it, the answer is that node and cannot have been changed by
 * anything above.
 */
export type AncestorLink = {
    traitSlot: number;
    /** `Up` counts the node itself; `Ancestor` starts at the parent. */
    inclusive: boolean;
    /**
     * write the resolved value wherever this link keeps it. Called for every
     * node the walk visits; implementations that only care about some of them
     * (a query's members, or nodes bearing the owning trait) filter here.
     */
    apply(node: Node, resolved: TraitBase | undefined): void;
};

/** a declared link, as stored on its owning `TraitDef`. */
export type AncestorLinkDef = AncestorLink & { field: string };

/**
 * Flattened view of every declared link, rebuilt when a declaration is added or
 * the trait registry changes shape. The walk reads this per structural
 * mutation, so it has to be a plain array rather than a registry crawl.
 */
let _cache: AncestorLink[] | null = null;
let _cachedRevision = -1;

/** invalidate the flattened view; called on every new declaration. */
function invalidate(): void {
    _cache = null;
}

/** every declared link. Scene trees walk these plus their own query terms. */
export function declaredLinks(): AncestorLink[] {
    // the revision check is the backstop for a trait def being replaced or
    // dropped wholesale (HMR), which doesn't route through `link()`.
    if (_cache === null || _cachedRevision !== registry.traits.revision) {
        const out: AncestorLink[] = [];
        for (const [, def] of registry.traits.byId) {
            for (const l of def.links) out.push(l);
        }
        _cache = out;
        _cachedRevision = registry.traits.revision;
    }
    return _cache;
}

/**
 * Declare that `field` on `owner` holds the trait resolved by `source`, and
 * have the scene tree keep it correct.
 *
 * ```ts
 * link(TransformTrait, '_parent', Ancestor(TransformTrait), {
 *     onRelink: (node) => markAncestryChanged(node),
 * });
 * ```
 *
 * The field must exist on the trait body (this annotates it, the way
 * `control()` annotates a field it exposes) and is always `T | null` — a link
 * has no membership to gate, so there is no required/optional distinction and
 * `Optional(...)` is not accepted. A linked field is derived, so it must never
 * also be `control()`ed or `sync()`ed; persisting or replicating it would
 * fight the maintainer.
 *
 * `onRelink` fires whenever the link was re-resolved for that node, changed or
 * not — which is what `TransformTrait` needs, since a re-point invalidates the
 * subtree's world matrices either way. The old and new values are passed so a
 * consumer that only cares about actual changes can compare them itself;
 * firing only on change would be a different contract needing its own
 * analysis of what transform's dirtying depends on.
 */
export function link<Owner extends TraitHandle, Target extends TraitHandle>(
    owner: Owner,
    field: string,
    source: Condition<Target, Oper.And, Src.Up | Src.Ancestor>,
    opts?: { onRelink?(node: Node, next: TraitBase | null, prev: TraitBase | null): void },
): void {
    const ownerSlot = owner._slot;
    const traitSlot = source.trait._slot;
    if (ownerSlot === undefined || traitSlot === undefined) return;

    const onRelink = opts?.onRelink;
    const entry: AncestorLinkDef = {
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
            onRelink?.(node, next, prev);
        },
    };

    const def = owner._def;
    if (def.links.some((l) => l.field === field)) {
        console.warn(`[bongle] trait '${def.id}' already links field '${field}'; ignoring re-register`);
        return;
    }
    def.links.push(entry);
    invalidate();
}
