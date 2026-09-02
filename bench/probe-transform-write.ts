// per-field breakdown of one local transform write.
// run: node_modules/.bin/tsx bench/probe-transform-write.ts

import type { Vec3 } from 'math';
import { setPosition, TransformTrait } from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree } from '../src/core/scene/scene-tree';
import { setSyncDirty } from '../src/core/scene/traits';

const COUNT = 2000;
const sceneTree = createSceneTree();
const transforms: TransformTrait[] = [];
for (let i = 0; i < COUNT; i++) {
    const node = createNode({ name: `n${i}` });
    addChild(sceneTree.root, node);
    transforms.push(addTrait(node, TransformTrait));
}

const p: Vec3 = [1, 2, 3];

function measure(label: string, fn: () => void, iters = 2000): void {
    for (let i = 0; i < 300; i++) fn();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn();
    const t1 = process.hrtime.bigint();
    const perTransformMs = Number(t1 - t0) / 1e6 / iters / COUNT;
    console.log(`${label.padEnd(46)} ${(perTransformMs * 1e6).toFixed(1)} ns / transform`);
}

measure('setPosition (full)', () => {
    for (let i = 0; i < COUNT; i++) setPosition(transforms[i]!, p);
});

measure('position stores only', () => {
    for (let i = 0; i < COUNT; i++) {
        const t = transforms[i]!;
        t.position[0] = p[0];
        t.position[1] = p[1];
        t.position[2] = p[2];
    }
});

measure('position stores + _dirty/_version', () => {
    for (let i = 0; i < COUNT; i++) {
        const t = transforms[i]!;
        t.position[0] = p[0];
        t.position[1] = p[1];
        t.position[2] = p[2];
        t._dirty = 31;
        t._version++;
    }
});

measure('_transformDirty.add, set already warm', () => {
    for (let i = 0; i < COUNT; i++) sceneTree._transformDirty.add(transforms[i]!);
});

measure('_transformDirty.add, drained each pass', () => {
    sceneTree._transformDirty.clear();
    for (let i = 0; i < COUNT; i++) sceneTree._transformDirty.add(transforms[i]!);
});

measure('setSyncDirty x1 (via _sync.dirty word)', () => {
    for (let i = 0; i < COUNT; i++) setSyncDirty(transforms[i]!, 1);
});

measure('read _node.scene', () => {
    let live = 0;
    for (let i = 0; i < COUNT; i++) if (transforms[i]!._node.scene !== null) live++;
    return live;
});
