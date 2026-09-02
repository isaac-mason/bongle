// retained-instance measurement of a TransformTrait's heap cost.
// run: NODE_OPTIONS=--expose-gc node_modules/.bin/tsx bench/probe-transform-size.ts

import { setInterpolation, TransformTrait } from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree } from '../src/core/scene/scene-tree';
import { buildTraitInstance } from '../src/core/scene/traits';

function retainedBytes(label: string, fn: () => unknown, count = 200000): void {
    const keep: unknown[] = new Array(count);
    for (let i = 0; i < 2000; i++) fn();
    global.gc?.();
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < count; i++) keep[i] = fn();
    global.gc?.();
    const after = process.memoryUsage().heapUsed;
    console.log(`${label.padEnd(42)} ${((after - before) / count).toFixed(0)} B`, keep.length > 0 ? '' : '');
}

retainedBytes('calibration: {} empty object', () => ({}));
retainedBytes('calibration: 25 number fields', () => ({
    a: 0,
    b: 0,
    c: 0,
    d: 0,
    e: 0,
    f: 0,
    g: 0,
    h: 0,
    i: 0,
    j: 0,
    k: 0,
    l: 0,
    m: 0,
    n: 0,
    o: 0,
    p: 0,
    q: 0,
    r: 0,
    s: 0,
    t: 0,
    u: 0,
    v: 0,
    w: 0,
    x: 0,
    y: 0,
}));
retainedBytes('calibration: [0,0,0]', () => [0, 0, 0]);
retainedBytes('calibration: mat4 (16 numbers)', () => new Array(16).fill(0));
retainedBytes('calibration: new Uint32Array(1)', () => new Uint32Array(1));
retainedBytes('calibration: new Float64Array(4)', () => new Float64Array(4));
retainedBytes('calibration: new Array(4)', () => new Array(4));
retainedBytes('_sync block (3 allocs + object)', () => ({
    dirty: new Uint32Array(1),
    bytes: new Array(4),
    versions: new Float64Array(4),
    traitVersion: 0,
}));
retainedBytes('TransformTrait instance', () => buildTraitInstance(TransformTrait._def));

const sceneTree = createSceneTree();
retainedBytes('node + TransformTrait, not enrolled', () => {
    const node = createNode({ name: 'n' });
    addChild(sceneTree.root, node);
    return addTrait(node, TransformTrait);
});

const enrolledTree = createSceneTree();
retainedBytes('node + TransformTrait, enrolled', () => {
    const node = createNode({ name: 'n' });
    addChild(enrolledTree.root, node);
    const t = addTrait(node, TransformTrait);
    setInterpolation(node, true);
    return t;
});
