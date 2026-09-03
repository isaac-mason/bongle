// What would an always-present TransformTrait cost, and what would it erase?
//
//   ./node_modules/.bin/tsx --expose-gc bench/probe-always-transform.ts
//
// Three questions:
//   1. bytes per TransformTrait, i.e. what a logical container node would start paying
//   2. how many nodes in a real scene currently have no transform (the ones that'd gain one)
//   3. how many transforms hold an identity local TRS (what an identity fast path would catch)

import { quat, vec3 } from 'math';
import { TransformTrait } from '../src/builtins/transform';
import { addChild, addTrait, createNode, type Node } from '../src/core/scene/scene-tree';
import { createWorld } from './discovery-world';

const XF = TransformTrait._slot;

// ── 1. bytes per transform ──────────────────────────────────────────────
const N = 20000;
function measure(withTransform: boolean): number {
    gc();
    const before = process.memoryUsage().heapUsed;
    const held: Node[] = [];
    const root = createNode({ name: 'root' });
    for (let i = 0; i < N; i++) {
        const n = createNode({ name: 'n' });
        addChild(root, n);
        if (withTransform) addTrait(n, TransformTrait);
        held.push(n);
    }
    const after = process.memoryUsage().heapUsed;
    if (held.length !== N) throw new Error('unreachable');
    return (after - before) / N;
}
const bare = measure(false);
const withXf = measure(true);

console.log(`\nper node, ${N} nodes`);
console.log(`  node alone                 ${bare.toFixed(0).padStart(6)} B`);
console.log(`  node + TransformTrait      ${withXf.toFixed(0).padStart(6)} B`);
console.log(`  the trait itself           ${(withXf - bare).toFixed(0).padStart(6)} B`);

// ── 2 + 3. what a real scene looks like ─────────────────────────────────
const world = createWorld({ props: 1000, clients: 8 });
const root = world.server.room.scene.root;

let total = 0;
let bearers = 0;
let identityLocal = 0;
const noTransform: string[] = [];
const IDENT_Q = quat.create();
const ONE = vec3.fromValues(1, 1, 1);
const ZERO = vec3.create();

function visit(node: Node): void {
    total++;
    const t = node._traits[XF] as any;
    if (t === undefined) {
        noTransform.push(node.name);
    } else {
        bearers++;
        if (vec3.equals(t.position, ZERO) && quat.equals(t.quaternion, IDENT_Q) && vec3.equals(t.scale, ONE)) identityLocal++;
    }
    for (const child of node.children) visit(child);
}
visit(root);

console.log(`\nreal scene: ${total} nodes, ${bearers} with a transform`);
console.log(`  would GAIN a transform:    ${total - bearers}  (${noTransform.slice(0, 8).join(', ')})`);
console.log(`  identity local TRS:        ${identityLocal}  (${((identityLocal / bearers) * 100).toFixed(1)}% of bearers)`);
console.log(`  added memory if always-on: ${((((total - bearers) * (withXf - bare)) / 1024)).toFixed(1)} kB`);
