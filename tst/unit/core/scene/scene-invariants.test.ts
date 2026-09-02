import { beforeEach, describe, expect, it } from 'vitest';
import { TransformTrait } from '../../../../src/builtins/transform';
import { registry, reindexRegistry } from '../../../../src/core/registry';
import { Ancestor, Not, Oper, Optional, Src, Up } from '../../../../src/core/scene/conditions';
import {
    addChild,
    addTrait,
    addTraitBySlot,
    createNode,
    createSceneTree,
    destroyNode,
    getTrait,
    type Node,
    type Query,
    query,
    removeChild,
    removeTrait,
    removeTraitBySlot,
    reorderChild,
    reparent,
    type SceneTree,
} from '../../../../src/core/scene/scene-tree';
import { trait } from '../../../../src/core/scene/traits';

const Mesh = trait('inv/mesh', { id: 0 });
const Model = trait('inv/model', { light: 0 });
const Tag = trait('inv/tag', { on: 0 });

beforeEach(() => reindexRegistry(registry));

function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function nearest(node: Node | null, slot: number, inclusive: boolean) {
    let cursor = inclusive ? node : (node?.parent ?? null);
    while (cursor !== null) {
        const instance = cursor._traits[slot];
        if (instance !== undefined) return instance;
        cursor = cursor.parent;
    }
    return undefined;
}

function resolveCondition(node: Node, condition: { trait: { _slot: number }; oper: Oper; src: Src }) {
    const slot = condition.trait._slot;
    if (condition.src === Src.Self) return node._traits[slot];
    return nearest(node, slot, condition.src === Src.Up);
}

function shouldMatch(node: Node, q: Query<any>): boolean {
    for (const condition of q.conditions) {
        const resolved = resolveCondition(node, condition);
        if (condition.oper === Oper.Not && resolved !== undefined) return false;
        if (condition.oper === Oper.And && resolved === undefined) return false;
    }
    return true;
}

function expectedTuple(node: Node, q: Query<any>) {
    const tuple: unknown[] = [];
    for (const condition of q.conditions) {
        if (condition.oper === Oper.Not) continue;
        tuple.push(resolveCondition(node, condition) ?? null);
    }
    return tuple;
}

function liveNodes(sceneTree: SceneTree): Node[] {
    return [...sceneTree.nodes];
}

function checkAll(sceneTree: SceneTree, queries: Array<Query<any>>, everyNode: Node[], destroyed: Set<Node>, op: string) {
    for (const node of everyNode) {
        if (destroyed.has(node)) continue;
        const transform = getTrait(node, TransformTrait);
        if (transform) {
            expect(transform._parent, `_parent after ${op} on ${node.name}`).toBe(
                (nearest(node, TransformTrait._slot!, false) as typeof transform | undefined) ?? null,
            );
        }
    }

    const live = liveNodes(sceneTree);
    for (const q of queries) {
        const expectedMembers = live.filter((n) => shouldMatch(n, q));
        expect([...q.matchNodes].map((n) => n.name).sort(), `members after ${op}`).toEqual(
            expectedMembers.map((n) => n.name).sort(),
        );
        for (let i = 0; i < q.matchNodes.length; i++) {
            const node = q.matchNodes[i]!;
            expect(q.matches[i], `tuple for ${node.name} after ${op}`).toEqual(expectedTuple(node, q));
        }
    }
}

describe.each([0x51e5ed, 0xbeef01, 0x1234ab, 0xfeed99])('scene tree invariants, seed %i', (SEED) => {
    it('keeps _parent, query membership and tuple contents correct', () => {
        const sceneTree = createSceneTree();
        const queries: Array<Query<any>> = [
            query(sceneTree, [Mesh, Optional(Up(Model))]),
            query(sceneTree, [Mesh, Ancestor(Model)]),
            query(sceneTree, [TransformTrait, Not(Tag)]),
            query(sceneTree, [Optional(Ancestor(TransformTrait))]),
        ];

        const random = rng(SEED);
        const everyNode: Node[] = [];
        const destroyed = new Set<Node>();
        const detached: Node[] = [];
        const pool: Node[] = [sceneTree.root];

        function spawn(name: string): Node {
            const node = createNode({ name });
            if (random() < 0.6) addTrait(node, TransformTrait);
            if (random() < 0.5) addTrait(node, Mesh);
            if (random() < 0.25) addTrait(node, Model);
            if (random() < 0.2) addTrait(node, Tag);
            everyNode.push(node);
            return node;
        }

        for (let i = 0; i < 25; i++) {
            const parent = pool[Math.floor(random() * pool.length)]!;
            const node = spawn(`n${i}`);
            addChild(parent, node);
            pool.push(node);
        }
        checkAll(sceneTree, queries, everyNode, destroyed, 'seed');

        for (let step = 0; step < 300; step++) {
            const live = pool.filter((n) => n.scene !== null && n !== sceneTree.root && !destroyed.has(n));
            if (live.length === 0) break;
            const pick = () => live[Math.floor(random() * live.length)]!;
            const roll = live.length < 12 ? random() * 0.3 : random();
            let op = '';

            if (roll < 0.2) {
                op = 'addChild';
                const node = spawn(`s${step}`);
                addChild(pick(), node);
                pool.push(node);
            } else if (roll < 0.35) {
                op = 'reparent';
                const node = pick();
                const target = pick();
                let cursor: Node | null = target;
                let cyclic = false;
                while (cursor !== null) {
                    if (cursor === node) cyclic = true;
                    cursor = cursor.parent;
                }
                if (!cyclic && node.parent !== target) reparent(node, target);
            } else if (roll < 0.5) {
                op = 'removeChild';
                const node = pick();
                if (node.parent) {
                    removeChild(node.parent, node);
                    detached.push(node);
                }
            } else if (roll < 0.6 && detached.length > 0) {
                op = 're-addChild';
                addChild(pick(), detached.pop()!);
            } else if (roll < 0.68) {
                op = 'addTrait';
                addTrait(pick(), TransformTrait);
            } else if (roll < 0.76) {
                op = 'removeTrait';
                removeTrait(pick(), TransformTrait);
            } else if (roll < 0.82) {
                op = 'addTraitBySlot';
                addTraitBySlot(pick(), Model._slot!);
            } else if (roll < 0.88) {
                op = 'removeTraitBySlot';
                removeTraitBySlot(pick(), Model._slot!);
            } else if (roll < 0.94) {
                op = 'reorderChild';
                const node = pick();
                if (node.parent) reorderChild(node.parent, node, Math.floor(random() * (node.parent.children.length + 1)));
            } else {
                op = 'destroyNode';
                const doomed = pick();
                const stack = [doomed];
                while (stack.length > 0) {
                    const n = stack.pop()!;
                    destroyed.add(n);
                    for (const c of n.children) stack.push(c);
                }
                destroyNode(sceneTree, doomed);
            }

            if (op !== '') checkAll(sceneTree, queries, everyNode, destroyed, `${op} (step ${step})`);
        }
    });
});
