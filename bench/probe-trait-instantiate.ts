// where building one TransformTrait instance goes.
// run: node_modules/.bin/tsx bench/probe-trait-instantiate.ts

import { TransformTrait } from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree, removeTrait } from '../src/core/scene/scene-tree';
import { buildTraitInstance } from '../src/core/scene/traits';

function measure(label: string, fn: () => void, iters = 20000) {
    for (let i = 0; i < 2000; i++) fn();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn();
    const t1 = process.hrtime.bigint();
    console.log(`${label.padEnd(52)} ${(Number(t1 - t0) / iters).toFixed(0)} ns`);
}

const def = TransformTrait._def;
const bodyEntries = Object.entries(def.body);
console.log('TransformTrait body fields:', bodyEntries.length);
console.log(
    'object-valued (structuredClone) fields:',
    bodyEntries.filter(([, v]) => v !== null && typeof v === 'object' && typeof v !== 'function').length,
);

measure('buildTraitInstance(TransformTrait)', () => {
    buildTraitInstance(def);
});

const src = [0, 0, 0];
measure('structuredClone([0,0,0]) x16', () => {
    for (let i = 0; i < 16; i++) structuredClone(src);
});

measure('slice() x16', () => {
    for (let i = 0; i < 16; i++) src.slice();
});

const sceneTree = createSceneTree();
for (let i = 0; i < 1000; i++) {
    const n = createNode({ name: `n${i}` });
    addChild(sceneTree.root, n);
    addTrait(n, TransformTrait);
}
const churn = createNode({ name: 'churn' });
addChild(sceneTree.root, churn);

measure(
    'addTrait + removeTrait TransformTrait',
    () => {
        addTrait(churn, TransformTrait);
        removeTrait(churn, TransformTrait);
    },
    5000,
);
