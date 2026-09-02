// does removeTraitBySlot re-resolve descendants like removeTrait does?
// run: node_modules/.bin/tsx bench/probe-removetraitbyslot.ts

import { getWorldPosition, TransformTrait } from '../src/builtins/transform';
import {
    addChild,
    addTrait,
    createNode,
    createSceneTree,
    getTrait,
    removeTrait,
    removeTraitBySlot,
} from '../src/core/scene/scene-tree';

function scenario(remove: 'removeTrait' | 'removeTraitBySlot') {
    const sceneTree = createSceneTree();
    const grandparent = createNode({ name: 'grandparent' });
    addChild(sceneTree.root, grandparent);
    const gpTransform = addTrait(grandparent, TransformTrait, { position: [100, 0, 0] });

    const parent = createNode({ name: 'parent' });
    addChild(grandparent, parent);
    addTrait(parent, TransformTrait, { position: [10, 0, 0] });

    const child = createNode({ name: 'child' });
    addChild(parent, child);
    const childTransform = addTrait(child, TransformTrait, { position: [1, 0, 0] });

    console.log(`\n── ${remove} ──`);
    console.log('  before: child world x =', getWorldPosition(childTransform)[0], '(expect 111)');

    if (remove === 'removeTrait') removeTrait(parent, TransformTrait);
    else removeTraitBySlot(parent, TransformTrait._slot);

    const stillThere = getTrait(parent, TransformTrait);
    console.log('  parent still has TransformTrait?', stillThere !== undefined);
    console.log('  child._parent === grandparent transform?', childTransform._parent === gpTransform);
    console.log('  after:  child world x =', getWorldPosition(childTransform)[0], '(expect 101)');
}

scenario('removeTrait');
scenario('removeTraitBySlot');
