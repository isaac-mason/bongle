import { describe, expect, it } from 'vitest';
import { parentTransform, TransformTrait } from '../../../../src/builtins/transform';
import { Ancestor, Optional, Up } from '../../../../src/core/scene/conditions';
import {
    addChild,
    addTrait,
    createNode,
    createSceneTree,
    flushQueryEvents,
    onQueryEnter,
    onQueryExit,
    query,
    removeChild,
    removeTrait,
    reparent,
} from '../../../../src/core/scene/scene-tree';
import { trait } from '../../../../src/core/scene/traits';
import { env } from '../../../../src/env';

/* ── test traits ── */

const Mesh = trait('test/anc-mesh', { id: 0 });
const Group = trait('test/anc-group', { name: '' });
const Other = trait('test/anc-other', { id: 0 });

/** a chain root → mid → leaf, with traits added by the caller. */
function chain() {
    const sceneTree = createSceneTree();
    const top = createNode({ name: 'top' });
    const mid = createNode({ name: 'mid' });
    const leaf = createNode({ name: 'leaf' });
    addChild(sceneTree.root, top);
    addChild(top, mid);
    addChild(mid, leaf);
    return { sceneTree, top, mid, leaf };
}

describe('Up / Ancestor — resolution', () => {
    it('Up resolves the nearest ancestor, skipping trait-less nodes', () => {
        const { sceneTree, top, leaf } = chain();
        const group = addTrait(top, Group);
        addTrait(leaf, Mesh);

        const q = query(sceneTree, [Mesh, Optional(Up(Group))]);
        expect(q.matches.length).toBe(1);
        expect(q.matches[0]![1]).toBe(group);
    });

    it('Up counts the node itself — Mesh and Group on one node', () => {
        const { sceneTree, top, leaf } = chain();
        addTrait(top, Group, { name: 'above' });
        const own = addTrait(leaf, Group, { name: 'own' });
        addTrait(leaf, Mesh);

        const q = query(sceneTree, [Mesh, Optional(Up(Group))]);
        expect(q.matches[0]![1]).toBe(own);
    });

    it('Ancestor skips the node itself and finds the one above', () => {
        const { sceneTree, top, leaf } = chain();
        const above = addTrait(top, Group, { name: 'above' });
        addTrait(leaf, Group, { name: 'own' });
        addTrait(leaf, Mesh);

        const q = query(sceneTree, [Mesh, Optional(Ancestor(Group))]);
        expect(q.matches[0]![1]).toBe(above);
    });

    it('resolves null with no ancestor, and still matches when Optional', () => {
        const { sceneTree, leaf } = chain();
        addTrait(leaf, Mesh);

        const q = query(sceneTree, [Mesh, Optional(Up(Group))]);
        expect(q.matches.length).toBe(1);
        expect(q.matches[0]![1]).toBe(null);
    });

    it('a nearer group shadows a further one', () => {
        const { sceneTree, top, mid, leaf } = chain();
        addTrait(top, Group, { name: 'far' });
        const near = addTrait(mid, Group, { name: 'near' });
        addTrait(leaf, Mesh);

        const q = query(sceneTree, [Mesh, Optional(Up(Group))]);
        expect(q.matches[0]![1]).toBe(near);
    });
});

describe('Up / Ancestor — required terms gate membership', () => {
    it('required Up drops a node with no resolvable ancestor', () => {
        const { sceneTree, top, leaf } = chain();
        addTrait(leaf, Mesh);

        const q = query(sceneTree, [Mesh, Up(Group)]);
        expect(q.matches.length).toBe(0);

        const group = addTrait(top, Group);
        expect(q.matches.length).toBe(1);
        expect(q.matches[0]![1]).toBe(group);
    });

    it('removing the ancestor trait drops the match', () => {
        const { sceneTree, top, leaf } = chain();
        addTrait(top, Group);
        addTrait(leaf, Mesh);

        const q = query(sceneTree, [Mesh, Up(Group)]);
        expect(q.matches.length).toBe(1);

        removeTrait(top, Group);
        expect(q.matches.length).toBe(0);
    });

    it('enter/exit fire as a required term starts and stops resolving', () => {
        const { sceneTree, top, leaf } = chain();
        addTrait(leaf, Mesh);

        const q = query(sceneTree, [Mesh, Up(Group)]);
        let enters = 0;
        let exits = 0;
        onQueryEnter(q, () => enters++);
        onQueryExit(q, () => exits++);

        addTrait(top, Group);
        expect(enters).toBe(1);
        expect(exits).toBe(0);

        removeTrait(top, Group);
        expect(enters).toBe(1);
        expect(exits).toBe(1);
    });
});

describe('Up / Ancestor — staying live', () => {
    it('reparenting rebinds the resolved value in place', () => {
        const sceneTree = createSceneTree();
        const a = createNode({ name: 'a' });
        const b = createNode({ name: 'b' });
        const leaf = createNode({ name: 'leaf' });
        addChild(sceneTree.root, a);
        addChild(sceneTree.root, b);
        addChild(a, leaf);
        const ga = addTrait(a, Group, { name: 'a' });
        const gb = addTrait(b, Group, { name: 'b' });
        addTrait(leaf, Mesh);

        const q = query(sceneTree, [Mesh, Optional(Up(Group))]);
        expect(q.matches[0]![1]).toBe(ga);

        reparent(leaf, b);
        expect(q.matches[0]![1]).toBe(gb);
    });

    it('retires the old tuple and enters a new one when a reparent changes the resolved ancestor', () => {
        const sceneTree = createSceneTree();
        const a = createNode({ name: 'a' });
        const b = createNode({ name: 'b' });
        const leaf = createNode({ name: 'leaf' });
        addChild(sceneTree.root, a);
        addChild(sceneTree.root, b);
        addChild(a, leaf);
        addTrait(a, Group, { name: 'a' });
        addTrait(b, Group, { name: 'b' });
        addTrait(leaf, Mesh);

        const q = query(sceneTree, [Mesh, Optional(Up(Group))]);
        const entered: unknown[] = [];
        const exited: unknown[] = [];
        onQueryEnter(q, (_mesh, group) => entered.push(group));
        onQueryExit(q, (_mesh, group) => exited.push(group));
        // enter backfills the existing match; only what follows the reparent matters.
        entered.length = 0;

        reparent(leaf, b);
        flushQueryEvents();

        // the ancestor it resolved to changed, so the match the consumer holds is retired
        // and replaced rather than silently mutated underneath them.
        expect(exited.length, 'one exit for the old resolution').toBe(1);
        expect(entered.length, 'one enter for the new one').toBe(1);
        expect((exited[0] as { name: string }).name).toBe('a');
        expect((entered[0] as { name: string }).name).toBe('b');
        expect(q.matchNodes.length, 'membership itself never churned').toBe(1);
    });

    it('adding a group above live matches rebinds the subtree', () => {
        const { sceneTree, top, mid, leaf } = chain();
        addTrait(leaf, Mesh);
        const sibling = createNode({ name: 'sibling' });
        addChild(mid, sibling);
        addTrait(sibling, Mesh);

        const q = query(sceneTree, [Mesh, Optional(Up(Group))]);
        expect(q.matches.every((m) => m[1] === null)).toBe(true);

        const group = addTrait(top, Group);
        expect(q.matches.length).toBe(2);
        expect(q.matches.every((m) => m[1] === group)).toBe(true);
    });

    it('removing a group falls through to the next one up', () => {
        const { sceneTree, top, mid, leaf } = chain();
        const far = addTrait(top, Group, { name: 'far' });
        const near = addTrait(mid, Group, { name: 'near' });
        addTrait(leaf, Mesh);

        const q = query(sceneTree, [Mesh, Optional(Up(Group))]);
        expect(q.matches[0]![1]).toBe(near);

        removeTrait(mid, Group);
        expect(q.matches[0]![1]).toBe(far);
    });

    it('a nested group shields its own descendants from a change above', () => {
        const { sceneTree, top, mid, leaf } = chain();
        const near = addTrait(mid, Group, { name: 'near' });
        addTrait(leaf, Mesh);

        const q = query(sceneTree, [Mesh, Optional(Up(Group))]);
        expect(q.matches[0]![1]).toBe(near);

        // adding a group further up must not disturb the shielded descendant
        addTrait(top, Group, { name: 'far' });
        expect(q.matches[0]![1]).toBe(near);
    });

    it('detaching resolves back to null', () => {
        const { sceneTree, top, mid, leaf } = chain();
        addTrait(top, Group);
        addTrait(leaf, Mesh);

        const q = query(sceneTree, [Mesh, Optional(Up(Group))]);
        expect(q.matches[0]![1]).not.toBe(null);

        removeChild(top, mid);
        expect(q.matches.length).toBe(0);
    });

    it('a subtree attached later resolves against its new parents', () => {
        const sceneTree = createSceneTree();
        const host = createNode({ name: 'host' });
        addChild(sceneTree.root, host);
        const group = addTrait(host, Group);

        // built detached, then attached
        const modelRoot = createNode({ name: 'model' });
        const leaf = createNode({ name: 'leaf' });
        addChild(modelRoot, leaf);
        addTrait(leaf, Mesh);

        const q = query(sceneTree, [Mesh, Optional(Up(Group))]);
        expect(q.matches.length).toBe(0);

        addChild(host, modelRoot);
        expect(q.matches.length).toBe(1);
        expect(q.matches[0]![1]).toBe(group);
    });

    it('Ancestor never resolves to the node itself after a reparent', () => {
        const { sceneTree, top, mid, leaf } = chain();
        const above = addTrait(top, Group, { name: 'above' });
        const own = addTrait(leaf, Group, { name: 'own' });
        addTrait(leaf, Mesh);

        const q = query(sceneTree, [Mesh, Optional(Ancestor(Group))]);
        expect(q.matches[0]![1]).toBe(above);

        reparent(leaf, mid);
        expect(q.matches[0]![1]).toBe(above);
        expect(q.matches[0]![1]).not.toBe(own);
    });
});

describe('Up / Ancestor — query identity', () => {
    it('terms differing only by source are different queries', () => {
        const sceneTree = createSceneTree();
        const withSelf = query(sceneTree, [Mesh, Optional(Group)]);
        const withUp = query(sceneTree, [Mesh, Optional(Up(Group))]);
        const withAncestor = query(sceneTree, [Mesh, Optional(Ancestor(Group))]);

        expect(withSelf).not.toBe(withUp);
        expect(withUp).not.toBe(withAncestor);
    });

    const termCount = (sceneTree: ReturnType<typeof createSceneTree>) =>
        sceneTree._queryResolutionGroups.reduce((n: number, group) => n + group.length, 0);

    it('only traversal terms register a query resolution', () => {
        const sceneTree = createSceneTree();
        // resolutions declared in trait bodies (TransformTrait._parent) are global, not
        // per-tree, so a fresh tree starts with none of its own.
        expect(termCount(sceneTree)).toBe(0);

        query(sceneTree, [Mesh, Group]);
        expect(termCount(sceneTree)).toBe(0);

        query(sceneTree, [Mesh, Optional(Up(Group))]);
        expect(termCount(sceneTree)).toBe(1);
    });

    it('buckets terms by target slot, so one slot is one walk', () => {
        const sceneTree = createSceneTree();

        // two distinct queries, same traversal target: one bucket, two terms.
        query(sceneTree, [Mesh, Optional(Up(Group))]);
        query(sceneTree, [Other, Optional(Up(Group))]);
        expect(sceneTree._queryResolutionGroups.length, 'one bucket for one target').toBe(1);
        expect(termCount(sceneTree)).toBe(2);

        // a different target opens a second bucket.
        query(sceneTree, [Mesh, Optional(Up(Other))]);
        expect(sceneTree._queryResolutionGroups.length).toBe(2);
        expect(termCount(sceneTree)).toBe(3);
    });
});

describe('Up / Ancestor — resolutions sharing one descent', () => {
    it('two queries on the same target both stay correct through a move', () => {
        const sceneTree = createSceneTree();
        const a = createNode({ name: 'a' });
        const b = createNode({ name: 'b' });
        const leaf = createNode({ name: 'leaf' });
        addChild(sceneTree.root, a);
        addChild(sceneTree.root, b);
        addChild(a, leaf);
        const ga = addTrait(a, Group, { name: 'a' });
        const gb = addTrait(b, Group, { name: 'b' });
        addTrait(leaf, Mesh);
        addTrait(leaf, Other);

        // same target and inclusivity, different owners: one shared descent.
        const q1 = query(sceneTree, [Mesh, Optional(Up(Group))]);
        const q2 = query(sceneTree, [Other, Optional(Up(Group))]);
        expect(q1.matches[0]![1]).toBe(ga);
        expect(q2.matches[0]![1]).toBe(ga);

        reparent(leaf, b);
        expect(q1.matches[0]![1]).toBe(gb);
        expect(q2.matches[0]![1]).toBe(gb);
    });

    it('same target but different inclusivity are not conflated', () => {
        const { sceneTree, top, leaf } = chain();
        const above = addTrait(top, Group, { name: 'above' });
        const own = addTrait(leaf, Group, { name: 'own' });
        addTrait(leaf, Mesh);

        // Up counts the node itself, Ancestor does not: same trait, must not
        // collapse into one group.
        const qUp = query(sceneTree, [Mesh, Optional(Up(Group))]);
        const qAnc = query(sceneTree, [Mesh, Optional(Ancestor(Group))]);
        expect(qUp.matches[0]![1]).toBe(own);
        expect(qAnc.matches[0]![1]).toBe(above);
    });

    it('a required and an optional term on one target coexist', () => {
        const { sceneTree, top, leaf } = chain();
        addTrait(leaf, Mesh);
        addTrait(leaf, Other);

        const required = query(sceneTree, [Mesh, Up(Group)]);
        const optional = query(sceneTree, [Other, Optional(Up(Group))]);
        expect(required.matches.length).toBe(0);
        expect(optional.matches.length).toBe(1);
        expect(optional.matches[0]![1]).toBe(null);

        const group = addTrait(top, Group);
        expect(required.matches.length).toBe(1);
        expect(required.matches[0]![1]).toBe(group);
        expect(optional.matches[0]![1]).toBe(group);
    });

    it('declared resolutions still settle before query terms resolve', () => {
        // TransformTrait._parent is a declared resolution; a query sourcing the same
        // trait must not be grouped with it, or the ordering guarantee breaks.
        const sceneTree = createSceneTree();
        const a = createNode({ name: 'a' });
        const b = createNode({ name: 'b' });
        const leaf = createNode({ name: 'leaf' });
        addChild(sceneTree.root, a);
        addChild(sceneTree.root, b);
        addChild(a, leaf);
        addTrait(a, TransformTrait);
        const bt = addTrait(b, TransformTrait);
        const lt = addTrait(leaf, TransformTrait);

        const q = query(sceneTree, [Mesh, Optional(Ancestor(TransformTrait))]);
        addTrait(leaf, Mesh);

        reparent(leaf, b);
        expect(parentTransform(lt)).toBe(bt);
        expect(q.matches[0]![1]).toBe(bt);
    });
});

describe('membership index — client node ids', () => {
    // Tests run with `env.client === false`, so every other test in the suite
    // allocates positive ids. The client allocates DOWN from -1, and a client
    // tree holds both signs at once: locally-created nodes are negative,
    // replicated ones arrive with positive server ids. The sparse index keys on
    // the id, so both must coexist without colliding.
    it('indexes negative ids, and does not collide them with positive ones', () => {
        const wasClient = env.client;
        env.client = true;
        try {
            const sceneTree = createSceneTree();
            const host = createNode({ name: 'host' });
            addChild(sceneTree.root, host);
            const group = addTrait(host, Group);

            // locally created: negative id
            const local = createNode({ name: 'local' });
            addChild(host, local);
            addTrait(local, Mesh);
            expect(local.id).toBeLessThan(0);

            // replicated: arrives with a pre-assigned positive id whose
            // magnitude matches the local one, the exact collision a naive
            // abs() key would produce.
            const replicated = createNode({ name: 'replicated' });
            replicated.id = -local.id;
            addChild(host, replicated);
            addTrait(replicated, Mesh);
            expect(replicated.id).toBe(-local.id);

            const q = query(sceneTree, [Mesh, Optional(Up(Group))]);
            expect(q.matches.length).toBe(2);
            expect(q.matches.every((m) => m[1] === group)).toBe(true);

            // removing one must not evict the other
            removeTrait(local, Mesh);
            expect(q.matches.length).toBe(1);
            expect(q.matches[0]![0]._node).toBe(replicated);

            // and the survivor still re-resolves correctly
            const other = createNode({ name: 'other' });
            addChild(sceneTree.root, other);
            const group2 = addTrait(other, Group);
            reparent(replicated, other);
            expect(q.matches[0]![1]).toBe(group2);
        } finally {
            env.client = wasClient;
        }
    });
});
