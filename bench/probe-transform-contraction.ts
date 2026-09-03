// Is a materialised `_parent` worth its maintenance, versus walking up the node tree?
//
//   ./node_modules/.bin/tsx bench/probe-transform-contraction.ts
//
// A node without a TransformTrait contributes identity to the chain, so skipping it is
// purely an optimisation: walking every node and multiplying by identity gives the same
// answer. That makes this a clean A/B where only the PARENT LOOKUP differs.
//
//   read  — recompute every world matrix, caching parent results either way. The only
//           difference is `t._parent` versus walking `node.parent` to the nearest bearer.
//
// Only the READ half is measured here; the maintenance half is `probe-reparent.ts` and
// `probe-attach-gcdelta.ts` against the real TransformTrait.
//
// Swept over passthrough density, since that is the variable the whole question turns on
// and the one we have never measured on a real scene.
//
// Result, 2000 transforms, against the materialised `_parent`:
//
//   gap   pull+walk   pull+memo   push sweep
//   0        1.16x       1.15x        1.07x
//   1        1.31x       1.23x        1.67x
//   2        1.26x       1.23x        1.63x
//   4        1.32x       1.36x        1.87x
//
// The pull variants only visit bearers but pay a lookup each; the push sweep pays no lookup
// at all but visits every passthrough node. They therefore fail in OPPOSITE directions, and
// the best non-`_parent` design depends entirely on passthrough density. With no gaps the
// sweep is within 7% of `_parent` while needing no maintenance, no field and nothing to
// invalidate.
//
// The maintenance half was measured separately on this same fixture: ~5-10% of an attach.
// So materialising `_parent` is right — it pays per frame and costs per spawn — but the
// margin is 1.07-1.33x, nothing like the 45x `_children` bought for invalidation.
//
// Memoising the walk (path compression on the gap nodes) does NOT help: the compression pass
// costs about what it saves.
//
// Do NOT compare against a second trait that does not maintain `_parent`: it lands on a
// different slot, so `_traits.length` differs and the fixture measures slot density
// instead. That comparison read the maintained field as FASTER than the unmaintained one,
// which is how the confound announced itself.

import { type Mat4, mat4 } from 'math';
import { addChild, addTrait, createNode, createSceneTree, getTrait, type Node, removeChild } from '../src/core/scene/scene-tree';
import { trait } from '../src/core/scene/traits';

/** stands in for TransformTrait: a local matrix, a cached world, and the maintained parent.
 *  `_parent` is filled by hand here; the real trait's is maintained by
 *  `resolveTransformSubtree`, which this probe is not measuring. */
const Xf = trait('contraction/xf', {
    local: () => mat4.create(),
    world: () => mat4.create(),
    valid: false,
    _parent: null as any,
});

const XF_SLOT = Xf._slot;

/** the field path: parent comes straight off the trait. */
function worldViaField(t: any): Mat4 {
    if (t.valid) return t.world;
    const p = t._parent;
    if (p === null) mat4.copy(t.world, t.local);
    else mat4.multiply(t.world, worldViaField(p), t.local);
    t.valid = true;
    return t.world;
}

/** the walk path: identical algorithm, parent found by climbing the node tree. */
function worldViaWalk(t: any): Mat4 {
    if (t.valid) return t.world;
    let p: any = null;
    for (let cursor: Node | null = t._node.parent; cursor !== null; cursor = cursor.parent) {
        const found = cursor._traits[XF_SLOT];
        if (found !== undefined) {
            p = found;
            break;
        }
    }
    if (p === null) mat4.copy(t.world, t.local);
    else mat4.multiply(t.world, worldViaWalk(p), t.local);
    t.valid = true;
    return t.world;
}

/**
 * the memoised walk: same climb, but each passthrough node caches the bearer it landed on,
 * so a second transform under the same run of gaps short-circuits. Union-find style path
 * compression; the cache is per-run, cleared with the fixture.
 */
function worldViaMemoWalk(t: any): Mat4 {
    if (t.valid) return t.world;
    let p: any = null;
    const start: Node | null = t._node.parent;
    for (let cursor: Node | null = start; cursor !== null; cursor = cursor.parent) {
        const memo = (cursor as any)._xfMemo;
        if (memo !== undefined) {
            p = memo;
            break;
        }
        const found = cursor._traits[XF_SLOT];
        if (found !== undefined) {
            p = found;
            break;
        }
    }
    // compress: point every gap we crossed straight at the answer.
    for (let cursor: Node | null = start; cursor !== null && cursor._traits[XF_SLOT] === undefined; cursor = cursor.parent) {
        (cursor as any)._xfMemo = p;
    }
    if (p === null) mat4.copy(t.world, t.local);
    else mat4.multiply(t.world, worldViaMemoWalk(p), t.local);
    t.valid = true;
    return t.world;
}

/**
 * push, not pull: one top-down sweep of the NODE tree carrying the running world matrix.
 * A node without the trait passes its parent's value straight through — the identity case,
 * made literal — so there is no parent lookup anywhere, and no per-transform recursion.
 */
function sweep(node: Node, parentWorld: Mat4 | null): void {
    const t: any = node._traits[XF_SLOT];
    let childWorld = parentWorld;
    if (t !== undefined) {
        if (parentWorld === null) mat4.copy(t.world, t.local);
        else mat4.multiply(t.world, parentWorld, t.local);
        t.valid = true;
        childWorld = t.world;
    }
    const children = node.children;
    for (let i = 0; i < children.length; i++) sweep(children[i]!, childWorld);
}

const TRANSFORMS = 2000;

/** a tree of `TRANSFORMS` bearers, with `passthrough` plain nodes inserted between each. */
function build(passthrough: number, branch: number, T: any = Xf): { root: Node; bearers: any[] } {
    const root = createNode({ name: 'root' });
    addTrait(root, T);
    const bearers: any[] = [getTrait(root, T)];
    let frontier: Node[] = [root];
    while (bearers.length < TRANSFORMS) {
        const next: Node[] = [];
        for (const parent of frontier) {
            for (let b = 0; b < branch && bearers.length < TRANSFORMS; b++) {
                let attachTo = parent;
                for (let p = 0; p < passthrough; p++) {
                    const gap = createNode({ name: 'gap' });
                    addChild(attachTo, gap);
                    attachTo = gap;
                }
                const n = createNode({ name: 'xf' });
                addTrait(n, T);
                addChild(attachTo, n);
                const t: any = getTrait(n, T);
                // this fixture's trait is synthetic, so fill the contracted parent by hand.
                for (let cursor: Node | null = attachTo; cursor !== null; cursor = cursor.parent) {
                    const found = cursor._traits[XF_SLOT];
                    if (found !== undefined) {
                        t._parent = found;
                        break;
                    }
                }
                bearers.push(t);
                next.push(n);
            }
        }
        if (next.length === 0) break;
        frontier = next;
    }
    return { root, bearers };
}

function best(fn: () => void, reps: number): number {
    for (let i = 0; i < 30; i++) fn();
    let b = Infinity;
    for (let r = 0; r < reps; r++) {
        const t0 = process.hrtime.bigint();
        fn();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms < b) b = ms;
    }
    return b;
}

console.log(`${TRANSFORMS} transforms, branching 4\n`);
console.log(
    `${'gap'.padEnd(5)} ${'_parent'.padStart(9)} ${'walk'.padStart(9)} ${'memo'.padStart(9)} ${'sweep'.padStart(9)}   walk  memo  sweep`,
);
for (const passthrough of [0, 1, 2, 4]) {
    const sceneTree = createSceneTree();
    const { root, bearers } = build(passthrough, 4);
    addChild(sceneTree.root, root);

    const invalidate = () => {
        for (let i = 0; i < bearers.length; i++) bearers[i].valid = false;
    };
    const field = best(() => {
        invalidate();
        for (let i = 0; i < bearers.length; i++) worldViaField(bearers[i]);
    }, 200);
    const walk = best(() => {
        invalidate();
        for (let i = 0; i < bearers.length; i++) worldViaWalk(bearers[i]);
    }, 200);
    const memo = best(() => {
        invalidate();
        for (let i = 0; i < bearers.length; i++) worldViaMemoWalk(bearers[i]);
    }, 200);
    const push = best(() => {
        invalidate();
        sweep(root, null);
    }, 200);

    console.log(
        `${String(passthrough).padEnd(5)} ${field.toFixed(3).padStart(9)} ${walk.toFixed(3).padStart(9)} ${memo.toFixed(3).padStart(9)} ${push.toFixed(3).padStart(9)}   ${`${(walk / field).toFixed(2)}x`} ${`${(memo / field).toFixed(2)}x`} ${`${(push / field).toFixed(2)}x`}`,
    );
    removeChild(sceneTree.root, root);
}
