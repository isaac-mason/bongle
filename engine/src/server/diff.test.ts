import * as p from 'packcat';
import { describe, expect, it } from 'vitest';
import {
    addChild,
    addTrait,
    createNode,
    createSceneGraph,
    destroyNode,
    getNodeVersionInfo,
    getTrait,
    removeTrait,
} from '../core/scene/nodes';
import { prop } from '../core/scene/prop';
import { control, sync, trait } from '../core/scene/traits';
import { createDiffSnapshots, runDiffDetection } from './discovery';

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
        const sg = createSceneGraph();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, Health);

        const snapshots = createDiffSnapshots();
        runDiffDetection(sg, snapshots);

        // first run initializes snapshots — version stays where addTrait left it
        const versionAfterAdd = getNodeVersionInfo(sg, node)!.version;

        runDiffDetection(sg, snapshots);

        // second run with no changes — version unchanged
        expect(getNodeVersionInfo(sg, node)!.version).toBe(versionAfterAdd);
    });

    it('bumps versions when synced field changes', () => {
        const sg = createSceneGraph();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, Health);

        const snapshots = createDiffSnapshots();

        runDiffDetection(sg, snapshots);
        const versionAfterInit = getNodeVersionInfo(sg, node)!.version;

        // mutate a synced field
        getTrait(node, Health)!.current = 50;

        runDiffDetection(sg, snapshots);
        expect(getNodeVersionInfo(sg, node)!.version).toBeGreaterThan(versionAfterInit);
    });

    it('bumps versions when sync field changes', () => {
        const sg = createSceneGraph();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, Position);

        const snapshots = createDiffSnapshots();

        runDiffDetection(sg, snapshots);
        const versionAfterInit = getNodeVersionInfo(sg, node)!.version;

        getTrait(node, Position)!.x = 42;

        runDiffDetection(sg, snapshots);
        expect(getNodeVersionInfo(sg, node)!.version).toBeGreaterThan(versionAfterInit);
    });

    it('does not bump versions when nothing changed', () => {
        const sg = createSceneGraph();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, Health);

        const snapshots = createDiffSnapshots();

        runDiffDetection(sg, snapshots);
        const v1 = getNodeVersionInfo(sg, node)!.version;

        runDiffDetection(sg, snapshots);
        const v2 = getNodeVersionInfo(sg, node)!.version;

        runDiffDetection(sg, snapshots);
        const v3 = getNodeVersionInfo(sg, node)!.version;

        expect(v1).toBe(v2);
        expect(v2).toBe(v3);
    });

    it('skips traits with no serializable fields', () => {
        const sg = createSceneGraph();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, DiffTag);

        const snapshots = createDiffSnapshots();

        runDiffDetection(sg, snapshots);
        runDiffDetection(sg, snapshots);

        // tag trait has no serdes, so no snapshots stored
        const nodeSnaps = snapshots.get(node);
        expect(nodeSnaps).toBeUndefined();
    });

    it('detects sync-only field changes', () => {
        const sg = createSceneGraph();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, Position); // @sync only, no @property

        const snapshots = createDiffSnapshots();

        runDiffDetection(sg, snapshots);
        const v1 = getNodeVersionInfo(sg, node)!.version;

        getTrait(node, Position)!.x = 999;

        runDiffDetection(sg, snapshots);
        const v2 = getNodeVersionInfo(sg, node)!.version;

        // should detect the change via sync serdes
        expect(v2).toBeGreaterThan(v1);
    });

    it('does not bump version for control-only field changes (sync drives diff)', () => {
        const sg = createSceneGraph();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, Health);

        const snapshots = createDiffSnapshots();

        runDiffDetection(sg, snapshots);
        const v1 = getNodeVersionInfo(sg, node)!.version;

        // mutate control-only field (max has a control but no sync)
        getTrait(node, Health)!.max = 999;

        runDiffDetection(sg, snapshots);
        const v2 = getNodeVersionInfo(sg, node)!.version;

        // control-only changes are not part of replication diff
        expect(v2).toBe(v1);
    });

    it('cleans up snapshots for destroyed nodes', () => {
        const sg = createSceneGraph();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, Health);

        const snapshots = createDiffSnapshots();
        runDiffDetection(sg, snapshots);

        expect(snapshots.size).toBe(1);

        destroyNode(sg, node);
        runDiffDetection(sg, snapshots);

        expect(snapshots.has(node)).toBe(false);
    });

    it('cleans up snapshots for removed traits', () => {
        const sg = createSceneGraph();
        const node = createNode({ name: 'a' });
        addChild(sg.root, node);
        addTrait(node, Health);
        addTrait(node, Position);

        const snapshots = createDiffSnapshots();
        runDiffDetection(sg, snapshots);

        // one snapshot per sync:
        // health: current → 1; position: x, y → 2; total 3
        const nodeSnaps = snapshots.get(node)!;
        expect(nodeSnaps.size).toBe(3);

        removeTrait(node, Position);
        runDiffDetection(sg, snapshots);

        // position snapshots should be cleaned up, health's 1 sync remains
        expect(snapshots.get(node)!.size).toBe(1);
    });

    it('detects changes across multiple nodes independently', () => {
        const sg = createSceneGraph();
        const a = createNode({ name: 'a' });
        addChild(sg.root, a);
        const b = createNode({ name: 'b' });
        addChild(sg.root, b);
        addTrait(a, Health);
        addTrait(b, Health);

        const snapshots = createDiffSnapshots();
        runDiffDetection(sg, snapshots);

        const va1 = getNodeVersionInfo(sg, a)!.version;
        const vb1 = getNodeVersionInfo(sg, b)!.version;

        // only mutate node a
        getTrait(a, Health)!.current = 1;

        runDiffDetection(sg, snapshots);

        expect(getNodeVersionInfo(sg, a)!.version).toBeGreaterThan(va1);
        expect(getNodeVersionInfo(sg, b)!.version).toBe(vb1);
    });
});
