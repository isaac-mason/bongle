// do the lazily-allocated fields split TransformTrait's hidden class?
// run: node --allow-natives-syntax --import tsx bench/probe-hidden-class.ts

import { getWorldChunk, setInterpolation, TransformTrait } from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree } from '../src/core/scene/scene-tree';

// %HaveSameMap can't be written in TS source; build it at runtime under --allow-natives-syntax.
const haveSameMap = new Function('a', 'b', 'return %HaveSameMap(a, b);') as (a: object, b: object) => boolean;
const hasFastProperties = new Function('a', 'return %HasFastProperties(a);') as (a: object) => boolean;

const sceneTree = createSceneTree();

function spawn(name: string) {
    const node = createNode({ name });
    addChild(sceneTree.root, node);
    return addTrait(node, TransformTrait);
}

const pristine = spawn('pristine');
const alsoPristine = spawn('alsoPristine');
const enrolled = spawn('enrolled');
setInterpolation(enrolled._node, true);
const chunked = spawn('chunked');
getWorldChunk(chunked);

console.log('fast properties? transform ', hasFastProperties(pristine));
console.log('fast properties? node      ', hasFastProperties(pristine._node));
console.log('fast properties? _sync     ', hasFastProperties(pristine._sync!));
console.log('pristine vs pristine  ', haveSameMap(pristine, alsoPristine));
console.log('pristine vs enrolled  ', haveSameMap(pristine, enrolled));
console.log('pristine vs chunked   ', haveSameMap(pristine, chunked));
console.log('enrolled vs chunked   ', haveSameMap(enrolled, chunked));

const fresh = spawn('fresh');
console.log('fresh (after others)  ', haveSameMap(pristine, fresh));

const pristineNode = createNode({ name: 'p' });
const unresolvedNode = createNode({ name: 'u' });
unresolvedNode._unresolvedTraits = new Map([['x', { json: {} }]]);
const issuesNode = createNode({ name: 'i' });
issuesNode._traitIssues = new Map();
const freshNode = createNode({ name: 'f' });
console.log();
console.log('node: pristine vs unresolved', haveSameMap(pristineNode, unresolvedNode));
console.log('node: pristine vs issues    ', haveSameMap(pristineNode, issuesNode));
console.log('node: pristine vs fresh     ', haveSameMap(pristineNode, freshNode));

const nodes = createSceneTree();
const uniform: TransformTrait[] = [];
const mixed: TransformTrait[] = [];
for (let i = 0; i < 20000; i++) {
    const a = createNode({ name: `u${i}` });
    addChild(nodes.root, a);
    uniform.push(addTrait(a, TransformTrait));
    const b = createNode({ name: `m${i}` });
    addChild(nodes.root, b);
    const t = addTrait(b, TransformTrait);
    if (i % 2 === 0) setInterpolation(b, true);
    mixed.push(t);
}

function readLoop(list: TransformTrait[]): number {
    let acc = 0;
    for (let i = 0; i < list.length; i++) {
        const t = list[i]!;
        acc += t._dirty + t._version + t.position[0]!;
    }
    return acc;
}

function measure(label: string, list: TransformTrait[], iters = 3000) {
    let sink = 0;
    for (let i = 0; i < 300; i++) sink += readLoop(list);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) sink += readLoop(list);
    const t1 = process.hrtime.bigint();
    console.log(`${label.padEnd(34)} ${(Number(t1 - t0) / iters / list.length).toFixed(2)} ns / transform  (${sink % 7})`);
}

console.log();
measure('read loop, none enrolled', uniform);
measure('read loop, half enrolled', mixed);
measure('read loop, none enrolled', uniform);
measure('read loop, half enrolled', mixed);
