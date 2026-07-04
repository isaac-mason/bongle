export {
    COLLISION_GROUP_CHARACTERS,
    COLLISION_GROUP_NODES,
    COLLISION_GROUP_VOXELS,
    OBJECT_LAYER_NODE_MOVING,
    OBJECT_LAYER_NODE_NOT_MOVING,
    OBJECT_LAYER_VOXELS,
} from '../core/physics/crashcat';
export type { Physics } from '../core/physics/physics';
export { objectLayerForMotionType } from '../core/physics/rigid-physics';

// ── collision groups ──────────────────────────────────────────────────
//
// crashcat bodies collide when `(a.groups & b.mask) && (b.groups & a.mask)`.
// the engine reserves the low bits (voxels, nodes, characters); games declare
// their own groups above that range with `defineCollisionGroups(...)`, then
// build masks with `onlyGroups` / `exceptGroups`.

/** number of low bits reserved by the engine (voxels=0, nodes=1, characters=2).
 *  games' own groups start at this bit. */
export const RESERVED_COLLISION_GROUP_BITS = 3;

/** declare a game's collision groups once, in a stable order, and get a named
 *  bit for each. bit assignment is positional (first name → first free bit
 *  above the reserved range), so it's identical on every side, groups aren't
 *  synced, so a game MUST declare them the same way everywhere (call this once
 *  at module load with a fixed list, don't build the list conditionally).
 *
 *  @example
 *  const G = defineCollisionGroups('enemies', 'pickups', 'playerBullets');
 *  // enemies pass through each other, like characters:
 *  //   { collisionGroups: G.enemies, collisionMask: exceptGroups(G.enemies) }
 *  // pickups only interact with characters:
 *  //   { collisionGroups: G.pickups, collisionMask: onlyGroups(COLLISION_GROUP_CHARACTERS) }
 */
export function defineCollisionGroups<const K extends string>(...names: K[]): Record<K, number> {
    const out = {} as Record<K, number>;
    names.forEach((name, i) => {
        const bit = RESERVED_COLLISION_GROUP_BITS + i;
        if (bit > 31) {
            throw new Error(`defineCollisionGroups: too many groups (max ${32 - RESERVED_COLLISION_GROUP_BITS})`);
        }
        out[name] = 1 << bit;
    });
    return out;
}

/** mask of ONLY the given groups (collide with these and nothing else). */
export function onlyGroups(...groups: number[]): number {
    let mask = 0;
    for (const g of groups) mask |= g;
    return mask >>> 0;
}

/** mask of everything EXCEPT the given groups (collide with all but these). */
export function exceptGroups(...groups: number[]): number {
    return ~onlyGroups(...groups) >>> 0;
}
