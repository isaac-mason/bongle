// does registering a subtree fill deferred Optional hierarchy tuple slots below a bearer?
// run: node_modules/.bin/tsx bench/probe-defer-fill.ts

import { Optional, Up } from '../src/core/scene/conditions';
import { addChild, addTrait, createNode, createSceneTree, query, removeChild } from '../src/core/scene/scene-tree';
import { trait } from '../src/core/scene/traits';

const Mesh = trait('defer/mesh', { id: 0 });
const Model = trait('defer/model', { light: 0 });

const sceneTree = createSceneTree();
const q = query(sceneTree, [Mesh, Optional(Up(Model))]);

function buildProp() {
    const root = createNode({ name: 'prop' });
    addTrait(root, Model);
    addTrait(root, Mesh);
    for (let i = 0; i < 3; i++) {
        const m = createNode({ name: `mesh${i}` });
        addTrait(m, Mesh);
        addChild(root, m);
    }
    return root;
}

function report(label: string) {
    console.log(`\n${label}`);
    for (let i = 0; i < q.matchNodes.length; i++) {
        const node = q.matchNodes[i]!;
        const slot = (q.matches[i] as unknown[])[1];
        console.log(`  ${String(node.name).padEnd(8)} Up(Model) = ${slot === null ? 'null' : 'Model'}`);
    }
}

// (1) attach the whole prop in one go — the scene-load shape
const prop = buildProp();
addChild(sceneTree.root, prop);
report('attached as a whole subtree (expect every mesh to see Model):');

// (2) same nodes, built incrementally in-tree
removeChild(sceneTree.root, prop);
const root2 = createNode({ name: 'prop2' });
addChild(sceneTree.root, root2);
addTrait(root2, Model);
addTrait(root2, Mesh);
for (let i = 0; i < 3; i++) {
    const m = createNode({ name: `m2_${i}` });
    addChild(root2, m);
    addTrait(m, Mesh);
}
report('built incrementally while already in-tree:');
