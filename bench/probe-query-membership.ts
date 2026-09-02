// harness for the L1-L4 query levers in plan-scene-perf.
//
//   NODE_OPTIONS=--expose-gc ./node_modules/.bin/tsx bench/probe-query-membership.ts
//
// Time is best-of-N (an average is meaningless on a throttling machine).
// Allocation is a gc-delta over a cycle count small enough that no GC fires
// mid-measure — verified by measuring at two cycle counts and checking the
// per-node figure agrees; a mismatch means GC ran and the number is junk.

import { Ancestor, Optional, Up } from '../src/core/scene/conditions';
import {
    addChild,
    addTrait,
    createNode,
    createSceneTree,
    type Node,
    query,
    removeChild,
    type SceneTree,
} from '../src/core/scene/scene-tree';
import { trait } from '../src/core/scene/traits';

const A = trait('qm/a', { x: 0 });
const B = trait('qm/b', { y: 0 });

const NODES = 1200;
const gc = (globalThis as any).gc as () => void;

type Shape = 'flat' | 'deep';

function build(shape: Shape): Node {
    const container = createNode({ name: 'container' });
    addTrait(container, B); // the ancestor a resolving query reaches for
    if (shape === 'flat') {
        for (let i = 0; i < NODES; i++) {
            const n = createNode({ name: `n${i}` });
            addTrait(n, A);
            addChild(container, n);
        }
        return container;
    }
    // 120 chains of depth 10: an Ancestor() term costs an O(depth) walk per node.
    let made = 0;
    for (let c = 0; c < 120; c++) {
        let cursor = container;
        for (let d = 0; d < 10 && made < NODES; d++) {
            const n = createNode({ name: `n${made++}` });
            addTrait(n, A);
            addChild(cursor, n);
            cursor = n;
        }
    }
    return container;
}

type Case = { label: string; shape: Shape; install: (t: SceneTree) => void };

const CASES: Case[] = [
    { label: 'no query, flat', shape: 'flat', install: () => {} },
    { label: '1 plain query, flat', shape: 'flat', install: (t) => void query(t, [A]) },
    {
        label: '3 plain queries, flat',
        shape: 'flat',
        install: (t) => {
            query(t, [A]);
            query(t, [A, Optional(B)]);
            query(t, [A, Optional(Up(B))]);
        },
    },
    { label: '1 Optional(Ancestor) query, deep', shape: 'deep', install: (t) => void query(t, [A, Optional(Ancestor(B))]) },
    { label: '1 REQUIRED Ancestor query, deep', shape: 'deep', install: (t) => void query(t, [A, Ancestor(B)]) },
];

function measure(c: Case) {
    const sceneTree = createSceneTree();
    c.install(sceneTree);
    const container = build(c.shape);

    const cycle = () => {
        addChild(sceneTree.root, container);
        removeChild(sceneTree.root, container);
    };
    for (let i = 0; i < 60; i++) cycle();

    let bestMs = Infinity;
    for (let r = 0; r < 40; r++) {
        const t0 = process.hrtime.bigint();
        cycle();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms < bestMs) bestMs = ms;
    }

    const alloc = (cycles: number) => {
        gc();
        gc();
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < cycles; i++) cycle();
        return (process.memoryUsage().heapUsed - before) / cycles / NODES;
    };
    const a10 = alloc(10);
    const a20 = alloc(20);
    const agree = Math.abs(a10 - a20) / Math.max(a10, a20) < 0.15;

    console.log(
        `${c.label.padEnd(34)} ${bestMs.toFixed(3).padStart(7)} ms  ` +
            `${a20.toFixed(0).padStart(4)} B/node${agree ? '  ' : ' ?'}  ${agree ? '' : `(10-cycle read ${a10.toFixed(0)}, GC interfered)`}`,
    );
}

console.log(`${'case'.padEnd(34)} ${'best'.padStart(10)}  alloc`);
for (const c of CASES) measure(c);

// The attach/detach-a-whole-container shape empties `sceneTree.nodes` and
// `_idToNode` every cycle, so V8 shrinks and regrows those tables. A game
// instead spawns a small prop into a scene that stays populated. Measures the
// same per-node cost under that shape, where the containers never shrink.
function measureSpawnChurn(label: string, install: (t: SceneTree) => void, resident: number): void {
    const sceneTree = createSceneTree();
    install(sceneTree);
    const world = createNode({ name: 'world' });
    addTrait(world, B);
    addChild(sceneTree.root, world);
    for (let i = 0; i < resident; i++) {
        const n = createNode({ name: `r${i}` });
        addTrait(n, A);
        addChild(world, n);
    }

    const PROP_NODES = 6;
    const prop = createNode({ name: 'prop' });
    addTrait(prop, A);
    for (let i = 0; i < PROP_NODES - 1; i++) {
        const m = createNode({ name: `m${i}` });
        addTrait(m, A);
        addChild(prop, m);
    }

    const cycle = () => {
        addChild(world, prop);
        removeChild(world, prop);
    };
    for (let i = 0; i < 2000; i++) cycle();

    let best = Infinity;
    for (let r = 0; r < 2000; r++) {
        const t0 = process.hrtime.bigint();
        cycle();
        const us = Number(process.hrtime.bigint() - t0) / 1000;
        if (us < best) best = us;
    }

    const alloc = (cycles: number) => {
        gc();
        gc();
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < cycles; i++) cycle();
        return (process.memoryUsage().heapUsed - before) / cycles / PROP_NODES;
    };
    const a1 = alloc(400);
    const a2 = alloc(800);
    const agree = Math.abs(a1 - a2) / Math.max(a1, a2) < 0.15;
    console.log(`${label.padEnd(40)} ${best.toFixed(2).padStart(7)} us  ${a2.toFixed(0).padStart(4)} B/node${agree ? '' : ' ?'}`);
}

console.log(`\n${'spawn a 6-node prop into a live scene'.padEnd(40)} ${'best'.padStart(10)}  alloc`);
for (const resident of [0, 1200]) {
    measureSpawnChurn(`no query, ${resident} resident nodes`, () => {}, resident);
    measureSpawnChurn(`1 plain query, ${resident} resident nodes`, (t) => void query(t, [A]), resident);
}

// L4 is an O(depth) walk per node per required hierarchy term. Real scenes are
// wide and shallow (see scene-shapes.bench.ts), so the gap's depth sensitivity
// decides whether the lever is worth a registerSubtree restructure.
function buildDepth(depth: number): Node {
    const container = createNode({ name: 'container' });
    addTrait(container, B);
    const chains = Math.max(1, Math.floor(NODES / depth));
    let made = 0;
    for (let c = 0; c < chains; c++) {
        let cursor = container;
        for (let d = 0; d < depth && made < NODES; d++) {
            const n = createNode({ name: `n${made++}` });
            addTrait(n, A);
            addChild(cursor, n);
            cursor = n;
        }
    }
    return container;
}

function timeOnly(install: (t: SceneTree) => void, depth: number): number {
    const sceneTree = createSceneTree();
    install(sceneTree);
    const container = buildDepth(depth);
    const cycle = () => {
        addChild(sceneTree.root, container);
        removeChild(sceneTree.root, container);
    };
    for (let i = 0; i < 60; i++) cycle();
    let best = Infinity;
    for (let r = 0; r < 40; r++) {
        const t0 = process.hrtime.bigint();
        cycle();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms < best) best = ms;
    }
    return best;
}

console.log(`\n${'depth'.padStart(6)} ${'Optional(Anc)'.padStart(14)} ${'required Anc'.padStart(14)}   required cost`);
for (const depth of [2, 3, 5, 10, 20, 40]) {
    const opt = timeOnly((t) => void query(t, [A, Optional(Ancestor(B))]), depth);
    const req = timeOnly((t) => void query(t, [A, Ancestor(B)]), depth);
    console.log(
        `${String(depth).padStart(6)} ${opt.toFixed(3).padStart(13)}m ${req.toFixed(3).padStart(13)}m` +
            `   ${(req / opt).toFixed(2)}x  (+${((req - opt) * 1000).toFixed(0)} us)`,
    );
}
