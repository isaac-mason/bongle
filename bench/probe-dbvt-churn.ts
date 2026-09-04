// What does the culler cost when every proxy moves every frame?
//
//   ./node_modules/.bin/tsx bench/probe-dbvt-churn.ts [chars]
//
// `Visibility.update` re-inserts a proxy whenever its transform `_version` changed AND
// the new world AABB escapes the fat one dbvt stored (`box3.containsBox3` early-out).
// For a procedurally animated character every bone is rewritten every frame, so at 1000
// characters that is ~7000 candidate proxies per frame.
//
// Three arms, same 7 proxies per character:
//   settled  nothing moved: pays the version check only (the real early-out)
//   jitter   each proxy wiggles inside dbvt's expansion margin: pays transformMat4 +
//            containsBox3, then early-outs before touching the tree
//   running  each proxy moves a full body-length: escapes the margin, so remove+insert

import { box3 } from 'math/shapes';
import * as dbvt from '../src/render/visibility/dbvt';

const CHARS = Number(process.argv[2] ?? 1000);
const PER_CHAR = 7;
const COUNT = CHARS * PER_CHAR;

let seed = 0x9e3779b9;
const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
};

const tree = dbvt.create();
const leaves: number[] = [];
const boxes: any[] = [];
const bases: number[][] = [];
for (let i = 0; i < COUNT; i++) {
    const x = random() * 400 - 200;
    const y = random() * 40;
    const z = random() * 400 - 200;
    bases.push([x, y, z]);
    const b = box3.create();
    box3.set(b, x - 0.25, y - 0.25, z - 0.25, x + 0.25, y + 0.25, z + 0.25);
    boxes.push(b);
    leaves.push(dbvt.add(tree, b, i));
}

let tick = 0;
function frame(amplitude: number): void {
    tick++;
    for (let i = 0; i < COUNT; i++) {
        const base = bases[i]!;
        const dx = Math.sin(tick * 0.05 + i) * amplitude;
        const b = boxes[i]!;
        box3.set(b, base[0]! + dx - 0.25, base[1]! - 0.25, base[2]! - 0.25, base[0]! + dx + 0.25, base[1]! + 0.25, base[2]! + 0.25);
        dbvt.update(tree, leaves[i]!, b);
    }
}

function best(fn: () => void, reps: number): number {
    for (let i = 0; i < 15; i++) fn();
    let b = Infinity;
    for (let r = 0; r < reps; r++) {
        const t0 = process.hrtime.bigint();
        fn();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms < b) b = ms;
    }
    return b;
}

console.log(`\n${CHARS} characters x ${PER_CHAR} proxies = ${COUNT} dbvt leaves. best-of; budget 16.67 ms/frame\n`);
for (const [label, amp] of [['jitter (inside margin)', 0.01], ['running (escapes margin)', 2.0]] as Array<[string, number]>) {
    const ms = best(() => frame(amp), 30);
    console.log(`  ${label.padEnd(26)} ${ms.toFixed(3).padStart(8)} ms/frame   height ${dbvt.height(tree)}`);
}
console.log();
