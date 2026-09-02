// node walk + getTrait vs a maintained TransformTrait[] child list.
// run: node_modules/.bin/tsx bench/probe-transform-walk.ts

import { markTransformDirty, TransformTrait } from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree, getTrait, type Node } from '../src/core/scene/scene-tree';

const TRANSFORM_SLOT = TransformTrait._slot;

/** a subtree `width` wide under one root, with `passthrough` trait-less nodes
 *  inserted between the root and each transform child. */
function buildFan(width: number, passthrough: number): { root: Node; rootTransform: TransformTrait } {
    const sceneTree = createSceneTree();
    const root = createNode({ name: 'root' });
    addChild(sceneTree.root, root);
    const rootTransform = addTrait(root, TransformTrait);
    for (let i = 0; i < width; i++) {
        let cursor: Node = root;
        for (let p = 0; p < passthrough; p++) {
            const logical = createNode({ name: `p${i}_${p}` });
            addChild(cursor, logical);
            cursor = logical;
        }
        const child = createNode({ name: `c${i}` });
        addChild(cursor, child);
        addTrait(child, TransformTrait);
    }
    return { root, rootTransform };
}

/** the child list `TransformTrait._children` would hold: nearest transforms
 *  below, passthrough nodes already skipped. */
function transformChildren(node: Node, out: TransformTrait[]): TransformTrait[] {
    for (const child of node.children) {
        const t = getTrait(child, TransformTrait);
        if (t) out.push(t);
        else transformChildren(child, out);
    }
    return out;
}

// ── the two walks, doing identical work per transform ──────────────

function walkNodes(node: Node, acc: { n: number }): void {
    for (const child of node.children) {
        const t = child._traits[TRANSFORM_SLOT] as TransformTrait | undefined;
        if (t !== undefined) {
            t._version++;
            acc.n++;
            walkNodes(child, acc);
        } else {
            walkNodes(child, acc);
        }
    }
}

/** with a maintained list: iterate transforms directly. */
function walkTransforms(children: TransformTrait[], acc: { n: number }): void {
    for (let i = 0; i < children.length; i++) {
        const t = children[i]!;
        t._version++;
        acc.n++;
    }
}

/** the accumulator is returned so the walk can't be eliminated as dead code. */
function measure(label: string, fn: () => number, iters: number): number {
    let sink = 0;
    for (let i = 0; i < Math.min(iters, 2000); i++) sink += fn();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) sink += fn();
    const t1 = process.hrtime.bigint();
    console.log(`${label.padEnd(52)} ${(Number(t1 - t0) / 1e3 / iters).toFixed(3)} µs`);
    return sink;
}

let keepAlive = 0;

for (const passthrough of [0, 2]) {
    for (const width of [64, 512]) {
        const fixture = buildFan(width, passthrough);
        const children = transformChildren(fixture.root, []);
        const acc = { n: 0 };
        const iters = width >= 512 ? 5000 : 20000;

        console.log(`\n── fan of ${width}, ${passthrough} passthrough nodes per child ──`);
        keepAlive += measure(
            'walk node.children + trait lookup',
            () => {
                walkNodes(fixture.root, acc);
                return acc.n;
            },
            iters,
        );
        keepAlive += measure(
            'walk a maintained TransformTrait[] child list',
            () => {
                walkTransforms(children, acc);
                return acc.n;
            },
            iters,
        );
        keepAlive += measure(
            'real markTransformDirty on the root (for scale)',
            () => {
                markTransformDirty(fixture.rootTransform);
                fixture.rootTransform._dirty = 0;
                return 1;
            },
            iters,
        );
    }
}

if (keepAlive === -1) console.log('unreachable');
