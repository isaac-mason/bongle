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

import { fileResolution, registry } from '../registry';
import { type Condition, type Oper, Src } from './conditions';
import type { Node } from './scene-tree';
import { SELF_SLOT, type TraitBase, type TraitHandle } from './traits';

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
    /** the trait whose instances hold the destination. A subtree bearing none of them has
     *  nowhere to write, so the whole descent can be skipped. `-1` for a query term, whose
     *  destinations are its members rather than one trait. */
    ownerSlot: number;
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
 * Declare that a trait field holds the nearest trait matching `condition`, and have the scene tree
 * keep it correct as the hierarchy changes. The trait's own annotation, alongside
 * `control()` and `sync()` — the body stays plain data.
 *
 * ```ts
 * context(TransformTrait, '_parent', {
 *     condition: Ancestor(Self),
 *     change: (t, next, prev) => { ... },
 * });
 * ```
 *
 * `id` is the field written, exactly as `control()`'s id is the field it fronts. `condition` takes
 * the same `Up` / `Ancestor` terms a query does, so there is one vocabulary for
 * "nearest trait above me" wherever it appears.
 *
 * `change` runs only when the resolved value actually differs. A node whose ANCESTOR moved
 * keeps the same value and is not notified — invalidating that is `markTransformDirty`'s
 * job, walking the maintained child lists (see the transform tests that pin this).
 */
export function context<T extends TraitBase, R extends TraitHandle>(
    handle: TraitHandle<T>,
    id: string,
    body: {
        condition: Condition<R, Oper.And, Src.Up | Src.Ancestor>;
        change?: (instance: T, next: TraitBase | null, prev: TraitBase | null) => void;
    },
): void {
    const def = handle._def;
    const ownerSlot = handle._slot;
    const declared = body.condition.trait._slot;
    if (declared === undefined) return;
    const traitSlot = declared === SELF_SLOT ? ownerSlot : declared;
    const change = body.change;

    const resolution: ResolutionDef = {
        field: id,
        traitSlot,
        ownerSlot,
        inclusive: body.condition.src === Src.Up,
        apply(node, resolved) {
            const instance = node._traits[ownerSlot] as Record<string, unknown> | undefined;
            // the walk visits every node on its way down; only nodes bearing the owning
            // trait have a field to write.
            if (instance === undefined) return;
            const next = (resolved ?? null) as TraitBase | null;
            const prev = (instance[id] ?? null) as TraitBase | null;
            if (next === prev) return;
            instance[id] = next;
            change?.(instance as unknown as T, next, prev);
        },
    };

    // replace rather than append, so a re-evaluated module does not stack duplicates.
    const existing = def.resolutions.findIndex((r) => (r as ResolutionDef).field === id);
    if (existing !== -1) def.resolutions[existing] = resolution;
    else def.resolutions.push(resolution);
    fileResolution(registry, resolution);
}
