// The read path, on a real scene: does deriving the parent transform cost more than storing it?
//
//   ./node_modules/.bin/tsx bench/probe-world-read.ts
//
// `probe-transform-contraction.ts` answers this synthetically and sweeps passthrough
// density. This runs the real `TransformTrait` over the real `discovery-world` fixture,
// whose shape `probe-gap-density.ts` reports as 99.9% bearer density, zero passthrough
// nodes, and 92.6% transform roots.
//
// Three cases, because they load the walk differently:
//   cache hit    every transform clean; the walk never runs (short-circuit before it)
//   all dirty    every transform invalidated, then every world matrix read
//   rigs only    invalidate the 8 player rigs and read them, the realistic per-frame shape

import { getWorldMatrix, markTransformDirty, TRANSFORM_DIRTY_ALL, TransformTrait } from '../src/builtins/transform';
import type { Node } from '../src/core/scene/scene-tree';
import { createWorld } from './discovery-world';

const XF = TransformTrait._slot;

const world = createWorld({ props: 1000, clients: 8 });
const root = world.server.room.scene.root;

const all: any[] = [];
const rigParts: any[] = [];
function collect(node: Node, underRig: boolean): void {
    const t = node._traits[XF];
    if (t !== undefined) {
        all.push(t);
        if (underRig) rigParts.push(t);
    }
    for (const child of node.children) collect(child, underRig || node.name.startsWith('player:'));
}
collect(root, false);

function best(fn: () => void, reps: number): number {
    for (let i = 0; i < 20; i++) fn();
    let b = Infinity;
    for (let r = 0; r < reps; r++) {
        const t0 = process.hrtime.bigint();
        fn();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms < b) b = ms;
    }
    return b;
}

const invalidate = (set: any[]) => {
    for (let i = 0; i < set.length; i++) set[i]._dirty = TRANSFORM_DIRTY_ALL;
};

// warm every cache first
for (let i = 0; i < all.length; i++) getWorldMatrix(all[i]);

const cacheHit = best(() => {
    for (let i = 0; i < all.length; i++) getWorldMatrix(all[i]);
}, 400);

const allDirty = best(() => {
    invalidate(all);
    for (let i = 0; i < all.length; i++) getWorldMatrix(all[i]);
}, 400);

const rigs = best(() => {
    invalidate(rigParts);
    for (let i = 0; i < rigParts.length; i++) getWorldMatrix(rigParts[i]);
}, 2000);

const writeThenRead = best(() => {
    for (let i = 0; i < rigParts.length; i++) markTransformDirty(rigParts[i]);
    for (let i = 0; i < rigParts.length; i++) getWorldMatrix(rigParts[i]);
}, 2000);

console.log(`\n${all.length} transforms (${rigParts.length} rig parts), scene from discovery-world\n`);
console.log(`${'getWorldMatrix, all clean (cache hit)'.padEnd(44)} ${cacheHit.toFixed(4).padStart(9)} ms`);
console.log(`${'getWorldMatrix, all invalidated'.padEnd(44)} ${allDirty.toFixed(4).padStart(9)} ms`);
console.log(`${'getWorldMatrix, rig parts invalidated'.padEnd(44)} ${rigs.toFixed(4).padStart(9)} ms`);
console.log(`${'markTransformDirty + read, rig parts'.padEnd(44)} ${writeThenRead.toFixed(4).padStart(9)} ms`);
