// bytes allocated per node spawn and per subtree attach.
// run: NODE_OPTIONS=--expose-gc node_modules/.bin/tsx bench/probe-spawn-alloc.ts

import { TransformTrait } from '../src/builtins/transform';
import { Optional, Up } from '../src/core/scene/conditions';
import { addChild, addTrait, createNode, createSceneTree, type Node, query, removeChild } from '../src/core/scene/scene-tree';
import { buildTraitInstance, trait } from '../src/core/scene/traits';

const Mesh = trait('alloc/mesh', { id: 0 });
const Model = trait('alloc/model', { light: 0 });

const sceneTree = createSceneTree();
query(sceneTree, [Mesh, Optional(Up(Model))]);
query(sceneTree, [TransformTrait]);
const container = createNode({ name: 'container' });
addChild(sceneTree.root, container);

function measure(label: string, fn: () => void, iters: number): void {
    for (let i = 0; i < 200; i++) fn();
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < iters; i++) fn();
    const after = process.memoryUsage().heapUsed;
    console.log(`${label.padEnd(46)} ${((after - before) / iters).toFixed(0)} B`);
}

measure('buildTraitInstance(TransformTrait)', () => buildTraitInstance(TransformTrait._def), 20000);
measure('buildTraitInstance(Mesh) [1 field, no syncs]', () => buildTraitInstance(Mesh._def), 20000);
measure('createNode() alone', () => createNode({ name: 'x' }), 20000);

const spare = createNode({ name: 'spare' });
addTrait(spare, TransformTrait);
addTrait(spare, Mesh);
measure(
    'addChild + removeChild, 1 node, 2 traits',
    () => {
        addChild(container, spare);
        removeChild(container, spare);
    },
    20000,
);

function buildProp(): Node {
    const root = createNode({ name: 'prop' });
    addTrait(root, Model);
    for (let i = 0; i < 5; i++) {
        const m = createNode({ name: `m${i}` });
        addTrait(m, Mesh);
        addTrait(m, TransformTrait);
        addChild(root, m);
    }
    return root;
}
const prop = buildProp();
measure(
    'attach + detach a 6-node prop',
    () => {
        addChild(container, prop);
        removeChild(container, prop);
    },
    20000,
);
measure('build a 6-node prop from scratch', () => buildProp(), 5000);
