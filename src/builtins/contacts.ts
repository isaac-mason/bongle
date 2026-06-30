import type { Contact } from '../core/physics/contacts';
import { type TraitType, trait } from '../core/scene/traits';

/**
 * per-step contact lifecycle for a node.
 *
 * populated by the physics fan-out phase (after the world step, before
 * `runOnPostPhysicsStep`). normals point AWAY from this node. owner-local,
 * whichever side runs the physics step populates locally; events from a
 * predicted body show up on the predicting client.
 *
 * lifetime contract: Contact references in these arrays are valid until
 * the start of the next physics step. fields are *not* preserved across
 * steps, the underlying Contact instance is released to the pool. if a
 * script needs to retain data across steps, copy the fields it cares about.
 *
 * a Contact appearing in `added` last step appears in `persisted` this step
 * with *different* object identity but identical-meaning fields. don't hash
 * by reference; key by `nodeId`+`subShapeId` or `(voxelX, voxelY, voxelZ)`.
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
        /** present last step, gone this step. fields are last-known (one step stale). */
        removed: () => [] as Contact[],
    },
    { persist: false },
);

export type ContactsTrait = TraitType<typeof ContactsTrait>;
