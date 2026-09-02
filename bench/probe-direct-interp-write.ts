// does writing interpolatedWorld* directly survive to the next getter read?
// run: node_modules/.bin/tsx bench/probe-direct-interp-write.ts

import {
    getVisualWorldPosition,
    markInterpolatedDescendantsDirty,
    setInterpolation,
    setPosition,
    TransformTrait,
} from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree } from '../src/core/scene/scene-tree';

function report(label: string, t: TransformTrait) {
    t.interpolatedWorldPosition[0] = 999;
    t.interpolatedWorldPosition[1] = 999;
    t.interpolatedWorldPosition[2] = 999;
    const read = getVisualWorldPosition(t);
    console.log(
        `${label.padEnd(46)} _interpolated=${t._interpolated} interpolate=${t.interpolate}  ` +
            `getter returns [${read[0]}, ${read[1]}, ${read[2]}]  ${read[0] === 999 ? 'WRITE SURVIVED' : 'write ignored'}`,
    );
}

{
    const sceneTree = createSceneTree();
    const node = createNode({ name: 'plain' });
    addChild(sceneTree.root, node);
    const t = addTrait(node, TransformTrait);
    setPosition(t, [1, 2, 3]);
    report('not enrolled', t);
}

{
    const sceneTree = createSceneTree();
    const node = createNode({ name: 'enrolled' });
    addChild(sceneTree.root, node);
    const t = addTrait(node, TransformTrait);
    setPosition(t, [1, 2, 3]);
    setInterpolation(node, true);
    t._interpolated = 1;
    report('enrolled, dirty after a setPosition', t);
}

{
    const sceneTree = createSceneTree();
    const parent = createNode({ name: 'parent' });
    addChild(sceneTree.root, parent);
    const pt = addTrait(parent, TransformTrait);
    setInterpolation(parent, true);
    const child = createNode({ name: 'child' });
    addChild(parent, child);
    const ct = addTrait(child, TransformTrait);
    setPosition(ct, [1, 2, 3]);
    markInterpolatedDescendantsDirty(pt);
    report('descendant of an interpolating node', ct);
}
