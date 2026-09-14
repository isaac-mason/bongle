/**
 * Pins the behaviour a bulk-attach fill descent must produce, so the prune that skips
 * descents whose target is absent above AND below cannot silently drop a real resolution.
 *
 * The prune's premise: on a fill, a target absent on both sides resolves every node to
 * null, and Optional traversal slots are already null (`buildQueryTuple` defers them).
 * Each case below either satisfies that premise (must be skippable) or breaks one half of
 * it (must still resolve).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { registry, reindexRegistry } from '../../../../src/core/registry';
import { Ancestor, Optional, Up } from '../../../../src/core/scene/conditions';
import {
    addChild,
    addTrait,
    createNode,
    createSceneTree,
    type Node,
    query,
    removeChild,
} from '../../../../src/core/scene/scene-tree';
import { trait } from '../../../../src/core/registry';

const Mesh = trait('resfill/mesh', { id: 0 });
const Group = trait('resfill/group', { id: 0 });
const Absent = trait('resfill/absent', { id: 0 });

beforeEach(() => reindexRegistry(registry));

/** a chain of `count` Mesh nodes, built detached and attached in one go. */
function buildChain(count: number, groupAt = -1): { root: Node; nodes: Node[] } {
    const nodes: Node[] = [];
    const root = createNode({ name: 'sub' });
    addTrait(root, Mesh);
    if (groupAt === 0) addTrait(root, Group);
    nodes.push(root);
    let cur = root;
    for (let i = 1; i < count; i++) {
        const n = createNode({ name: `n${i}` });
        addTrait(n, Mesh);
        if (i === groupAt) addTrait(n, Group);
        addChild(cur, n);
        nodes.push(n);
        cur = n;
    }
    return { root, nodes };
}

describe('bulk-attach resolution fill', () => {
    it('leaves slots null when the target is absent above and below (the prunable case)', () => {
        const sceneTree = createSceneTree();
        const q = query(sceneTree, [Mesh, Optional(Ancestor(Absent))]);
        const { root, nodes } = buildChain(8);
        addChild(sceneTree.root, root);

        expect(q.matchNodes.length).toBe(8);
        for (const n of nodes) {
            const i = q.matchNodes.indexOf(n);
            expect(q.matches[i]![1], `${n.name} resolves to null`).toBe(null);
        }
    });

    it('fills from an ancestor ABOVE the attach point', () => {
        const sceneTree = createSceneTree();
        const q = query(sceneTree, [Mesh, Optional(Ancestor(Group))]);
        const host = createNode({ name: 'host' });
        const group = addTrait(host, Group);
        addChild(sceneTree.root, host);

        const { root, nodes } = buildChain(8);
        addChild(host, root);

        expect(q.matchNodes.length).toBe(8);
        for (const n of nodes) {
            const i = q.matchNodes.indexOf(n);
            expect(q.matches[i]![1], `${n.name} resolves to the host's Group`).toBe(group);
        }
    });

    it('fills from a bearer INSIDE the attached subtree', () => {
        const sceneTree = createSceneTree();
        const q = query(sceneTree, [Mesh, Optional(Ancestor(Group))]);
        const { root, nodes } = buildChain(8, 3); // nodes[3] carries Group
        addChild(sceneTree.root, root);

        const groupInstance = q.matches[q.matchNodes.indexOf(nodes[4]!)]![1];
        expect(groupInstance, 'a node below the bearer resolves to it').not.toBe(null);
        for (let i = 0; i < 8; i++) {
            const slot = q.matches[q.matchNodes.indexOf(nodes[i]!)]![1];
            if (i <= 3) expect(slot, `${nodes[i]!.name} is at or above the bearer`).toBe(null);
            else expect(slot, `${nodes[i]!.name} is below the bearer`).toBe(groupInstance);
        }
    });

    it('resolves Up() inclusively at the bearer itself', () => {
        const sceneTree = createSceneTree();
        const q = query(sceneTree, [Mesh, Optional(Up(Group))]);
        const { root, nodes } = buildChain(8, 3);
        addChild(sceneTree.root, root);

        const atBearer = q.matches[q.matchNodes.indexOf(nodes[3]!)]![1];
        expect(atBearer, 'Up() includes the node itself').not.toBe(null);
        expect(q.matches[q.matchNodes.indexOf(nodes[2]!)]![1], 'above the bearer stays null').toBe(null);
    });

    it('gates membership on a REQUIRED traversal, both ways', () => {
        const sceneTree = createSceneTree();
        const q = query(sceneTree, [Mesh, Ancestor(Group)]);

        const bare = buildChain(4);
        addChild(sceneTree.root, bare.root);
        expect(q.matchNodes.length, 'no bearer anywhere: nothing matches').toBe(0);
        removeChild(sceneTree.root, bare.root);

        const host = createNode({ name: 'host' });
        addTrait(host, Group);
        addChild(sceneTree.root, host);
        const under = buildChain(4);
        addChild(host, under.root);
        expect(q.matchNodes.length, 'bearer above: every node matches').toBe(4);
    });

    it('re-fills correctly when the same subtree is detached and re-attached', () => {
        const sceneTree = createSceneTree();
        const q = query(sceneTree, [Mesh, Optional(Ancestor(Group))]);
        const host = createNode({ name: 'host' });
        const group = addTrait(host, Group);
        addChild(sceneTree.root, host);

        const { root, nodes } = buildChain(6);
        addChild(host, root);
        removeChild(host, root);
        expect(q.matchNodes.length, 'detached subtree leaves the query').toBe(0);

        addChild(host, root);
        expect(q.matchNodes.length).toBe(6);
        for (const n of nodes) {
            expect(q.matches[q.matchNodes.indexOf(n)]![1], `${n.name} refilled`).toBe(group);
        }
    });
});
