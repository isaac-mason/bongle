import { bench, describe } from 'vitest';
import { TRANSFORM_SEND_HZ } from '../../../src/core/clock';
import { pack } from '../../../src/core/scene/pack';
import { addChild, addTrait, createNode, createSceneTree } from '../../../src/core/scene/scene-tree';
import { dirty, rate } from '../../../src/core/scene/sync/sync-rate';
import { sync, trait } from '../../../src/core/scene/traits';
import { runDiffDetection } from '../../../src/server/discovery';

// ── runDiffDetection bench ───────────────────────────────────────────
//
// the REAL per-tick diff: a real scene tree, real trait sync codecs, real packcat
// serialization. measures what shows up as `discovery/diff` in the perf digest,
// packInto, bytesEqual, storeSnapshot, version bumps.
//
// diff detection is dirtiness only — `rate` is a send-side policy consumed by the
// fan-out (see discovery-fanout.bench.ts), so it never shows up in these numbers.
// the two dirty policies are separate code paths and are benched separately:
//   - `dirty.diff()`     packs + byte-compares against the snapshot every tick
//   - `dirty.explicit()` reads the dirty bit and skips the byte-diff entirely
//
// run: `pnpm bench discovery`. capture a baseline, change the diff path, re-run,
// compare. each bench is one diff pass over N nodes (the per-tick cost).

// mirrors TransformTrait's synced pose: vec3 position + vec4 quaternion, the same
// packcat schemas and the same dirty/rate policies (builtins/transform.ts).
const Mover = trait('bench-mover', {
    pos: [0, 0, 0] as number[],
    rot: [0, 0, 0, 1] as number[],
});
sync(Mover, 'pos', {
    schema: pack.position(),
    pack: (t) => t.pos,
    unpack: (v, t) => {
        t.pos = v as number[];
    },
    dirty: dirty.diff(),
    rate: rate.hz(TRANSFORM_SEND_HZ),
});
sync(Mover, 'rot', {
    schema: pack.quaternion(),
    pack: (t) => t.rot,
    unpack: (v, t) => {
        t.rot = v as number[];
    },
    dirty: dirty.diff(),
    rate: rate.hz(TRANSFORM_SEND_HZ),
});

// the explicit-dirty counterpart: same shape, but the diff pass short-circuits on
// the dirty bit instead of packing and comparing bytes.
const ExplicitMover = trait('bench-mover-explicit', {
    pos: [0, 0, 0] as number[],
    rot: [0, 0, 0, 1] as number[],
});
sync(ExplicitMover, 'pos', {
    schema: pack.position(),
    pack: (t) => t.pos,
    unpack: (v, t) => {
        t.pos = v as number[];
    },
    dirty: dirty.explicit(),
    rate: rate.realtime(),
});
sync(ExplicitMover, 'rot', {
    schema: pack.quaternion(),
    pack: (t) => t.rot,
    unpack: (v, t) => {
        t.rot = v as number[];
    },
    dirty: dirty.explicit(),
    rate: rate.realtime(),
});

const N = 1000;

// build a fresh scene of N Mover nodes and seed the diff snapshots with one pass,
// so the benched passes measure steady state, not first-seen or construction.
// each instance gets its own pos/rot arrays so per-node mutation is independent.
function scene(def: typeof Mover = Mover) {
    const sceneTree = createSceneTree();
    const movers: Array<{ pos: number[]; rot: number[] }> = [];
    for (let i = 0; i < N; i++) {
        const n = createNode();
        addChild(sceneTree.root, n);
        const m = addTrait(n, def);
        m.pos = [0, 0, 0];
        m.rot = [0, 0, 0, 1];
        movers.push(m);
    }
    runDiffDetection(sceneTree); // seed
    return { sceneTree, movers };
}

describe('runDiffDetection', () => {
    {
        // static: nothing moves. every slice is still packed and byte-compared, and
        // emits nothing — the steady "wasted work over unchanged" cost.
        const { sceneTree } = scene();
        bench(`${N} static nodes (no change)`, () => {
            runDiffDetection(sceneTree);
        });
    }
    {
        // every node changes each tick → every slice emits: real pack +
        // storeSnapshot + version bump. the change-burst cost.
        const { sceneTree, movers } = scene();
        let tick = 0;
        bench(`${N} moving nodes (all emit)`, () => {
            tick++;
            const d = tick * 0.1;
            for (const m of movers) m.pos[0] = d;
            runDiffDetection(sceneTree);
        });
    }
    {
        // ~20% moving, rest static, a more typical frame.
        const { sceneTree, movers } = scene();
        let tick = 0;
        bench(`${N} nodes, 20% moving`, () => {
            tick++;
            const d = tick * 0.1;
            for (let i = 0; i < movers.length; i += 5) movers[i].pos[0] = d;
            runDiffDetection(sceneTree);
        });
    }
    {
        // explicit dirtiness, nothing flagged: the cheapest path in the pass, one
        // bit test per slice and out. the floor a set-once field costs per tick.
        const { sceneTree } = scene(ExplicitMover);
        bench(`${N} static nodes, explicit dirty (bit test only)`, () => {
            runDiffDetection(sceneTree);
        });
    }
});
