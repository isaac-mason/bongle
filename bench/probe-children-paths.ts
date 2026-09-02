// is `_children` correct on the paths the fuzz doesn't drive?
// run: node_modules/.bin/tsx bench/probe-children-paths.ts

import { TransformTrait } from '../src/builtins/transform';
import { registry, reindexRegistry } from '../src/core/registry';
import {
    addChild,
    addTrait,
    cloneNode,
    createNode,
    createSceneTree,
    deserializeNode,
    getTrait,
    type Node,
    serializeNode,
} from '../src/core/scene/scene-tree';

reindexRegistry(registry);

function freshChildren(node: Node): unknown[] {
    const out: unknown[] = [];
    const visit = (n: Node) => {
        for (const child of n.children) {
            const t = getTrait(child, TransformTrait);
            if (t) out.push(t);
            else visit(child);
        }
    };
    visit(node);
    return out;
}

function check(label: string, root: Node) {
    let bad = 0;
    let checked = 0;
    const visit = (n: Node) => {
        const t = getTrait(n, TransformTrait);
        if (t) {
            checked++;
            const expected = new Set(freshChildren(n));
            if (t._children.length !== expected.size || t._children.some((c) => !expected.has(c))) bad++;
        }
        for (const c of n.children) visit(c);
    };
    visit(root);
    console.log(`${label.padEnd(38)} ${checked} transforms, ${bad} wrong`);
}

function buildProp(name: string): Node {
    const root = createNode({ name });
    addTrait(root, TransformTrait);
    for (let i = 0; i < 3; i++) {
        const logical = createNode({ name: `${name}-logical${i}` });
        addChild(root, logical);
        const leaf = createNode({ name: `${name}-leaf${i}` });
        addTrait(leaf, TransformTrait);
        addChild(logical, leaf);
    }
    return root;
}

const sceneTree = createSceneTree();
const original = buildProp('orig');
addChild(sceneTree.root, original);
check('built + attached', original);

const clone = cloneNode(original);
addChild(sceneTree.root, clone);
check('cloneNode + attach', clone);

const revived = deserializeNode(serializeNode(original));
addChild(sceneTree.root, revived);
check('deserializeNode + attach', revived);

const detachedClone = cloneNode(original);
check('cloneNode, never attached', detachedClone);
