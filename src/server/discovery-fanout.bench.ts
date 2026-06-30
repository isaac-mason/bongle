import * as p from 'packcat';
import { bench, describe } from 'vitest';
import { createTestServer } from '../../tst/integration/server-integration-test';
import * as Debug from '../core/debug';
import * as Resources from '../core/resources';
import { addChild, addTrait, createNode } from '../core/scene/nodes';
import { syncRate } from '../core/scene/sync/sync-rate';
import { sync, trait } from '../core/scene/traits';
import * as Discovery from './discovery';
import * as Net from './net';
import * as Rooms from './rooms';

// ── Discovery.flush fan-out bench ────────────────────────────────────
//
// the dirty-set rejig's headline claim: per-client scene-sync cost is now
// proportional to *activity*, not scene size. an idle scene with M clients used
// to walk N nodes × M clients every tick; now it iterates an empty dirty set.
// these benches lock that in:
//   - idle: N nodes, M clients, nothing changed → should be ~flat in N.
//   - 20% moving: only the changed nodes are diffed per client.
//
// run: `pnpm bench discovery-fanout`. (needs node 24 for Float16Array.)

const Mover = trait('fanout-mover', { pos: [0, 0, 0] as number[] });
sync(Mover, 'pos', {
    schema: p.list(p.float32(), 3),
    pack: (t) => t.pos,
    unpack: (v, t) => {
        t.pos = v as number[];
    },
    rate: syncRate.distance(0.05),
});

const N = 1000;
const M = 8;

/** N shared Mover nodes + M play clients all caught up (initial creates drained),
 *  so the benched flushes measure steady state. */
function setup() {
    const server = createTestServer({ mode: 'play' });
    const discovery = Discovery.init();
    const resources = Resources.init({ loadBytes: async () => new Uint8Array() }, 'server');
    const net = Net.init();

    const movers: Array<{ pos: number[] }> = [];
    for (let i = 0; i < N; i++) {
        const n = createNode();
        addChild(server.nodes.root, n);
        const m = addTrait(n, Mover);
        m.pos = [0, 0, 0];
        movers.push(m);
    }

    for (let c = 1; c <= M; c++) {
        Discovery.addClient(discovery, c);
        const player = Rooms.joinRoom(server.rooms, c, server.room.id, server.room.mode);
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
    }

    const metrics = Debug.createMetrics(false);
    Discovery.flush(discovery, server.rooms, resources, metrics); // drain initial creates
    return { server, discovery, resources, metrics, movers };
}

describe('Discovery.flush fan-out', () => {
    {
        // nothing changes, the dirty set is empty, so per-client cost should not
        // scale with N (this is the case the old whole-tree walk paid in full).
        const { server, discovery, resources, metrics } = setup();
        bench(`${N} nodes × ${M} clients — idle (no changes)`, () => {
            Discovery.flush(discovery, server.rooms, resources, metrics);
        });
    }
    {
        // ~20% of nodes move past threshold each tick → only those are dirty and
        // diffed per client.
        const { server, discovery, resources, metrics, movers } = setup();
        let tick = 0;
        bench(`${N} nodes × ${M} clients — 20% moving`, () => {
            tick++;
            const d = tick * 0.1; // > 5cm each tick
            for (let i = 0; i < movers.length; i += 5) movers[i].pos[0] = d;
            Discovery.flush(discovery, server.rooms, resources, metrics);
        });
    }
});
