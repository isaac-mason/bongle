// Does every `my()` / query traversal in the registry cost a full subtree descent
// on ATTACH? `resolutions.bench.ts` measures reparent, which gets the `movedFrom`
// early-out in resolveSubtreeFor; attach passes no movedFrom, so nothing is skipped.
//
//   NODE_OPTIONS=--expose-gc ./node_modules/.bin/tsx bench/probe-resolution-attach.ts

import { Optional, Up } from '../src/core/scene/conditions';
import { addChild, addTrait, createNode, createSceneTree, type Node, query, removeChild } from '../src/core/scene/scene-tree';
import { trait } from '../src/core/scene/traits';

const Mesh = trait('resattach/mesh', { id: 0 });
const Group = trait('resattach/group', { id: 0 });
const Distinct = Array.from({ length: 32 }, (_, i) => trait(`resattach/distinct-${i}`, { id: 0 }));

const NODES = 64;

function build(): Node {
    const root = createNode({ name: 'sub' });
    addTrait(root, Mesh);
    let cur = root;
    for (let i = 1; i < NODES; i++) {
        const n = createNode({ name: `n${i}` });
        addTrait(n, Mesh);
        addChild(cur, n);
        cur = n;
    }
    return root;
}

function measure(label: string, install: (t: ReturnType<typeof createSceneTree>) => void, bearTargets = 0) {
    const sceneTree = createSceneTree();
    install(sceneTree);
    const host = createNode({ name: 'host' });
    addTrait(host, Group);
    // the only variable between a pair of rows: whether the traversal targets are borne
    // above the attach point (descend) or absent everywhere (prunable).
    for (let i = 0; i < bearTargets; i++) addTrait(host, Distinct[i]!);
    addChild(sceneTree.root, host);
    const sub = build();

    const cycle = () => {
        addChild(host, sub);
        removeChild(host, sub);
    };
    for (let i = 0; i < 400; i++) cycle();

    let best = Infinity;
    for (let r = 0; r < 400; r++) {
        const t0 = process.hrtime.bigint();
        cycle();
        const us = Number(process.hrtime.bigint() - t0) / 1000;
        if (us < best) best = us;
    }
    console.log(`${label.padEnd(46)} ${best.toFixed(2).padStart(7)} us/attach+detach`);
}

// The query COUNT is held constant within each pair, so membership maintenance costs the
// same on both rows and the only variable is whether each query's traversal target is
// actually borne (descend) or absent everywhere (prunable).
console.log(`attach+detach a ${NODES}-node chain (no movedFrom early-out)\n`);
measure('no queries at all', () => {});

for (const n of [1, 4, 16]) {
    const install = (t: ReturnType<typeof createSceneTree>) => {
        for (let i = 0; i < n; i++) query(t, [Mesh, Optional(Up(Distinct[i]!))]);
    };
    measure(`${n} queries, targets ABSENT (prunable)`, install, 0);
    measure(`${n} queries, targets BORNE above (descend)`, install, n);
}
