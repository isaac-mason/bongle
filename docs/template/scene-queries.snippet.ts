// Typechecked snippets for Scene queries.
// Compiles against `bongle` (+ crashcat for physics rays); regions are pulled
// into guide.md by build.js.

import { BLOCK_FLAG_COLLISION, createVoxelRaycastResult, log, OBJECT_LAYER_VOXELS, onInit, raycastVoxels, system } from 'bongle';
import {
    CastRayStatus,
    castRay,
    filter as crashcatFilter,
    createClosestCastRayCollector,
    createDefaultCastRaySettings,
} from 'crashcat';

/* SNIPPET_START: raycast-voxels */
// hit-test the block grid: walk a ray from an origin along a direction and read
// the first solid block hit (build cursor, hitscan vs terrain, line of sight).
system('block-pick', (ctx) => {
    onInit(ctx, () => {
        const out = createVoxelRaycastResult();
        raycastVoxels(
            out,
            ctx.voxels,
            ctx.blocks, // the block registry, for per-block flags
            0,
            10,
            0, // origin x/y/z
            0,
            -1,
            0, // direction x/y/z (straight down)
            32, // max distance
            BLOCK_FLAG_COLLISION, // only blocks with collision count as a hit
        );
        if (out.hit) {
            // out.voxelX/Y/Z: the block cell; out.nx/ny/nz: the hit normal;
            // out.distance: range; out.stateId: which block kind was hit
            log(ctx, 'hit block at', out.voxelX, out.voxelY, out.voxelZ);
        }
    });
});
/* SNIPPET_END: raycast-voxels */

/* SNIPPET_START: raycast-physics */
// hit-test the physics world (rigid bodies, character controllers). bongle does
// not wrap this; cast against the crashcat world directly with the crashcat API.
system('body-pick', (ctx) => {
    onInit(ctx, () => {
        const world = ctx.physics.rigid.world;

        // a filter scopes the query. start from the world's layers, then disable
        // the voxel terrain layer so the ray hits only bodies, not blocks.
        const rayFilter = crashcatFilter.forWorld(world);
        crashcatFilter.disableObjectLayer(rayFilter, world.settings.layers, OBJECT_LAYER_VOXELS);

        const collector = createClosestCastRayCollector();
        const settings = createDefaultCastRaySettings();
        castRay(world, collector, settings, [0, 10, 0], [0, -1, 0], 32, rayFilter);

        if (collector.hit.status === CastRayStatus.COLLIDING) {
            const distance = collector.hit.fraction * 32; // fraction is 0..1 along the ray
            log(ctx, 'hit body', collector.hit.bodyIdB, 'at', distance);
        }
    });
});
/* SNIPPET_END: raycast-physics */
