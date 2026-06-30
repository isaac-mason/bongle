import * as p from 'packcat';
import { bench, describe } from 'vitest';
import { addChild, addTrait, createNode, createSceneGraph } from '../core/scene/nodes';
import { syncRate } from '../core/scene/sync/sync-rate';
import { sync, trait } from '../core/scene/traits';
import { runDiffDetection } from './discovery';

// ── runDiffDetection bench ───────────────────────────────────────────
//
// the REAL per-tick diff: a real scene graph, real trait sync codecs, real packcat
// serialization. measures what shows up as `discovery/diff` in the perf digest,
// packInto, bytesEqual, storeSnapshot, the threshold compares, version bumps.
//
// run: `pnpm bench discovery`. capture a baseline, change the diff path, re-run,
// compare. each bench is one diff pass over N nodes (the per-tick cost).

// a trait mirroring TransformTrait's synced state: vec3 position (5cm threshold) +
// vec4 quaternion (~1° threshold), real float32 packcat schemas + real rates.
const Mover = trait('bench-mover', {
    pos: [0, 0, 0] as number[],
    rot: [0, 0, 0, 1] as number[],
});
sync(Mover, 'pos', {
    schema: p.list(p.float32(), 3),
    pack: (t) => t.pos,
    unpack: (v, t) => {
        t.pos = v as number[];
    },
    rate: syncRate.distance(0.05),
});
sync(Mover, 'rot', {
    schema: p.list(p.float32(), 4),
    pack: (t) => t.rot,
    unpack: (v, t) => {
        t.rot = v as number[];
    },
    rate: syncRate.angle(0.02),
});

const N = 1000;

// build a fresh scene of N Mover nodes and seed the diff snapshots with one pass,
// so the benched passes measure steady state, not first-seen or construction.
// each instance gets its own pos/rot arrays so per-node mutation is independent.
function scene() {
    const sg = createSceneGraph();
    const movers: Array<{ pos: number[]; rot: number[] }> = [];
    for (let i = 0; i < N; i++) {
        const n = createNode();
        addChild(sg.root, n);
        const m = addTrait(n, Mover);
        m.pos = [0, 0, 0];
        m.rot = [0, 0, 0, 1];
        movers.push(m);
    }
    runDiffDetection(sg); // seed
    return { sg, movers };
}

describe('runDiffDetection', () => {
    {
        // static: nothing moves. every slice is re-checked (threshold compare) and
        // emits nothing, the steady "wasted work over unchanged" cost.
        const { sg } = scene();
        bench(`${N} static nodes (no change)`, () => {
            runDiffDetection(sg);
        });
    }
    {
        // every node moves past threshold each tick → every slice emits: real pack +
        // storeSnapshot + version bump. the change-burst cost.
        const { sg, movers } = scene();
        let tick = 0;
        bench(`${N} moving nodes (all emit)`, () => {
            tick++;
            const d = tick * 0.1; // > 5cm each tick
            for (const m of movers) m.pos[0] = d;
            runDiffDetection(sg);
        });
    }
    {
        // ~20% moving, rest static, a more typical frame.
        const { sg, movers } = scene();
        let tick = 0;
        bench(`${N} nodes, 20% moving`, () => {
            tick++;
            const d = tick * 0.1;
            for (let i = 0; i < movers.length; i += 5) movers[i].pos[0] = d;
            runDiffDetection(sg);
        });
    }
});
