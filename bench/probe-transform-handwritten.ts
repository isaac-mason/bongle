// context()-driven `_parent`/`_children` versus maintaining them by hand.
//
//   NODE_OPTIONS=--expose-gc ./node_modules/.bin/tsx bench/probe-transform-handwritten.ts
//
// Both arms do the SAME work and leave the SAME state; only the plumbing differs. The
// hand-written arm runs with `registry.resolutionGroups` emptied so context() is out of the
// picture, and mirrors `resolveFrom` exactly: climb once to the nearest transform above the
// attach point, then descend, pruning at each bearer because everything below it already
// points there.

import { TransformTrait } from '../src/builtins/transform';
import { registry } from '../src/core/registry';
import { addChild, addTrait, createNode, createSceneTree, getTrait, type Node, removeChild } from '../src/core/scene/scene-tree';
import { trait } from '../src/core/scene/traits';

const Plain = trait('handwritten/plain', { n: 0 });
const NODES = 1200;
const XF = TransformTrait._slot;

type Xf = { _parent: Xf | null; _children: Xf[] };

function nearestTransformAbove(node: Node | null): Xf | null {
    for (let cur = node; cur !== null; cur = cur.parent) {
        const t = cur._traits[XF];
        if (t !== undefined) return t as unknown as Xf;
    }
    return null;
}

/** mirrors resolveFrom: write the bearer and stop, since below it nothing changed. */
function descend(node: Node, inherited: Xf | null, attaching: boolean): void {
    const own = node._traits[XF] as unknown as Xf | undefined;
    if (own !== undefined) {
        const prev = own._parent;
        if (prev !== inherited) {
            if (prev !== null) {
                const i = prev._children.indexOf(own);
                if (i !== -1) {
                    prev._children[i] = prev._children[prev._children.length - 1]!;
                    prev._children.pop();
                }
            }
            own._parent = inherited;
            if (inherited !== null) inherited._children.push(own);
        }
        return;
    }
    const children = node.children;
    for (let i = 0; i < children.length; i++) descend(children[i]!, inherited, attaching);
}

function build(transformEvery: number): Node {
    const root = createNode({ name: 'sub' });
    addTrait(root, transformEvery === 1 ? TransformTrait : Plain);
    let made = 1;
    let frontier: Node[] = [root];
    while (made < NODES) {
        const next: Node[] = [];
        for (const parent of frontier) {
            for (let b = 0; b < 4 && made < NODES; b++) {
                const n = createNode({ name: `n${made++}` });
                addTrait(n, transformEvery > 0 && made % transformEvery === 0 ? TransformTrait : Plain);
                addChild(parent, n);
                next.push(n);
            }
        }
        if (next.length === 0) break;
        frontier = next;
    }
    return root;
}

function best(fn: () => void, reps = 150): number {
    for (let i = 0; i < 40; i++) fn();
    let b = Infinity;
    for (let r = 0; r < reps; r++) {
        const t0 = process.hrtime.bigint();
        fn();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms < b) b = ms;
    }
    return b;
}

function measure(label: string, transformEvery: number) {
    const sceneTree = createSceneTree();
    const sub = build(transformEvery);
    const real = registry.resolutionGroups;

    const viaContext = () => {
        addChild(sceneTree.root, sub);
        removeChild(sceneTree.root, sub);
    };
    const byHand = () => {
        addChild(sceneTree.root, sub);
        descend(sub, nearestTransformAbove(sceneTree.root), true);
        removeChild(sceneTree.root, sub);
        descend(sub, null, false);
    };

    const ctx = best(viaContext);
    registry.resolutionGroups = [];
    const hand = best(byHand);
    registry.resolutionGroups = real;

    // both arms must leave the same state
    const t = getTrait(sub, TransformTrait);
    const parentOk = t === undefined || t._parent === null;

    console.log(
        `${label.padEnd(30)} ${ctx.toFixed(3).padStart(9)} ms ${hand.toFixed(3).padStart(11)} ms   ` +
            `${(ctx / hand).toFixed(2)}x${parentOk ? '' : '  (STATE MISMATCH)'}`,
    );
}

console.log(`attach+detach ${NODES} nodes, maintaining _parent/_children\n`);
console.log(`${'subtree'.padEnd(30)} ${'context()'.padStart(12)} ${'by hand'.padStart(14)}   ratio`);
measure('1 transform in 8', 8);
measure('1 transform in 3', 3);
measure('every node a transform', 1);
