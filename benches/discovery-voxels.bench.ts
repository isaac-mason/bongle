import { bench, group } from '@pmndrs/labs';
import { createWorld, moveBots } from '../bench/discovery-world';

// discovery/voxels under "heaps of movers" — many concurrently moving player-bots,
// generated terrain, real chunk streaming + eviction. same scenario as
// bench/profile-voxels-movers.ts, ported to labs for a run you can actually trust
// on a noisy machine: isolated worker per bench, per-sample GC reset, machine
// stability detection, and a statistical A/B compare instead of eyeballing
// tinybench ops/sec deltas.
//
// each sample advances the SAME persistent world by one tick (move bots, then
// Discovery.flush) — there is no `after:` reset, deliberately: the thing under
// study is a continuously-operating server, and per-client known-chunk sets
// growing as bots explore is real, not noise to suppress. if labs flags this
// bench as unstable/trending, that's honest signal about the scenario, not a
// harness bug — a server's own tick cost genuinely drifts as a room fills in.
//
// run: `pnpm --filter benches exec labs` (or `pnpm bench:labs` from lib/).

const PROPS = 2000;
const SPREAD = 256;
const TICKS_SETTLE_ONLY = 200; // extra settled ticks before measurement starts

function settledWorld(clients: number) {
    const world = createWorld({ props: PROPS, clients, terrain: 'generated', spread: SPREAD });
    world.settle();
    for (let i = 0; i < TICKS_SETTLE_ONLY; i++) {
        moveBots(world, i, 'sled');
        world.tick();
    }
    return world;
}

group('discovery/voxels heaps of sledders @discovery @voxels', () => {
    bench('32 clients, 2000 props, sled speed — one tick', function* () {
        const world = settledWorld(32);
        let tick = TICKS_SETTLE_ONLY;

        yield {
            bench: () => {
                moveBots(world, tick, 'sled');
                world.tick();
                tick++;
                return tick; // prevent DCE
            },
        };
    });

    bench('64 clients, 2000 props, sled speed — one tick', function* () {
        const world = settledWorld(64);
        let tick = TICKS_SETTLE_ONLY;

        yield {
            bench: () => {
                moveBots(world, tick, 'sled');
                world.tick();
                tick++;
                return tick;
            },
        };
    });

    bench('32 clients, 2000 props, walk speed — one tick', function* () {
        const world = settledWorld(32);
        let tick = TICKS_SETTLE_ONLY;

        yield {
            bench: () => {
                moveBots(world, tick, 'walk');
                world.tick();
                tick++;
                return tick;
            },
        };
    });
});
