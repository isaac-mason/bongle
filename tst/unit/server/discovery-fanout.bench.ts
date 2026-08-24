import { bench, describe } from 'vitest';
import { createWorld, moveBots, moveProps, type World } from '../../../bench/discovery-world';

// ── Discovery.flush fan-out bench ────────────────────────────────────
//
// per-client scene-sync cost. the dirty-set design's claim is that this tracks
// *activity*, not scene size: an idle scene iterates an empty dirty set instead
// of walking N nodes × M clients.
//
// the world (bench/discovery-world.ts) is generated terrain — hills, water and trees
// from the kit blocks, so chunks are several layers deep with multi-entry palettes
// and real light. plus real player nodes with their own AOI anchors, and props that
// are real transform roots and so are genuinely chunk-gated. that last point is
// load-bearing: a node with no TransformTrait has no transform root, and
// buildSceneSyncUpdates treats those as never chunk-gated — so a scene of sync-only
// nodes measures fan-out with AOI switched off, however the world is set up.
//
// the cases separate what actually drives cost:
//   - idle:              nothing moves. the floor of the per-tick fan-out.
//   - props emitting:    20% of props emit, none change chunk. pure field-update
//                        fan-out, no AOI churn.
//   - bots at walk/sled:  the players orbit and cross chunk boundaries at two very
//                        different rates — a walking character's ~5 blocks/s vs. a
//                        downhill-sledding game's ~40 blocks/s (terminalVelocity) —
//                        so AOI regions churn and presence flips at correspondingly
//                        different rates. see discovery-egress.ts for the byte-level
//                        version of this split; walk vs. sled is an 8x speed gap
//                        that does NOT translate into an 8x cost gap (chunk reuse
//                        between nearby crossings), but it's still the single
//                        biggest lever on discovery cost of anything benched here.
//
// run: `pnpm bench discovery-fanout`. (needs node 24 for Float16Array.)

const PROPS = 2000;
const CLIENTS = 8;
// wider than the 8-chunk (128 block) stream radius so AOI actually culls. kept at
// 160 rather than the egress script's 256 because worldgen runs once per bench case
// and scales with the square of this.
const SPREAD = 160;

/** a settled world — every client's AOI region has finished expanding, so the
 *  benched ticks measure steady state rather than the join stream. */
function world(): World {
    const w = createWorld({ props: PROPS, clients: CLIENTS, terrain: 'generated', spread: SPREAD });
    w.settle();
    return w;
}

describe('Discovery.flush fan-out', () => {
    {
        const w = world();
        bench(`${PROPS} props × ${CLIENTS} clients — idle`, () => {
            w.tick();
        });
    }
    {
        const w = world();
        let tick = 0;
        bench(`${PROPS} props × ${CLIENTS} clients — 20% of props emitting`, () => {
            moveProps(w, tick++);
            w.tick();
        });
    }
    {
        const w = world();
        let tick = 0;
        bench(`${PROPS} props × ${CLIENTS} clients — bots walking (5 blocks/s)`, () => {
            moveBots(w, tick++, 'walk');
            w.tick();
        });
    }
    {
        const w = world();
        let tick = 0;
        bench(`${PROPS} props × ${CLIENTS} clients — bots sledding (40 blocks/s)`, () => {
            moveBots(w, tick++, 'sled');
            w.tick();
        });
    }
});
