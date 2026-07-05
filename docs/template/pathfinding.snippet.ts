// Typechecked snippets for Pathfinding.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import {
    CharacterControllerTrait,
    env,
    getTrait,
    getWorldPosition,
    nav,
    onTick,
    script,
    setCharacterLook,
    TransformTrait,
} from 'bongle';
import type { Vec3 } from 'mathcat';

/* SNIPPET_START: path */
// where the NPC is heading (recompute this toward the nearest player for a chaser)
const GOAL: Vec3 = [12, 1, 8];

// the successor the search expands over. groundDropActions also walks off ledges
// and drops down; for gap-jumps, spread nav.groundMoves with longer offsets and
// build one with nav.gridActions(moves, nav.groundWalkable()).
const NPC_ACTIONS = nav.groundDropActions({ maxDrop: 8 });

// drive an NPC's character controller along a path to GOAL. actor-style: this runs
// once per node carrying a CharacterControllerTrait.
script(CharacterControllerTrait, 'npc-nav', (ctx) => {
    if (!env.server) return; // the server owns NPC movement; the result replicates

    const transform = getTrait(ctx.node, TransformTrait);
    if (!transform) return;

    let path: ReturnType<typeof nav.findPath> = [];
    let waypoint = 0;
    let repathIn = 0;

    onTick(ctx, ({ delta }) => {
        const controller = ctx.trait;
        const pos = getWorldPosition(transform);

        // repath a couple of times a second rather than every tick
        repathIn -= delta;
        if (repathIn <= 0) {
            repathIn = 0.5;
            const start: Vec3 = [Math.floor(pos[0]), Math.floor(pos[1]), Math.floor(pos[2])];
            const raw = nav.findPath(ctx.voxels, start, GOAL, NPC_ACTIONS, { maxIterations: 2000 });
            path = raw ? nav.smoothPath(ctx.voxels, raw, nav.groundShortcut()) : [];
            waypoint = 1; // skip the cell we're standing in
        }

        // drop waypoints we've reached (horizontal distance only)
        while (path && waypoint < path.length) {
            const cell = path[waypoint]!;
            const dx = cell[0] + 0.5 - pos[0];
            const dz = cell[2] + 0.5 - pos[2];
            if (dx * dx + dz * dz > 0.25) break;
            waypoint++;
        }

        if (!path || waypoint >= path.length) {
            controller.input.move[0] = 0;
            controller.input.move[1] = 0; // arrived, or no route: stand still
            return;
        }

        // steer toward the next waypoint: face it, then walk straight forward
        const cell = path[waypoint]!;
        const dx = cell[0] + 0.5 - pos[0];
        const dz = cell[2] + 0.5 - pos[2];
        setCharacterLook(controller, Math.atan2(-dx, -dz)); // face the next waypoint
        controller.input.move[0] = 0; // no strafe
        controller.input.move[1] = 1; // full forward
        controller.input.jump = controller.state.horizontalCollision; // hop when a full-block step stalls us
    });
});
/* SNIPPET_END: path */
