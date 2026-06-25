// gather non-voxel bodies whose AABB overlaps the moving box's swept
// envelope. each visited body becomes a candidate that the slide loop
// will narrow-phase via crashcat's `castShapeVsShape`.
//
// no shape special-casing — sphere, capsule, hull, mesh, compound, or
// rotated box, they all flow through the same path. voxels are excluded
// at the layer filter (handled by `voxel-aabb-sweep`).
//
// owns the self-exclusion filter (rejects the controller's own inner
// body by id) and the layer filter.

import { type BodyId, type BodyVisitor, type Filter, type RigidBody, type World, broadphase, filter } from 'crashcat';
import type { Box3, Vec3 } from 'mathcat';
import { OBJECT_LAYER_VOXELS } from './physics';

/** matches `INVALID_BODY_ID` in crashcat (not re-exported from the root). */
const INVALID_BODY_ID: BodyId = -1;

/**
 * one body that overlapped the swept envelope. holds a live reference;
 * the slide loop reads `body.shape`, `body.position`, `body.quaternion`,
 * and `body.motionProperties.linearVelocity` (stale-by-one-frame) when
 * casting and on contact-wins.
 */
export type BodyCandidate = {
    bodyId: BodyId;
    body: RigidBody;
};

/** reusable gather context. one per controller; reset each tick. */
export type BodyCandidateGather = {
    /** crashcat filter; layers configured at create-time, body filter set per-call. */
    filter: Filter;
    /** out array; cleared at the start of each gather. */
    out: BodyCandidate[];
    /** id of the body to skip (the controller's own inner body). */
    selfBodyId: BodyId;
    /** broadphase visitor — owns its own state so multiple gathers can coexist. */
    visitor: BodyVisitor;
};

/**
 * create a gather context. layer filter excludes OBJECT_LAYER_VOXELS so
 * the broadphase doesn't return voxel bodies (those are handled by the
 * per-cell pass). the body filter rejects bodies whose id matches
 * `gather.selfBodyId`, set per-gather.
 */
export function createBodyCandidateGather(world: World): BodyCandidateGather {
    const f = filter.forWorld(world);
    filter.disableObjectLayer(f, world.settings.layers, OBJECT_LAYER_VOXELS);

    const gather: BodyCandidateGather = {
        filter: f,
        out: [],
        selfBodyId: INVALID_BODY_ID,
        visitor: {
            shouldExit: false,
            visit(body: RigidBody): void {
                gather.out.push({ bodyId: body.id, body });
            },
        },
    };

    f.bodyFilter = (body: RigidBody): boolean => body.id !== gather.selfBodyId;

    return gather;
}

/**
 * gather body candidates overlapping the swept envelope.
 *
 * `out` is cleared first. `selfBodyId` is excluded by id.
 */
export function gatherBodyCandidates(
    gather: BodyCandidateGather,
    world: World,
    bounds: Box3,
    displacement: Vec3,
    selfBodyId: BodyId,
): BodyCandidate[] {
    gather.out.length = 0;
    gather.selfBodyId = selfBodyId;
    gather.visitor.shouldExit = false;

    broadphase.castAABB(world, bounds, displacement, gather.filter, gather.visitor);

    return gather.out;
}
