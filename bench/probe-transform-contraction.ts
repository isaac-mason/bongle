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
//   write — attach+detach the subtree, with and without a self-targeting `my()` registered,
//           so the delta is what maintaining the field actually costs.
//
// Swept over passthrough density, since that is the variable the whole question turns on
// and the one we have never measured on a real scene.
//
// Result, 2000 transforms: the walk costs 1.17-1.32x the field, and barely grows with gap
// depth (5x the hops buys 1.7x the penalty) because `mat4.multiply` dominates, not the
// parent lookup. The maintenance half was measured separately by toggling the declared-
// resolution descent off on this same fixture: ~5-10% of an attach. So materialising
// `_parent` is right — it pays on a per-frame path and costs on a per-spawn one — but the
// margin is 1.2-1.3x, nothing like the 45x `_children` bought for invalidation.
//
// Do NOT compare against a second trait without `my()`: it lands on a different slot, so
// `_traits.length` differs and the fixture measures slot density instead. That comparison
// read `my()` as FASTER than no-`my()`, which is how the confound announced itself.

import { type Mat4, mat4 } from 'math';
import { Ancestor } from '../src/core/scene/conditions';
import { my } from '../src/core/scene/resolutions';
import { addChild, addTrait, createNode, createSceneTree, getTrait, type Node, removeChild } from '../src/core/scene/scene-tree';
import { Self, trait } from '../src/core/scene/traits';

/** stands in for TransformTrait: a local matrix, a cached world, and the maintained parent. */
const Xf = trait('contraction/xf', {
    local: () => mat4.create(),
    world: () => mat4.create(),
    valid: false,
    _parent: my(Ancestor(Self)),
});

const XfSlot = () => Xf._slot;

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
    let cursor: Node | null = t._node.parent;
    let p: any = null;
    while (cursor !== null) {
        const found = cursor._traits[XfSlot()];
        if (found !== undefined) {
            p = found;
            break;
        }
        cursor = cursor.parent;
    }
    if (p === null) mat4.copy(t.world, t.local);
    else mat4.multiply(t.world, worldViaWalk(p), t.local);
    t.valid = true;
    return t.world;
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
                bearers.push(getTrait(n, T));
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
console.log(`${'passthrough gap'.padEnd(18)} ${'read via _parent'.padStart(17)} ${'read via walk'.padStart(14)}  penalty`);
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

    console.log(
        `${String(passthrough).padEnd(18)} ${`${field.toFixed(3)} ms`.padStart(17)} ${`${walk.toFixed(3)} ms`.padStart(14)}  ${(walk / field).toFixed(2)}x`,
    );
    removeChild(sceneTree.root, root);
}
