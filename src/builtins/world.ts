import type { Node } from '../core/scene/scene-tree';
import { addTrait, hasTrait } from '../core/scene/scene-tree';
import { type TraitType } from '../core/scene/traits';
import { trait } from '../core/registry';

export const WorldTrait = trait('world', {}, { persist: false });

export type WorldTrait = TraitType<typeof WorldTrait>;

/** idempotent, attaches WorldTrait to the scene root if it isn't already there. */
export function attachWorldTrait(root: Node): void {
    if (hasTrait(root, WorldTrait)) return;
    addTrait(root, WorldTrait);
}
