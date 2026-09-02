// gc-delta cross-check for attach+detach allocation.
//   node --expose-gc ./node_modules/.bin/tsx bench/probe-attach-gcdelta.ts [resolutions]
import { Optional, Up } from '../src/core/scene/conditions';
import { addChild, addTrait, createNode, createSceneTree, type Node, query, removeChild } from '../src/core/scene/scene-tree';
import { trait } from '../src/core/scene/traits';

const RESOLUTIONS = Number(process.argv[2] ?? 0);
const ModelTrait = trait('probe/model', { id: 0 });
const MeshTrait = trait('probe/mesh', { id: 0 });

function buildProp(children: number): Node {
    const root = createNode({ name: 'prop' });
    addTrait(root, ModelTrait);
    for (let i = 0; i < children; i++) {
        const c = createNode({ name: `mesh${i}` });
        addTrait(c, MeshTrait);
        addChild(root, c);
    }
    return root;
}

const sceneTree = createSceneTree();
for (let i = 0; i < RESOLUTIONS; i++) query(sceneTree, [MeshTrait, Optional(Up(ModelTrait))]);
const container = createNode({ name: 'container' });
for (let i = 0; i < 200; i++) addChild(container, buildProp(5));

for (let i = 0; i < 200; i++) {
    addChild(sceneTree.root, container);
    removeChild(sceneTree.root, container);
}

addChild(sceneTree.root, container);
console.log(`  sanity: sceneTree.nodes after attach = ${sceneTree.nodes.size}, container.parent=${container.parent?.name}`);
removeChild(sceneTree.root, container);
console.log(`  sanity: sceneTree.nodes after detach = ${sceneTree.nodes.size}`);

const gc = (globalThis as any).gc as () => void;
gc();
gc();
const before = process.memoryUsage().heapUsed;
const t0 = process.hrtime.bigint();
const ITERS = 500;
for (let i = 0; i < ITERS; i++) {
    addChild(sceneTree.root, container);
    removeChild(sceneTree.root, container);
}
const t1 = process.hrtime.bigint();
const afterLive = process.memoryUsage().heapUsed;
gc();
gc();
const after = process.memoryUsage().heapUsed;

console.log(`resolutions=${RESOLUTIONS}`);
console.log(
    `  time            ${(Number(t1 - t0) / 1e6 / ITERS).toFixed(2)} ms/cycle  (${(Number(t1 - t0) / ITERS / 1200).toFixed(0)} ns/node)`,
);
console.log(
    `  heap before gc  ${((afterLive - before) / 1024 / ITERS).toFixed(1)} kb/cycle  = ${((afterLive - before) / ITERS / 1200).toFixed(0)} B/node`,
);
console.log(`  retained after  ${((after - before) / 1024 / ITERS).toFixed(2)} kb/cycle`);
