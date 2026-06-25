import { vec3 } from 'mathcat';
import { describe, expect, it } from 'vitest';
import { createTestServer } from '../../../tst/integration/server-integration-test';
import { pack } from '../../api/pack';
import {
    addChild,
    addTrait,
    cloneNode,
    createNode,
    findChildByName,
    findChildrenByName,
    getTrait,
    type Node,
    query,
} from './nodes';
import { prop } from './prop';
import { control, sync, type TraitType, trait } from './traits';

/* ── test traits ── */

const Marker = trait('clone/marker', {
    value: 0,
});
type Marker = TraitType<typeof Marker>;
control(Marker, 'value', {
    schema: prop.number(),
    get: (t) => t.value,
    set: (t, v) => {
        t.value = v;
    },
});

const VecMarker = trait('clone/vec-marker', {
    position: () => vec3.create(),
});
control(VecMarker, 'position', {
    schema: prop.vec3(),
    get: (t) => t.position,
    set: (t, v) => {
        vec3.copy(t.position, v);
    },
});

const SyncMarker = trait('clone/sync-marker', {
    health: 100,
});
sync(SyncMarker, 'health', {
    schema: pack.float32(),
    pack: (t) => t.health,
    unpack: (v, t) => {
        t.health = v;
    },
});

/* ── capture test module ── */

const server = createTestServer();
const TEST_NODES = server.nodes; // sg with runtime attached (room.nodes)

/* ── helpers ── */

function build3LevelTree(parentName = 'Root'): Node {
    const root = createNode({ name: parentName });
    addChild(TEST_NODES.root, root);
    addTrait(root, Marker, { value: 1 });
    const childA = createNode({ name: 'A' });
    addChild(root, childA);
    addTrait(childA, Marker, { value: 2 });
    const a1 = createNode({ name: 'A1' });
    addChild(childA, a1);
    const a2 = createNode({ name: 'A2' });
    addChild(childA, a2);
    const childB = createNode({ name: 'B' });
    addChild(root, childB);
    addTrait(childB, Marker, { value: 3 });
    return root;
}

/* ── cloneNode ── */

describe('cloneNode', () => {
    it('returns a detached subtree (no parent, no sg)', () => {
        const source = build3LevelTree('Source');
        const clone = cloneNode(source);

        expect(clone.parent).toBeNull();
        expect(clone.scene).toBeNull();
        expect(clone.children.length).toBe(2);
        expect(clone.children[0].scene).toBeNull();
        expect(clone.children[0].children[0].scene).toBeNull();
    });

    it('preserves names and tree structure', () => {
        const source = build3LevelTree('Source');
        const clone = cloneNode(source);

        expect(clone.name).toBe('Source');
        expect(clone.children.map((c) => c.name)).toEqual(['A', 'B']);
        expect(clone.children[0].children.map((c) => c.name)).toEqual(['A1', 'A2']);
    });

    it('preserves traits as fresh instances', () => {
        const source = build3LevelTree('Source');
        const clone = cloneNode(source);

        const sourceMarker = getTrait(source, Marker)!;
        const cloneMarker = getTrait(clone, Marker)!;
        expect(cloneMarker).toBeDefined();
        expect(cloneMarker).not.toBe(sourceMarker);
        expect(cloneMarker.value).toBe(1);

        // mutating clone must not bleed into source
        cloneMarker.value = 99;
        expect(sourceMarker.value).toBe(1);
    });

    it('clones do not appear in the source sg', () => {
        const source = build3LevelTree('Source');
        const sizeBefore = TEST_NODES.nodes.size;
        cloneNode(source);
        // detached — no new nodes registered
        expect(TEST_NODES.nodes.size).toBe(sizeBefore);
    });

    it('works on a detached source subtree', () => {
        // build a subtree off-graph (no addChild), then clone it
        const detachedRoot = createNode({ name: 'Detached' });
        addTrait(detachedRoot, Marker, { value: 7 });
        const detachedChild = createNode({ name: 'DetachedChild' });
        addChild(detachedRoot, detachedChild);
        addTrait(detachedChild, Marker, { value: 8 });

        const clone = cloneNode(detachedRoot);
        expect(clone.name).toBe('Detached');
        expect(clone.children.length).toBe(1);
        expect(getTrait(clone, Marker)?.value).toBe(7);
        expect(getTrait(clone.children[0], Marker)?.value).toBe(8);
    });

    it('deep-copies vec3 prop fields (mutating clone does not affect source)', () => {
        const source = createNode({ name: 'Vec' });
        addChild(TEST_NODES.root, source);
        const sourceVec = addTrait(source, VecMarker);
        vec3.set(sourceVec.position, 1, 2, 3);

        const clone = cloneNode(source);
        const cloneVec = getTrait(clone, VecMarker)!;

        // value equality
        expect(cloneVec.position[0]).toBe(1);
        expect(cloneVec.position[1]).toBe(2);
        expect(cloneVec.position[2]).toBe(3);

        // distinct refs — mutating the clone must not bleed into source
        expect(cloneVec.position).not.toBe(sourceVec.position);
        vec3.set(cloneVec.position, 9, 9, 9);
        expect(sourceVec.position[0]).toBe(1);
        expect(sourceVec.position[1]).toBe(2);
        expect(sourceVec.position[2]).toBe(3);
    });

    it('does not preserve sync-only state on clone (sync-only fields reset to defaults)', () => {
        const source = createNode({ name: 'Synced' });
        addChild(TEST_NODES.root, source);
        const sourceSync = addTrait(source, SyncMarker);
        sourceSync.health = 42;

        const clone = cloneNode(source);
        const cloneSync = getTrait(clone, SyncMarker)!;
        // sync-only fields are runtime state; clone gets the trait default
        expect(cloneSync.health).toBe(100);
    });

    it('addChild after clone wakes the subtree (registered, queryable)', () => {
        const source = build3LevelTree('Source');
        const clone = cloneNode(source);
        const sizeBefore = TEST_NODES.nodes.size;

        addChild(TEST_NODES.root, clone);

        // clone + 2 children + 2 grandchildren = 5 new registered nodes
        expect(TEST_NODES.nodes.size).toBe(sizeBefore + 5);
        expect(clone.scene).toBe(TEST_NODES);
        expect(clone.children[0].scene).toBe(TEST_NODES);

        // queries pick the cloned subtree up
        const q = query(TEST_NODES, [Marker]);
        const matchedNodes = q.matches.map(([m]) => (m as Marker)._node);
        expect(matchedNodes).toContain(clone);
    });
});

/* ── findChildByName / findChildrenByName ── */

describe('findChildByName', () => {
    it('returns the first descendant matching by name (DFS)', () => {
        const root = build3LevelTree('Root');
        const found = findChildByName(root, 'A1');
        expect(found?.name).toBe('A1');
    });

    it('returns null when no descendant matches', () => {
        const root = build3LevelTree('Root');
        expect(findChildByName(root, 'NoSuchName')).toBeNull();
    });

    it('excludes the input node itself', () => {
        const root = build3LevelTree('Root');
        // root has name 'Root' — looking for 'Root' should NOT find itself
        expect(findChildByName(root, 'Root')).toBeNull();
    });

    it('returns first DFS match when multiple share the same name', () => {
        const root = createNode({ name: 'R' });
        addChild(TEST_NODES.root, root);
        const branchA = createNode({ name: 'BranchA' });
        addChild(root, branchA);
        const twinA = createNode({ name: 'Twin' });
        addChild(branchA, twinA);
        const branchB = createNode({ name: 'BranchB' });
        addChild(root, branchB);
        const twinB = createNode({ name: 'Twin' });
        addChild(branchB, twinB);

        const found = findChildByName(root, 'Twin');
        // DFS visits BranchA first, so the first match is the one in BranchA, not twinB
        expect(found?.parent).toBe(branchA);
        expect(found).not.toBe(twinB);
    });
});

describe('findChildrenByName', () => {
    it('returns all descendants matching by name', () => {
        const root = createNode({ name: 'R' });
        addChild(TEST_NODES.root, root);
        const a = createNode({ name: 'Cube' });
        addChild(root, a);
        const aChild = createNode({ name: 'Cube' });
        addChild(a, aChild);
        const rootChild = createNode({ name: 'Cube' });
        addChild(root, rootChild);

        const found = findChildrenByName(root, 'Cube');
        expect(found.length).toBe(3);
    });

    it('returns empty array when none match', () => {
        const root = build3LevelTree('Root');
        expect(findChildrenByName(root, 'NoSuchName')).toEqual([]);
    });

    it('excludes the input node itself', () => {
        const root = createNode({ name: 'Same' });
        addChild(TEST_NODES.root, root);
        const same = createNode({ name: 'Same' });
        addChild(root, same);
        const found = findChildrenByName(root, 'Same');
        expect(found.length).toBe(1);
        expect(found[0]).not.toBe(root);
    });
});
