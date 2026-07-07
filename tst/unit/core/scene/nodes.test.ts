import { describe, expect, it } from 'vitest';
import { createTestServer } from '../../../integration/server-integration-test';
import { __popModule, __pushModule } from '../../../../src/core/capture/module-scope';
import { registry } from '../../../../src/core/registry';
import {
    acquireQuery,
    addChild,
    addTrait,
    cloneNode,
    createNode,
    createSceneGraph,
    deserializeNode,
    destroyNode,
    findAncestor,
    getTrait,
    isReplicable,
    loadSceneGraph,
    type Node,
    Not,
    query,
    releaseQuery,
    removeTrait,
    reorderChild,
    reparent,
    saveSceneGraph,
    serializeNode,
} from '../../../../src/core/scene/nodes';
import { prop } from '../../../../src/core/scene/prop';
import { packSceneGraph, unpackSceneGraph } from '../../../../src/core/scene/scene-pack';
import { applyTraitSwap, onDispose, onInit, pruneRemovedScript, script, query as scriptQuery } from '../../../../src/core/scene/scripts';
import { control, type TraitType, trait } from '../../../../src/core/scene/traits';

/* ── test traits ── */

const Tag = trait('test/tag');

const Physics = trait('test/physics', {
    gravity: -9.8,
});
control(Physics, 'gravity', {
    schema: prop.number(),
    get: (t) => t.gravity,
    set: (t, v) => {
        t.gravity = v;
    },
});

const RigidBody = trait('test/rigid-body', {
    mass: 1,
});
type RigidBody = TraitType<typeof RigidBody>;
control(RigidBody, 'mass', {
    schema: prop.number(),
    get: (t) => t.mass,
    set: (t, v) => {
        t.mass = v;
    },
});

const Transform = trait('test/transform', {
    x: 0,
    y: 0,
});
type Transform = TraitType<typeof Transform>;
control(Transform, 'x', {
    schema: prop.number(),
    get: (t) => t.x,
    set: (t, v) => {
        t.x = v;
    },
});
control(Transform, 'y', {
    schema: prop.number(),
    get: (t) => t.y,
    set: (t, v) => {
        t.y = v;
    },
});

const Renderer = trait('test/renderer', {
    visible: true,
});
control(Renderer, 'visible', {
    schema: prop.boolean(),
    get: (t) => t.visible,
    set: (t, v) => {
        t.visible = v;
    },
});

const EphemeralTrait = trait(
    'test/ephemeral-trait',
    {
        value: 42,
    },
    { persist: false },
);
control(EphemeralTrait, 'value', {
    schema: prop.number(),
    get: (t) => t.value,
    set: (t, v) => {
        t.value = v;
    },
});

/* ── traits with scripts (must be declared before getProjectModule()) ── */

// trait whose script registers a live query, used by the query-lifecycle tests
// to verify that script-acquired queries get evicted when the instance disposes.
const Tracked = trait('test/tracked', {}, { persist: false });
script(Tracked, 'track', (ctx) => {
    scriptQuery(ctx, [RigidBody]);
});

// trait whose script acquires the same query twice, exercises per-instance dedup
// (one acquire, one release on dispose, refcount stays correct).
const TrackedTwice = trait('test/tracked-twice', {}, { persist: false });
script(TrackedTwice, 'track', (ctx) => {
    scriptQuery(ctx, [RigidBody]);
    scriptQuery(ctx, [RigidBody]);
});

/* ── capture test module ── */

const server = createTestServer();
const TEST_SCRIPT_RUNTIME = server.runtime;

/* ── helpers ── */

function setup() {
    return createSceneGraph();
}

/* ── existing query behaviour (With / Not) ── */

describe('query — With / Not (existing behaviour)', () => {
    it('matches nodes with required traits', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, RigidBody, { mass: 5 });
        addTrait(node, Transform);

        const q = query(sg, [RigidBody, Transform]);
        expect(q.matches.length).toBe(1);
        expect((q.matches[0][0] as RigidBody).mass).toBe(5);
        expect(q.matches[0][0]._node).toBe(node);
        expect((q.matches[0][1] as Transform).x).toBe(0);
        expect((q.matches[0][1] as Transform).y).toBe(0);
    });

    it('Not() excludes nodes', () => {
        const sg = setup();
        const a = createNode({ name: 'A' });
        addChild(sg.root, a);
        addTrait(a, RigidBody);
        addTrait(a, Tag);

        const b = createNode({ name: 'B' });
        addChild(sg.root, b);
        addTrait(b, RigidBody);

        const q = query(sg, [RigidBody, Not(Tag)]);
        expect(q.matches.length).toBe(1);
        expect(q.matches[0][0]._node).toBe(b);
    });

    it('live updates when traits are added/removed', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        const q = query(sg, [RigidBody]);

        expect(q.matches.length).toBe(0);

        addTrait(node, RigidBody);
        expect(q.matches.length).toBe(1);

        removeTrait(node, RigidBody);
        expect(q.matches.length).toBe(0);
    });

    it('deduplicates queries by hash', () => {
        const sg = setup();
        const q1 = query(sg, [RigidBody, Transform]);
        const q2 = query(sg, [RigidBody, Transform]);
        expect(q1).toBe(q2);
    });
});

/* ── onAdd / onRemove callbacks ── */

describe('query — onAdd / onRemove callbacks', () => {
    it('onAdd fires with correct values', () => {
        const sg = setup();

        const q = query(sg, [RigidBody, Transform]);

        const added: any[] = [];
        q.onAdd.add((...args) => added.push(args));

        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, RigidBody, { mass: 7 });
        addTrait(node, Transform);

        expect(added.length).toBe(1);
        expect(added[0][0]).toBeDefined();
        expect((added[0][0] as RigidBody).mass).toBe(7);
        expect(added[0][1]).toBeDefined();
        expect((added[0][1] as Transform).x).toBe(0);
        expect((added[0][1] as Transform).y).toBe(0);
    });

    it('onRemove fires when trait is removed', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, RigidBody);

        const q = query(sg, [RigidBody]);
        expect(q.matches.length).toBe(1);

        const removed: any[] = [];
        q.onRemove.add((...args) => removed.push(args));

        removeTrait(node, RigidBody);
        expect(q.matches.length).toBe(0);
        expect(removed.length).toBe(1);
        expect(removed[0][0]).toBeDefined();
    });
});

/* ── destroy node ── */

describe('query — destroy', () => {
    it('destroying a matched node removes it from queries', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, RigidBody);

        const q = query(sg, [RigidBody]);
        expect(q.matches.length).toBe(1);

        destroyNode(sg, node);
        expect(q.matches.length).toBe(0);
    });
});

/* ── findAncestor ── */

describe('findAncestor', () => {
    it('finds direct parent with the trait', () => {
        const sg = setup();
        const parent = createNode({ name: 'P' });
        addChild(sg.root, parent);
        addTrait(parent, Physics, { gravity: -10 });

        const child = createNode({ name: 'C' });
        addChild(parent, child);

        const result = findAncestor(child, [Physics]);
        expect(result).not.toBeNull();
        const [physics] = result!;
        expect(physics._node).toBe(parent);
        expect(physics.gravity).toBe(-10);
    });

    it('finds grandparent with the trait', () => {
        const sg = setup();
        const gp = createNode({ name: 'GP' });
        addChild(sg.root, gp);
        addTrait(gp, Physics, { gravity: -15 });

        const parent = createNode({ name: 'P' });
        addChild(gp, parent);
        const child = createNode({ name: 'C' });
        addChild(parent, child);

        const result = findAncestor(child, [Physics]);
        expect(result).not.toBeNull();
        const [physics] = result!;
        expect(physics._node).toBe(gp);
        expect(physics.gravity).toBe(-15);
    });

    it('returns the CLOSEST ancestor with the trait', () => {
        const sg = setup();
        const gp = createNode({ name: 'GP' });
        addChild(sg.root, gp);
        addTrait(gp, Physics, { gravity: -1 });

        const parent = createNode({ name: 'P' });
        addChild(gp, parent);
        addTrait(parent, Physics, { gravity: -2 });

        const child = createNode({ name: 'C' });
        addChild(parent, child);

        const result = findAncestor(child, [Physics]);
        expect(result).not.toBeNull();
        const [physics] = result!;
        expect(physics._node).toBe(parent);
        expect(physics.gravity).toBe(-2);
    });

    it('returns null when no ancestor has the trait', () => {
        const sg = setup();
        const parent = createNode({ name: 'P' });
        addChild(sg.root, parent);
        const child = createNode({ name: 'C' });
        addChild(parent, child);

        const result = findAncestor(child, [Physics]);
        expect(result).toBeNull();
    });

    it('does NOT match trait on the node itself', () => {
        const sg = setup();
        const node = createNode({ name: 'N' });
        addChild(sg.root, node);
        addTrait(node, Physics);

        const result = findAncestor(node, [Physics]);
        expect(result).toBeNull();
    });

    it('works with deep nesting', () => {
        const sg = setup();
        const root = createNode({ name: 'Root' });
        addChild(sg.root, root);
        addTrait(root, Physics, { gravity: -5 });

        let current: Node = root;
        for (let i = 0; i < 10; i++) {
            const child = createNode({ name: `Level${i}` });
            addChild(current, child);
            current = child;
        }

        const result = findAncestor(current, [Physics]);
        expect(result).not.toBeNull();
        const [physics] = result!;
        expect(physics._node).toBe(root);
        expect(physics.gravity).toBe(-5);
    });

    it('returns live reference — mutations are visible', () => {
        const sg = setup();
        const parent = createNode({ name: 'P' });
        addChild(sg.root, parent);
        addTrait(parent, Physics, { gravity: -9.8 });

        const child = createNode({ name: 'C' });
        addChild(parent, child);

        const result = findAncestor(child, [Physics]);
        expect(result).not.toBeNull();
        const [physics] = result!;
        expect(physics.gravity).toBe(-9.8);

        // mutate the parent's trait
        const phys = getTrait(parent, Physics)!;
        phys.gravity = -20;

        // same object reference, mutation is visible
        expect(physics.gravity).toBe(-20);
    });

    it('multiple traits: finds first ancestor with ALL traits', () => {
        const sg = setup();
        const gp = createNode({ name: 'GP' });
        addChild(sg.root, gp);
        addTrait(gp, Physics, { gravity: -9.8 });
        // GP has Physics but not Renderer

        const parent = createNode({ name: 'P' });
        addChild(gp, parent);
        addTrait(parent, Physics, { gravity: -5 });
        addTrait(parent, Renderer, { visible: false });

        const child = createNode({ name: 'C' });
        addChild(parent, child);

        // both Physics and Renderer required, GP doesn't qualify, parent does
        const result = findAncestor(child, [Physics, Renderer]);
        expect(result).not.toBeNull();
        const [physics, renderer] = result!;
        expect(physics._node).toBe(parent);
        expect(physics.gravity).toBe(-5);
        expect(renderer.visible).toBe(false);
    });

    it('multiple traits: returns null if no single ancestor has all', () => {
        const sg = setup();
        const gp = createNode({ name: 'GP' });
        addChild(sg.root, gp);
        addTrait(gp, Physics);

        const parent = createNode({ name: 'P' });
        addChild(gp, parent);
        addTrait(parent, Renderer);

        const child = createNode({ name: 'C' });
        addChild(parent, child);

        // Physics is on GP, Renderer is on parent, no single ancestor has both
        const result = findAncestor(child, [Physics, Renderer]);
        expect(result).toBeNull();
    });

    it('ancestor node can be used to read other traits', () => {
        const sg = setup();
        const worldNode = createNode({ name: 'World' });
        addChild(sg.root, worldNode);
        addTrait(worldNode, Physics, { gravity: -9.8 });
        addTrait(worldNode, Renderer, { visible: false });

        const parent = createNode({ name: 'P' });
        addChild(worldNode, parent);
        const child = createNode({ name: 'C' });
        addChild(parent, child);

        const result = findAncestor(child, [Physics]);
        expect(result).not.toBeNull();
        const [physics] = result!;

        // use the ancestor reference to read another trait
        const renderer = getTrait(physics._node!, Renderer);
        expect(renderer).toBeDefined();
        expect(renderer!.visible).toBe(false);
    });

    it('reflects reparenting immediately', () => {
        const sg = setup();
        const worldA = createNode({ name: 'WorldA' });
        addChild(sg.root, worldA);
        addTrait(worldA, Physics, { gravity: -10 });

        const worldB = createNode({ name: 'WorldB' });
        addChild(sg.root, worldB);
        addTrait(worldB, Physics, { gravity: -20 });

        const container = createNode({ name: 'Container' });
        addChild(worldA, container);
        const child = createNode({ name: 'C' });
        addChild(container, child);

        // initially under worldA
        let result = findAncestor(child, [Physics]);
        expect(result).not.toBeNull();
        expect(result![0]._node).toBe(worldA);
        expect(result![0].gravity).toBe(-10);

        // reparent under worldB
        reparent(container, worldB);

        result = findAncestor(child, [Physics]);
        expect(result).not.toBeNull();
        expect(result![0]._node).toBe(worldB);
        expect(result![0].gravity).toBe(-20);
    });
});

/* ── reorderChild ── */

describe('reorderChild', () => {
    it('moves a child to a specific index', () => {
        const sg = setup();
        const a = createNode({ name: 'A' });
        const b = createNode({ name: 'B' });
        const c = createNode({ name: 'C' });

        addChild(sg.root, a);
        addChild(sg.root, b);
        addChild(sg.root, c);

        // order: A, B, C, move C to index 0
        reorderChild(sg.root, c, 0);
        expect(sg.root.children.map((n) => n.name)).toEqual(['C', 'A', 'B']);
    });

    it('clamps index to children length', () => {
        const sg = setup();
        const a = createNode({ name: 'A' });
        const b = createNode({ name: 'B' });

        addChild(sg.root, a);
        addChild(sg.root, b);

        // move A to index 999, should end up at end
        reorderChild(sg.root, a, 999);
        expect(sg.root.children.map((n) => n.name)).toEqual(['B', 'A']);
    });

    it('does nothing if child is not a child of parent', () => {
        const sg = setup();
        const parent = createNode({ name: 'parent' });
        addChild(sg.root, parent);
        const a = createNode({ name: 'A' });
        addChild(parent, a);
        const b = createNode({ name: 'B' }); // child of root, not parent
        addChild(sg.root, b);

        reorderChild(parent, b, 0);
        expect(parent.children.map((n) => n.name)).toEqual(['A']);
    });
});

/* ── persist flag ── */

describe('persist — node-level', () => {
    it('nodes default to persist=true', () => {
        const node = createNode({ name: 'A' });
        expect(node.persist).toBe(true);
    });

    it('can create a non-persistent node', () => {
        const node = createNode({ name: 'Ephemeral', persist: false });
        expect(node.persist).toBe(false);
    });

    it('serializeNode writes persist=false for non-persistent nodes', () => {
        const node = createNode({ name: 'E', persist: false });
        const data = serializeNode(node);
        expect(data.persist).toBe(false);
    });

    it('persistOnly skips non-persistent children', () => {
        const sg = setup();
        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        const a = createNode({ name: 'PersistChild' });
        addChild(parent, a);
        const b = createNode({ name: 'EphemeralChild', persist: false });
        addChild(parent, b);

        const data = serializeNode(parent, { persistOnly: true });
        expect(data.children.length).toBe(1);
        expect(data.children[0].name).toBe('PersistChild');
    });

    it('without persistOnly, non-persistent children are included', () => {
        const sg = setup();
        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        const a = createNode({ name: 'A' });
        addChild(parent, a);
        const b = createNode({ name: 'B', persist: false });
        addChild(parent, b);

        const data = serializeNode(parent);
        expect(data.children.length).toBe(2);
        expect(data.children[1].persist).toBe(false);
    });

    it('deserializeNode restores persist=false from serialized data', () => {
        const node = createNode({ name: 'E', persist: false });
        const data = serializeNode(node);

        const restored = deserializeNode(data);
        expect(restored.persist).toBe(false);
    });

    it('deserializeNode defaults to persist=true when field is omitted', () => {
        const node = createNode({ name: 'A' });
        const data = serializeNode(node);

        const restored = deserializeNode(data);
        expect(restored.persist).toBe(true);
    });
});

describe('persist — trait-level', () => {
    it('non-persistent traits are skipped with persistOnly', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, EphemeralTrait, { value: 99 });
        addTrait(node, Transform);

        const data = serializeNode(node, { persistOnly: true });
        expect(data.traits.length).toBe(1);
        expect(data.traits[0].id).toBe('test/transform');
    });

    it('non-persistent traits are included without persistOnly', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, EphemeralTrait, { value: 99 });
        addTrait(node, Transform);

        const data = serializeNode(node);
        expect(data.traits.length).toBe(2);
    });
});

describe('persist — scene graph level', () => {
    it('saveSceneGraph skips non-persistent root children', () => {
        const sg = setup();
        const keeper = createNode({ name: 'Keeper' });
        addChild(sg.root, keeper);
        const ephemeral = createNode({ name: 'Ephemeral', persist: false });
        addChild(sg.root, ephemeral);

        const data = saveSceneGraph(sg);
        expect(data.root.children.length).toBe(1);
        expect(data.root.children[0].name).toBe('Keeper');
    });

    it('packSceneGraph includes everything (non-persistent nodes too)', () => {
        const sg = setup();
        const keeper = createNode({ name: 'Keeper' });
        addChild(sg.root, keeper);
        const ephemeral = createNode({ name: 'Ephemeral', persist: false });
        addChild(sg.root, ephemeral);

        const packed = packSceneGraph(sg, 'edit');
        const sg2 = createSceneGraph();
        unpackSceneGraph(sg2, TEST_SCRIPT_RUNTIME, packed);

        expect(sg2.root.children.length).toBe(2);
    });

    it('full round-trip preserves persist=false through pack/unpack', () => {
        const sg = setup();
        const a = createNode({ name: 'A' });
        addChild(sg.root, a);
        const b = createNode({ name: 'B', persist: false });
        addChild(sg.root, b);

        // binary pack/unpack (network/reload path) includes everything
        const packed = packSceneGraph(sg, 'edit');

        const sg2 = createSceneGraph();
        unpackSceneGraph(sg2, TEST_SCRIPT_RUNTIME, packed);

        expect(sg2.root.children.length).toBe(2);
        expect(sg2.root.children[0].name).toBe('A');
        expect(sg2.root.children[0].persist).toBe(true);
        expect(sg2.root.children[1].name).toBe('B');
        expect(sg2.root.children[1].persist).toBe(false);
    });

    it('save/load round-trip drops non-persistent nodes (disk save path)', () => {
        const sg = setup();
        const a = createNode({ name: 'A' });
        addChild(sg.root, a);
        const b = createNode({ name: 'B', persist: false });
        addChild(sg.root, b);

        const data = saveSceneGraph(sg);

        const sg2 = createSceneGraph();
        loadSceneGraph(sg2, data);

        expect(sg2.root.children.length).toBe(1);
        expect(sg2.root.children[0].name).toBe('A');
    });
});

/* ── realm ── */

describe('realm', () => {
    it('createNode defaults to inherit', () => {
        const node = createNode({ name: 'a' });
        expect(node.realm).toBe('inherit');
    });

    it('createNode honors an explicit realm', () => {
        const serverOnly = createNode({ name: 'svr', realm: 'server' });
        const each = createNode({ name: 'each', realm: 'each' });
        expect(serverOnly.realm).toBe('server');
        expect(each.realm).toBe('each');
    });

    it('isReplicable: shared chain → true', () => {
        const sg = setup();
        const parent = createNode({ name: 'p', realm: 'shared' });
        addChild(sg.root, parent);
        const child = createNode({ name: 'c', realm: 'shared' });
        addChild(parent, child);
        expect(isReplicable(parent)).toBe(true);
        expect(isReplicable(child)).toBe(true);
    });

    it('isReplicable: inherit chain under shared root → true', () => {
        const sg = setup();
        const parent = createNode({ name: 'p' }); // inherit
        addChild(sg.root, parent);
        const child = createNode({ name: 'c' }); // inherit
        addChild(parent, child);
        expect(isReplicable(parent)).toBe(true);
        expect(isReplicable(child)).toBe(true);
    });

    it('isReplicable: inherit child under server ancestor → false', () => {
        const sg = setup();
        const ancestor = createNode({ name: 'svr', realm: 'server' });
        addChild(sg.root, ancestor);
        const child = createNode({ name: 'c' }); // inherit → server
        addChild(ancestor, child);
        expect(isReplicable(child)).toBe(false);
    });

    it('isReplicable: non-shared self → false', () => {
        const sg = setup();
        const node = createNode({ name: 'svr', realm: 'server' });
        addChild(sg.root, node);
        expect(isReplicable(node)).toBe(false);
    });

    it('isReplicable: non-shared ancestor cascades to descendants', () => {
        const sg = setup();
        const ancestor = createNode({ name: 'svr', realm: 'server' });
        addChild(sg.root, ancestor);
        // explicit shared child under a server-only ancestor → still
        // unreachable to clients because the parent never replicates.
        const child = createNode({ name: 'c', realm: 'shared' });
        addChild(ancestor, child);
        const grandchild = createNode({ name: 'g', realm: 'shared' });
        addChild(child, grandchild);
        expect(isReplicable(child)).toBe(false);
        expect(isReplicable(grandchild)).toBe(false);
    });

    it('cloneNode carries the realm field', () => {
        const src = createNode({ name: 'svr', realm: 'server' });
        const clone = cloneNode(src);
        expect(clone.realm).toBe('server');
    });
});

/* ── query ref-counting (engine primitives) ── */

describe('query — acquireQuery / releaseQuery', () => {
    it('engine-only queries (no acquire) stay in sg.queries forever', () => {
        const sg = setup();
        const before = sg.queries.size;
        query(sg, [RigidBody]);
        expect(sg.queries.size).toBe(before + 1);
        // a second engine-only get of the same query just dedups, no acquire.
        query(sg, [RigidBody]);
        expect(sg.queries.size).toBe(before + 1);
    });

    it('acquire + release evicts the query', () => {
        const sg = setup();
        const before = sg.queries.size;
        const q = query(sg, [RigidBody]);
        acquireQuery(sg, q);
        expect(sg.queries.size).toBe(before + 1);
        releaseQuery(sg, q);
        expect(sg.queries.size).toBe(before);
    });

    it('refcount: two acquires require two releases before eviction', () => {
        const sg = setup();
        const before = sg.queries.size;
        const q = query(sg, [RigidBody]);
        acquireQuery(sg, q);
        acquireQuery(sg, q);
        releaseQuery(sg, q);
        expect(sg.queries.size).toBe(before + 1);
        releaseQuery(sg, q);
        expect(sg.queries.size).toBe(before);
    });
});

/* ── script removal on reload (deleted script() call) ── */

describe('script removal on reload', () => {
    it('prunes a removed script from its trait def, disposing the instance, with no re-creation', () => {
        const sg = server.nodes;
        const runtime = TEST_SCRIPT_RUNTIME;

        let initCount = 0;
        let disposeCount = 0;

        // trait def created independent of the script's module, the built-in /
        // cross-file case where the def outlives the edited file.
        const HmrTrait = trait('test/hmr-removal');

        // a "module" declares the script. editor:true so its hooks run in the
        // test server's edit-mode runtime.
        const mod = 'file:///test/hmr-module.ts';
        const prev = __pushModule(mod);
        script(
            HmrTrait,
            'sys',
            (ctx) => {
                onInit(ctx, () => {
                    initCount++;
                });
                onDispose(ctx, () => {
                    disposeCount++;
                });
            },
            { editor: true },
        );
        __popModule(prev);

        const node = createNode({ name: 'hmr-a' });
        addChild(sg.root, node);
        addTrait(node, HmrTrait);

        expect(initCount).toBe(1);
        expect(HmrTrait._def.scriptsById.has('sys')).toBe(true);
        expect(runtime.instances.get(node.id)?.has('test/hmr-removal.sys')).toBe(true);

        // the add was already flushed in a real session; isolate the removal.
        registry.scripts.pendingChanges.length = 0;

        // module re-evaluates WITHOUT the script() call → registry emits 'removed'.
        const prev2 = __pushModule(mod);
        __popModule(prev2);

        // drive the dispatch data path: prune removed defs, then swap.
        const dirty = new Set<string>();
        for (const ch of registry.scripts.pendingChanges) {
            dirty.add(ch.handle.id);
            if (ch.kind === 'removed') pruneRemovedScript(ch.handle.payload);
        }
        registry.scripts.pendingChanges.length = 0;
        applyTraitSwap(runtime, dirty);

        // instance disposed (onDispose fired) and the def no longer lists it.
        expect(disposeCount).toBe(1);
        expect(HmrTrait._def.scriptsById.has('sys')).toBe(false);
        expect(HmrTrait._def.scripts.some((s) => s.scriptId === 'sys')).toBe(false);
        expect(runtime.instances.get(node.id)?.has('test/hmr-removal.sys') ?? false).toBe(false);

        // def-prune (not just instance disposal) means a fresh node carrying the
        // trait does NOT resurrect the deleted script.
        const node2 = createNode({ name: 'hmr-b' });
        addChild(sg.root, node2);
        addTrait(node2, HmrTrait);
        expect(initCount).toBe(1);

        destroyNode(sg, node);
        destroyNode(sg, node2);
    });
});

/* ── query lifecycle via script instances ── */

describe('query — script-instance lifecycle', () => {
    it('attaching a script-bearing trait registers the query; removing it evicts', () => {
        const sg = server.nodes;
        const before = sg.queries.size;

        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, Tracked);
        expect(sg.queries.size).toBe(before + 1);

        removeTrait(node, Tracked);
        expect(sg.queries.size).toBe(before);

        destroyNode(sg, node);
    });

    it('destroying the node evicts the query', () => {
        const sg = server.nodes;
        const before = sg.queries.size;

        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, Tracked);
        expect(sg.queries.size).toBe(before + 1);

        destroyNode(sg, node);
        expect(sg.queries.size).toBe(before);
    });

    it('two script instances sharing one query evict only on the second dispose', () => {
        const sg = server.nodes;
        const before = sg.queries.size;

        const a = createNode({ name: 'A' });
        addChild(sg.root, a);
        addTrait(a, Tracked);

        const b = createNode({ name: 'B' });
        addChild(sg.root, b);
        addTrait(b, Tracked);

        // both instances dedup to the same Query → only one entry in sg.queries.
        expect(sg.queries.size).toBe(before + 1);

        destroyNode(sg, a);
        expect(sg.queries.size).toBe(before + 1);

        destroyNode(sg, b);
        expect(sg.queries.size).toBe(before);
    });

    it('per-instance dedup: two query() calls in one factory still release cleanly', () => {
        const sg = server.nodes;
        const before = sg.queries.size;

        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TrackedTwice);
        expect(sg.queries.size).toBe(before + 1);

        destroyNode(sg, node);
        expect(sg.queries.size).toBe(before);
    });

    it('engine-side query persists across a script-side release', () => {
        const sg = server.nodes;
        const before = sg.queries.size;

        // engine-side caller, no acquire, persistent.
        const engineQ = query(sg, [Transform]);
        expect(sg.queries.size).toBe(before + 1);

        // script-side caller picks up the same query, then disposes.
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, Tracked);
        // Tracked queries [RigidBody], not [Transform], so engine query is independent.
        // sanity: engineQ entry still present.
        expect(sg.queries.has(engineQ.hash)).toBe(true);

        destroyNode(sg, node);
        // engine-only query untouched.
        expect(sg.queries.has(engineQ.hash)).toBe(true);
    });
});
