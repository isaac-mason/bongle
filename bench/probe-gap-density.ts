// How many passthrough (non-TransformTrait) nodes actually sit between a transform and its
// nearest transform ancestor, in a real scene?
//
//   ./node_modules/.bin/tsx bench/probe-gap-density.ts
//
// This is the variable the whole "maintain `_parent` vs walk up" question turns on:
// `probe-transform-contraction.ts` sweeps gap density synthetically and finds the walk
// costs 1.12x at gap 0 and 1.48x at gap 4. Nothing has ever measured where the real scene
// sits on that curve.

import { TransformTrait } from '../src/builtins/transform';
import type { Node } from '../src/core/scene/scene-tree';
import { createWorld } from './discovery-world';

const XF = TransformTrait._slot;

const world = createWorld({ props: 1000, clients: 8 });
const root = world.server.room.scene.root;

/** gap length from `node` up to the nearest transform-bearing ancestor. */
function gapAbove(node: Node): number {
    let gaps = 0;
    for (let cur = node.parent; cur !== null; cur = cur.parent) {
        if (cur._traits[XF] !== undefined) return gaps;
        gaps++;
    }
    return -1; // no transform above at all: a transform root
}

const gapHistogram = new Map<number, number>();
let bearers = 0;
let total = 0;
let deepest = 0;

function visit(node: Node, depth: number): void {
    total++;
    if (depth > deepest) deepest = depth;
    if (node._traits[XF] !== undefined) {
        bearers++;
        const g = gapAbove(node);
        gapHistogram.set(g, (gapHistogram.get(g) ?? 0) + 1);
    }
    for (const child of node.children) visit(child, depth + 1);
}
visit(root, 0);

console.log(`\nscene: ${total} nodes, ${bearers} bear TransformTrait (${((bearers / total) * 100).toFixed(1)}%), depth ${deepest}\n`);
console.log(`${'gap to nearest transform ancestor'.padEnd(36)} ${'transforms'.padStart(11)}   share`);
const keys = [...gapHistogram.keys()].sort((a, b) => a - b);
for (const g of keys) {
    const n = gapHistogram.get(g)!;
    const label = g === -1 ? 'transform root (none above)' : `${g}`;
    console.log(`${label.padEnd(36)} ${String(n).padStart(11)}   ${((n / bearers) * 100).toFixed(1)}%`);
}

// who are the nested ones? name them, so it is clear whether rigs are represented.
const nestedByParentName = new Map<string, number>();
function visitNested(node: Node): void {
    if (node._traits[XF] !== undefined && gapAbove(node) === 0) {
        const key = `${node.parent?.name ?? '?'} > ${node.name}`;
        nestedByParentName.set(key, (nestedByParentName.get(key) ?? 0) + 1);
    }
    for (const child of node.children) visitNested(child);
}
visitNested(root);
console.log('\nthe nested transforms, by parent > child name:');
for (const [k, n] of [...nestedByParentName].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(4)}  ${k}`);
}

const withParent = bearers - (gapHistogram.get(-1) ?? 0);
const zeroGap = gapHistogram.get(0) ?? 0;
console.log(
    `\nof the ${withParent} transforms that have one above them, ${zeroGap} (${((zeroGap / Math.max(withParent, 1)) * 100).toFixed(1)}%) sit directly under it.`,
);
