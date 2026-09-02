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
