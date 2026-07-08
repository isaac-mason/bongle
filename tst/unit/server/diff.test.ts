import * as p from 'packcat';
import { describe, expect, it } from 'vitest';
import { addChild, addTrait, createNode, createSceneTree, destroyNode, getTrait, removeTrait } from '../../../src/core/scene/scene-tree';
import { prop } from '../../../src/core/scene/prop';
import { control, sync, trait } from '../../../src/core/scene/traits';
import { runDiffDetection } from '../../../src/server/discovery';

/* ── test traits ── */

const Health = trait('diff-health', {
    current: 100,
    max: 200,
});
control(Health, 'current', {
    schema: prop.number(),
    get: (t) => t.current,
    set: (t, v) => {
        t.current = v;
    },
});
control(Health, 'max', {
    schema: prop.number(),
    get: (t) => t.max,
    set: (t, v) => {
        t.max = v;
    },
});
sync(Health, 'current', {
    schema: p.float32(),
    pack: (t) => t.current,
    unpack: (v, t) => {
        t.current = v;
    },
});

const Position = trait('diff-position', {
    x: 0,
    y: 0,
});
sync(Position, 'x', {
    schema: p.float32(),
    pack: (t) => t.x,
    unpack: (v, t) => {
        t.x = v;
    },
});
sync(Position, 'y', {
    schema: p.float32(),
    pack: (t) => t.y,
    unpack: (v, t) => {
        t.y = v;
    },
});

const DiffTag = trait('diff-tag');

/* ── tests ── */

describe('diff detection', () => {
    it('does not bump versions on first snapshot (initialization)', () => {
        const sg = createSceneTree();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, Health);

        runDiffDetection(sg);

        // first run initializes snapshots, version stays where addTrait left it
        const versionAfterAdd = node._sync.version;

        runDiffDetection(sg);

        // second run with no changes, version unchanged
        expect(node._sync.version).toBe(versionAfterAdd);
    });

    it('bumps versions when synced field changes', () => {
        const sg = createSceneTree();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, Health);

        runDiffDetection(sg);
        const versionAfterInit = node._sync.version;

        // mutate a synced field
        getTrait(node, Health)!.current = 50;

        runDiffDetection(sg);
        expect(node._sync.version).toBeGreaterThan(versionAfterInit);
    });

    it('bumps versions when sync field changes', () => {
        const sg = createSceneTree();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, Position);

        runDiffDetection(sg);
        const versionAfterInit = node._sync.version;

        getTrait(node, Position)!.x = 42;

        runDiffDetection(sg);
        expect(node._sync.version).toBeGreaterThan(versionAfterInit);
    });

    it('does not bump versions when nothing changed', () => {
        const sg = createSceneTree();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, Health);

        runDiffDetection(sg);
        const v1 = node._sync.version;

        runDiffDetection(sg);
        const v2 = node._sync.version;

        runDiffDetection(sg);
        const v3 = node._sync.version;

        expect(v1).toBe(v2);
        expect(v2).toBe(v3);
    });

    it('skips traits with no serializable fields', () => {
        const sg = createSceneTree();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, DiffTag);

        runDiffDetection(sg);
        runDiffDetection(sg);

        // tag trait has no syncs, so no per-instance sync state
        expect(getTrait(node, DiffTag)?._sync).toBeUndefined();
    });

    it('detects sync-only field changes', () => {
        const sg = createSceneTree();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, Position); // @sync only, no @property

        runDiffDetection(sg);
        const v1 = node._sync.version;

        getTrait(node, Position)!.x = 999;

        runDiffDetection(sg);
        const v2 = node._sync.version;

        // should detect the change via sync serdes
        expect(v2).toBeGreaterThan(v1);
    });

    it('does not bump version for control-only field changes (sync drives diff)', () => {
        const sg = createSceneTree();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, Health);

        runDiffDetection(sg);
        const v1 = node._sync.version;

        // mutate control-only field (max has a control but no sync)
        getTrait(node, Health)!.max = 999;

        runDiffDetection(sg);
        const v2 = node._sync.version;

        // control-only changes are not part of replication diff
        expect(v2).toBe(v1);
    });

    it('per-instance snapshots die with a destroyed node', () => {
        const sg = createSceneTree();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, Health);

        runDiffDetection(sg);

        // the snapshot lives on the trait instance (seeded on the first diff)
        expect(getTrait(node, Health)!._sync!.bytes[0]).toBeInstanceOf(Uint8Array);

        destroyNode(sg, node);
        runDiffDetection(sg); // no side-map to scan; the node is simply gone

        expect(sg.nodes.has(node)).toBe(false);
    });

    it('per-instance snapshots are dropped when a trait is removed', () => {
        const sg = createSceneTree();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, Health);
        addTrait(node, Position);

        runDiffDetection(sg);

        // each trait instance holds its own per-slice snapshots
        expect(getTrait(node, Position)!._sync!.bytes.filter(Boolean).length).toBe(2);
        expect(getTrait(node, Health)!._sync!.bytes.filter(Boolean).length).toBe(1);

        removeTrait(node, Position);
        runDiffDetection(sg);

        // the removed trait's instance (and its _sync) is gone; health's remains
        expect(getTrait(node, Position)).toBeUndefined();
        expect(getTrait(node, Health)!._sync!.bytes.filter(Boolean).length).toBe(1);
    });

    it('detects changes across multiple nodes independently', () => {
        const sg = createSceneTree();
        const a = createNode({ name: 'a' });
        addChild(sg.root, a);
        const b = createNode({ name: 'b' });
        addChild(sg.root, b);
        addTrait(a, Health);
        addTrait(b, Health);

        runDiffDetection(sg);

        const va1 = a._sync.version;
        const vb1 = b._sync.version;

        // only mutate node a
        getTrait(a, Health)!.current = 1;

        runDiffDetection(sg);

        expect(a._sync.version).toBeGreaterThan(va1);
        expect(b._sync.version).toBe(vb1);
    });
});
