// ad-hoc probe: reparenting a transform subtree (the markAncestryChanged walk).
// run: node_modules/.bin/tsx bench/probe-reparent.ts

import { computeWorldTransforms, TransformTrait } from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree, type Node, reparent } from '../src/core/scene/scene-tree';

function transformNode(parent: Node, name: string): TransformTrait {
    const node = createNode({ name });
    addChild(parent, node);
    return addTrait(node, TransformTrait);
}

function measure(label: string, fn: () => void, iters: number): void {
    for (let i = 0; i < 2000; i++) fn();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn();
    const t1 = process.hrtime.bigint();
    console.log(`${label.padEnd(46)} ${(Number(t1 - t0) / 1e3 / iters).toFixed(2)} µs`);
}

for (const size of [6, 64]) {
    const sceneTree = createSceneTree();
    const a = transformNode(sceneTree.root, 'a');
    const b = transformNode(sceneTree.root, 'b');
    const sub = transformNode(a._node, 'sub');
    for (let i = 1; i < size; i++) transformNode(sub._node, `s${i}`);
    computeWorldTransforms(sceneTree);
    measure(
        `reparent a ${size}-transform subtree`,
        () => {
            reparent(sub._node, b._node);
            reparent(sub._node, a._node);
        },
        20000,
    );
}
