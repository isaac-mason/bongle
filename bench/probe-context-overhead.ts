// What does the one `context()` in the engine cost scenes, including ones with no
// transforms in them at all?
//
//   NODE_OPTIONS=--expose-gc ./node_modules/.bin/tsx bench/probe-context-overhead.ts
//
// `registry.resolutionGroups` is the whole declared-resolution table, so emptying it is an
// exact A/B for "what would the engine cost if context() did not exist". Correctness is
// irrelevant here — only the walk it drives.

import { TransformTrait } from '../src/builtins/transform';
import { registry } from '../src/core/registry';
import { addChild, addTrait, createNode, createSceneTree, type Node, removeChild } from '../src/core/scene/scene-tree';
import { trait } from '../src/core/scene/traits';

const Plain = trait('ctxcost/plain', { n: 0 });
const NODES = 1200;

/** `branch`-way tree of `NODES` nodes; every `transformEvery`-th node bears a transform
 *  (0 = none at all), the rest are passthrough. */
function build(branch: number, transformEvery: number): Node {
    const root = createNode({ name: 'sub' });
    addTrait(root, transformEvery === 1 ? TransformTrait : Plain);
    let made = 1;
    let frontier: Node[] = [root];
    while (made < NODES) {
        const next: Node[] = [];
        for (const parent of frontier) {
            for (let b = 0; b < branch && made < NODES; b++) {
                const n = createNode({ name: `n${made++}` });
                addTrait(n, transformEvery > 0 && made % transformEvery === 0 ? TransformTrait : Plain);
                addChild(parent, n);
                next.push(n);
            }
        }
        if (next.length === 0) break;
        frontier = next;
    }
    return root;
}

function best(fn: () => void, reps = 120): number {
    for (let i = 0; i < 30; i++) fn();
    let b = Infinity;
    for (let r = 0; r < reps; r++) {
        const t0 = process.hrtime.bigint();
        fn();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms < b) b = ms;
    }
    return b;
}

function measure(label: string, transformEvery: number, branch: number) {
    const sceneTree = createSceneTree();
    const sub = build(branch, transformEvery);
    const cycle = () => {
        addChild(sceneTree.root, sub);
        removeChild(sceneTree.root, sub);
    };

    const groups = registry.resolutionGroups;
    const on = best(cycle);
    registry.resolutionGroups = [];
    const off = best(cycle);
    registry.resolutionGroups = groups;

    console.log(
        `${label.padEnd(34)} ${on.toFixed(3).padStart(8)} ms ${off.toFixed(3).padStart(9)} ms   ` +
            `+${(on - off).toFixed(3)} ms  (${(on / off).toFixed(2)}x)`,
    );
}

console.log(`attach+detach ${NODES} nodes\n`);
console.log(`${'subtree'.padEnd(34)} ${'context()'.padStart(11)} ${'without'.padStart(11)}   overhead`);
for (const branch of [4]) {
    const shape = branch === 1 ? 'deep chain' : 'wide tree';
    measure(`no transforms at all, ${shape}`, 0, branch);
    measure(`1 transform in 8, ${shape}`, 8, branch);
    measure(`1 transform in 3, ${shape}`, 3, branch);
    measure(`every node a transform, ${shape}`, 1, branch);
}

// Does the fear scale? Each declared context() is its own descent, and a subtree bearing
// none of their targets walks in full for every one of them.
const Targets = Array.from({ length: 16 }, (_, i) => trait(`ctxcost/target-${i}`, { n: 0 }));
const Owners = Array.from({ length: 16 }, (_, i) => trait(`ctxcost/owner-${i}`, { n: 0 }));

console.log(`\n${'declared context() count'.padEnd(34)} ${'attach+detach'.padStart(14)}   vs none`);
{
    const sceneTree = createSceneTree();
    const sub = build(4, 0);
    const cycle = () => {
        addChild(sceneTree.root, sub);
        removeChild(sceneTree.root, sub);
    };
    const real = registry.resolutionGroups;

    registry.resolutionGroups = [];
    const none = best(cycle);
    console.log(`${'0'.padEnd(34)} ${none.toFixed(3).padStart(11)} ms   —`);

    for (const n of [1, 4, 16]) {
        // hand-build the groups rather than declaring, so the table is exactly n descents
        registry.resolutionGroups = Array.from({ length: n }, (_, i) => [
            {
                traitSlot: Targets[i]!._slot,
                inclusive: false,
                ownerSlot: Owners[i]!._slot,
                apply: () => {},
            },
        ]);
        const t = best(cycle);
        console.log(`${String(n).padEnd(34)} ${t.toFixed(3).padStart(11)} ms   ${(t / none).toFixed(2)}x`);
    }
    registry.resolutionGroups = real;
}
