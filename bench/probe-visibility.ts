// splits `Visibility.update` into its passes and prints the tree's depth.
// run: NODE_OPTIONS=--expose-gc node_modules/.bin/tsx bench/probe-visibility.ts

import { mat4, type Vec3 } from 'math';
import { box3 } from 'math/shapes';
import { TransformTrait } from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree } from '../src/core/scene/scene-tree';
import * as dbvt from '../src/render/visibility/dbvt';
import * as Visibility from '../src/render/visibility/visibility';

function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function makeCamera(eye: Vec3, target: Vec3, fov = Math.PI / 3) {
    const projectionMatrix = mat4.create();
    mat4.perspectiveZO(projectionMatrix, fov, 16 / 9, 0.1, 2000);
    const world = mat4.create();
    mat4.targetTo(world, eye, target, [0, 1, 0]);
    const matrixWorldInverse = mat4.create();
    mat4.invert(matrixWorldInverse, world);
    return { position: eye, projectionMatrix, matrixWorldInverse, coordinateSystem: 0 } as unknown as Parameters<
        typeof Visibility.update
    >[1];
}

const COUNT = 5000;
const VIEW_RADIUS = 256;

const sceneTree = createSceneTree();
const visibility = Visibility.init();
const random = rng(0x9e3779b9);
const localBox = box3.create();
box3.set(localBox, -0.5, -0.5, -0.5, 0.5, 0.5, 0.5);

// clustered in clumps of 8, the shape a level of props has.
let clusterX = 0;
let clusterY = 0;
let clusterZ = 0;
for (let i = 0; i < COUNT; i++) {
    if (i % 8 === 0) {
        clusterX = (random() - 0.5) * 400;
        clusterY = (random() - 0.5) * 100;
        clusterZ = (random() - 0.5) * 400;
    }
    const node = createNode({ name: `c${i}` });
    addChild(sceneTree.root, node);
    const transform = addTrait(node, TransformTrait);
    transform.position[0] = clusterX + (random() - 0.5) * 8;
    transform.position[1] = clusterY + (random() - 0.5) * 8;
    transform.position[2] = clusterZ + (random() - 0.5) * 8;
    Visibility.add(visibility, localBox, transform);
}

const camera = makeCamera([0, 40, 220], [0, 0, 0]);
Visibility.update(visibility, camera, VIEW_RADIUS);

/** deepest root-to-leaf path, walked independently of the tree's own `height`. */
function measuredDepth(tree: dbvt.Dbvt): { nodes: number; leaves: number; maxDepth: number } {
    let nodes = 0;
    let leaves = 0;
    let maxDepth = 0;
    const stack: Array<[index: number, depth: number]> = [[tree.root, 0]];
    while (stack.length > 0) {
        const [index, depth] = stack.pop()!;
        if (index === -1) continue;
        const node = tree.nodes[index]!;
        nodes++;
        if (depth > maxDepth) maxDepth = depth;
        if (node.left === -1) leaves++;
        else {
            stack.push([node.left, depth + 1]);
            stack.push([node.right, depth + 1]);
        }
    }
    return { nodes, leaves, maxDepth };
}

let visibleCount = 0;
for (const entry of visibility.entries) if (entry.visible) visibleCount++;

console.log('entries', visibility.entries.length, 'visible', visibleCount);
console.log('tree', measuredDepth(visibility.tree), 'reported height', dbvt.height(visibility.tree));
console.log('ideal depth', Math.ceil(Math.log2(COUNT)));

function measure(label: string, fn: () => void, iters: number): void {
    for (let i = 0; i < 200; i++) fn();
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn();
    const t1 = process.hrtime.bigint();
    const after = process.memoryUsage().heapUsed;
    const ms = Number(t1 - t0) / 1e6 / iters;
    console.log(`${label.padEnd(30)} ${ms.toFixed(4)} ms/iter   ${((after - before) / iters).toFixed(0)} B/iter`);
}

measure('full update', () => Visibility.update(visibility, camera, VIEW_RADIUS), 2000);

// pass 1: the refit scan. nothing moves here, so every entry short-circuits —
// this is the floor the frame pays for having things registered at all.
measure(
    'refit scan only',
    () => {
        let moved = 0;
        for (let i = 0; i < visibility.entries.length; i++) {
            if (visibility.transforms[i]!._version === visibility.versions[i]) continue;
            moved++;
        }
        return moved;
    },
    2000,
);

// pass 2: snapshot prev-visible + reset.
measure(
    'snapshot+reset only',
    () => {
        const entries = visibility.entries;
        for (let i = 0; i < entries.length; i++) {
            const cull = entries[i]!;
            cull.wasVisible = cull.visible;
            cull.visible = false;
        }
    },
    2000,
);

// pass 3: the descent.
let leafCallbacks = 0;
measure(
    'frustumCull descent only',
    () => {
        dbvt.frustumCull(visibility.tree, visibility.frustum, 0, 40, 220, VIEW_RADIUS * VIEW_RADIUS, () => {
            leafCallbacks++;
        });
    },
    2000,
);
console.log('leaf callbacks per descent', Math.round(leafCallbacks / 2200));
