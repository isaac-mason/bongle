// WorldTrait — a scene-scoped script host. lives on `nodes.root`,
// auto-attached on every room (server + client) at room creation. carries
// no data; its sole purpose is to give `script(WorldTrait, …)` factories
// a place to run exactly once per scene per side.
//
// Use this for **systems** — per-frame logic that iterates entities via
// `query(ctx, [TraitA, TraitB, …])` rather than running once per entity.
// A WorldTrait script is the right home when the work spans multiple
// traits (no single trait is the natural "owner") or when the per-entity
// `onFrame` closure churn outweighs the locality of per-trait scripts.
//
// Caveat: `ctx.node` is the scene root. POV / ownership checks
// (`getControlNode(ctx) === ctx.node`, `isOwner(ctx, ctx.node)`) are
// meaningless here — they always evaluate against root. Use the entity
// node from the query tuple (`trait._node`) instead.
//
// Example:
// ```ts
// script(WorldTrait, 'character-animation', (ctx) => {
//     if (!env.client) return;
//     const q = query(ctx, [CharacterTrait, CharacterControllerTrait, TransformTrait]);
//     onFrame(ctx, ({ delta }) => {
//         for (const [ch, cc, transform] of q.matches) {
//             const node = ch._node;
//             // …drive bones, read camera, etc.
//         }
//     });
// });
// ```
//
// Per-instance lifecycle that doesn't benefit from batching (one-shot
// onInit setup tied to a specific node) stays on the data trait.

import type { Node } from '../core/scene/nodes';
import { addTrait, hasTrait } from '../core/scene/nodes';
import { type TraitType, trait } from '../core/scene/traits';

export const WorldTrait = trait('world', {}, { persist: false });

export type WorldTrait = TraitType<typeof WorldTrait>;

/** idempotent — attach WorldTrait to the scene root if it isn't already
 *  there. called from room creation on both sides, and again after
 *  `loadSceneGraph` on the server (which clears `root._traits` and
 *  repopulates from persisted data, which never includes WorldTrait
 *  because `persist: false`). */
export function attachWorldTrait(root: Node): void {
    if (hasTrait(root, WorldTrait)) return;
    addTrait(root, WorldTrait);
}
