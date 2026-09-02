// does `_parent` stay correct when a subtree is detached?
// run: node_modules/.bin/tsx bench/probe-detach-resolution.ts

import { TransformTrait } from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree, destroyNode, removeChild } from '../src/core/scene/scene-tree';

const sceneTree = createSceneTree();

const parent = createNode({ name: 'parent' });
addChild(sceneTree.root, parent);
const parentTransform = addTrait(parent, TransformTrait);

const child = createNode({ name: 'child' });
addChild(parent, child);
const childTransform = addTrait(child, TransformTrait);

console.log('attached:   child._parent === parentTransform ?', childTransform._parent === parentTransform);

removeChild(parent, child);
console.log('after removeChild:');
console.log('  child.parent          =', child.parent);
console.log('  child.scene           =', child.scene);
console.log('  child._parent is still parentTransform ?', childTransform._parent === parentTransform);

// and the destroy path
const other = createNode({ name: 'other' });
addChild(parent, other);
const otherTransform = addTrait(other, TransformTrait);
console.log('\nattached:   other._parent === parentTransform ?', otherTransform._parent === parentTransform);
destroyNode(sceneTree, other);
console.log('after destroyNode:');
console.log('  other._parent is still parentTransform ?', otherTransform._parent === parentTransform);
