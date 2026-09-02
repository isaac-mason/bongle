// fuzzes every mutation and checks `_parent` against a freshly-walked answer.
// run: node_modules/.bin/tsx bench/probe-resolution-audit.ts

import { TransformTrait } from '../src/builtins/transform';
import {
    addChild,
    addTrait,
    createNode,
    createSceneTree,
    destroyNode,
    getTrait,
    type Node,
    removeChild,
    removeTrait,
    reparent,
    type SceneTree,
} from '../src/core/scene/scene-tree';

function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/** the answer the resolution is supposed to hold: nearest TransformTrait strictly above. */
function freshParent(node: Node): TransformTrait | null {
    let cursor = node.parent;
    while (cursor !== null) {
        const t = getTrait(cursor, TransformTrait);
        if (t) return t;
        cursor = cursor.parent;
    }
    return null;
}

type Violation = { where: string; op: string; node: string; live: boolean };

function check(root: Node, op: string, out: Violation[]): void {
    const stack: Node[] = [root];
    while (stack.length > 0) {
        const node = stack.pop()!;
        const t = getTrait(node, TransformTrait);
        if (t && t._parent !== freshParent(node)) {
            out.push({ where: 'in-tree', op, node: node.name ?? '?', live: node.scene !== null });
        }
        for (const child of node.children) stack.push(child);
    }
}

/** every node ever created, so detached ones get audited too. */
const allNodes: Node[] = [];
/** nodes put through `destroyNode`, which discards them outright. */
const destroyedNodes = new Set<Node>();
const staleDetached = new Set<Node>();

function makeNode(sceneTree: SceneTree, name: string, withTransform: boolean): Node {
    const node = createNode({ name });
    if (withTransform) addTrait(node, TransformTrait);
    allNodes.push(node);
    return node;
}

function checkDetached(op: string, out: Violation[]): void {
    for (const node of allNodes) {
        if (node.scene !== null) continue;
        const t = getTrait(node, TransformTrait);
        if (t && t._parent !== freshParent(node)) {
            staleDetached.add(node);
            out.push({ where: 'detached', op, node: node.name ?? '?', live: false });
        }
    }
}

const random = rng(0xc0ffee);
const sceneTree = createSceneTree();
const violations: Violation[] = [];

// seed a mixed tree: some nodes carry TransformTrait, some are logical-only.
const pool: Node[] = [sceneTree.root];
for (let i = 0; i < 60; i++) {
    const parent = pool[Math.floor(random() * pool.length)]!;
    const node = makeNode(sceneTree, `n${i}`, random() < 0.6);
    addChild(parent, node);
    pool.push(node);
}
check(sceneTree.root, 'seed', violations);

const opCounts: Record<string, number> = {};
const detached: Node[] = [];

for (let step = 0; step < 3000; step++) {
    const live = pool.filter((n) => n.scene !== null && n !== sceneTree.root);
    if (live.length === 0) break;
    const pick = () => live[Math.floor(random() * live.length)]!;
    // keep the tree from draining: re-attach detached nodes and grow more than
    // we destroy, so the fuzz keeps finding live nodes to mutate.
    let roll = random();
    if (live.length < 30) roll = detached.length > 0 && roll < 0.5 ? 0.65 : 0.1;
    let op: string;

    if (roll < 0.25) {
        op = 'addChild';
        const node = makeNode(sceneTree, `a${step}`, random() < 0.6);
        addChild(pick(), node);
        pool.push(node);
    } else if (roll < 0.45) {
        op = 'reparent';
        const node = pick();
        const target = pick();
        // reparent throws on a cycle; skip those rather than catch.
        let cursor: Node | null = target;
        let cyclic = false;
        while (cursor !== null) {
            if (cursor === node) {
                cyclic = true;
                break;
            }
            cursor = cursor.parent;
        }
        if (!cyclic && node.parent !== target) reparent(node, target);
        else op = 'reparent(skipped)';
    } else if (roll < 0.6) {
        op = 'removeChild';
        const node = pick();
        if (node.parent) {
            removeChild(node.parent, node);
            detached.push(node);
        }
    } else if (roll < 0.72 && detached.length > 0) {
        op = 're-addChild';
        const node = detached.pop()!;
        addChild(pick(), node);
    } else if (roll < 0.86) {
        op = 'addTrait(Transform)';
        addTrait(pick(), TransformTrait);
    } else if (roll < 0.97) {
        op = 'removeTrait(Transform)';
        removeTrait(pick(), TransformTrait);
    } else {
        op = 'destroyNode';
        const doomed = pick();
        const stack = [doomed];
        while (stack.length > 0) {
            const n = stack.pop()!;
            destroyedNodes.add(n);
            for (const c of n.children) stack.push(c);
        }
        destroyNode(sceneTree, doomed);
    }

    opCounts[op] = (opCounts[op] ?? 0) + 1;
    check(sceneTree.root, op, violations);
    checkDetached(op, violations);
}

console.log('operations applied:');
for (const [op, n] of Object.entries(opCounts).sort()) console.log(`  ${op.padEnd(24)} ${n}`);

const inTree = violations.filter((v) => v.where === 'in-tree');
const off = violations.filter((v) => v.where === 'detached');

console.log(`\n_parent violations on nodes STILL IN THE TREE: ${inTree.length}`);
const byOp: Record<string, number> = {};
for (const v of inTree) byOp[v.op] = (byOp[v.op] ?? 0) + 1;
for (const [op, n] of Object.entries(byOp).sort()) console.log(`  after ${op.padEnd(24)} ${n}`);

console.log(`\n_parent violations on DETACHED nodes: ${off.length}`);
const byOpOff: Record<string, number> = {};
for (const v of off) byOpOff[v.op] = (byOpOff[v.op] ?? 0) + 1;
for (const [op, n] of Object.entries(byOpOff).sort().slice(0, 8)) console.log(`  after ${op.padEnd(24)} ${n}`);

const staleAndDestroyed = [...staleDetached].filter((n) => destroyedNodes.has(n));
const staleAndAlive = [...staleDetached].filter((n) => !destroyedNodes.has(n));
console.log(`\ndistinct stale nodes: ${staleDetached.size}`);
console.log(`  destroyed (discarded, unreachable):  ${staleAndDestroyed.length}`);
console.log(`  merely detached (still reachable!):  ${staleAndAlive.length}`);
for (const n of staleAndAlive.slice(0, 10)) console.log('    ', n.name);
