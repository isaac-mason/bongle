// Cost of detaching many transforms that share one parent.
//
//   ./node_modules/.bin/tsx bench/probe-wide-fanout.ts
//
// `removeTransformChild` does `children.indexOf(child)` before its swap-pop, so removing
// every child of a wide parent is O(n^2). Godot stores `index_in_parent` on the child and
// does `remove_at_unordered(c)` in O(1), fixing up only the element swapped into the hole.
//
// Not reachable in `discovery-world`: its 1000 props hang off the scene root, which bears
// no transform, so each prop is a transform root with an empty `_children`. It IS reachable
// the moment anyone groups placed objects under a node that has a transform.

import { TransformTrait } from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree, removeChild, removeTrait } from '../src/core/scene/scene-tree';

function best(fn: () => void, reps: number): number {
    let b = Infinity;
    for (let r = 0; r < reps; r++) {
        const t0 = process.hrtime.bigint();
        fn();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms < b) b = ms;
    }
    return b;
}

console.log(`\ndetach every child of one transform-bearing parent. best-of\n`);
// `removeChild` also pays the ordered node-child list: `splice` + `reindexChildren`, both
// O(n) per removal. `removeTrait` isolates the transform child list on its own.
console.log(`${'children'.padStart(9)} ${'removeChild'.padStart(12)} ${'removeTrait'.padStart(12)} ${'us/child'.padStart(9)}`);
for (const n of [64, 256, 1024, 4096]) {
    const t = best(() => {
        const sceneTree = createSceneTree();
        const container = createNode({ name: 'container' });
        addChild(sceneTree.root, container);
        addTrait(container, TransformTrait);
        const kids = [];
        for (let i = 0; i < n; i++) {
            const c = createNode({ name: `c${i}` });
            addChild(container, c);
            addTrait(c, TransformTrait);
            kids.push(c);
        }
        // detach front-to-back: the worst order for an indexOf scan
        for (let i = 0; i < kids.length; i++) removeChild(container, kids[i]!);
    }, 20);
    const tt = best(() => {
        const sceneTree = createSceneTree();
        const container = createNode({ name: 'container' });
        addChild(sceneTree.root, container);
        addTrait(container, TransformTrait);
        const kids = [];
        for (let i = 0; i < n; i++) {
            const c = createNode({ name: `c${i}` });
            addChild(container, c);
            addTrait(c, TransformTrait);
            kids.push(c);
        }
        for (let i = 0; i < kids.length; i++) removeTrait(kids[i]!, TransformTrait);
    }, 20);
    console.log(
        `${String(n).padStart(9)} ${t.toFixed(3).padStart(12)} ${tt.toFixed(3).padStart(12)} ${((tt / n) * 1000).toFixed(2).padStart(9)}`,
    );
}
