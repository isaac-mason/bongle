import type { Contact } from '../core/physics/contacts';
import { type TraitType } from '../core/scene/traits';
import { trait } from '../core/registry';

/**
 * per-step contact lifecycle for a node, populated by the physics fan-out phase after the world
 * step. Normals point away from this node.
 *
 * Contact references are valid until the start of the next physics step; the underlying Contact
 * instance is released to the pool afterward, so copy any fields a script needs to retain.
 *
 * A Contact in `added` last step appears in `persisted` this step with different object identity
 * but identical-meaning fields. Key by `nodeId`+`subShapeId` or `(voxelX, voxelY, voxelZ)`, not by reference.
 */
export const ContactsTrait = trait(
    'contacts',
    {
        /** all contacts active this step, `added` ++ `persisted`. */
        active: () => [] as Contact[],
        /** first seen this step. */
        added: () => [] as Contact[],
        /** present last step AND this step. */
        persisted: () => [] as Contact[],
        /** present last step, gone this step. Fields are last-known (one step stale). */
        removed: () => [] as Contact[],
    },
    { persist: false },
);

export type ContactsTrait = TraitType<typeof ContactsTrait>;
