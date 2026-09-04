// ── resolve cost on realistic scene shapes ──────────────────────────
//
// run: pnpm bench scene-shapes
//
// `resolutions.bench.ts` measures a 64-node *chain*, which is a stress
// shape, not a real one. Real scenes are wide and shallow: a container with
// hundreds of props, each prop a model root with a handful of mesh children —
// depth 2-3, not 64. And the subtree a mutation actually moves is one prop
// (~6 nodes), not the whole world.
//
// This file measures the three mutations a game really performs:
//   spawn / despawn  a prop into an already-populated container
//   reparent         a prop between containers
//   scene load       one attach of a whole populated container
//
// Resolution count is 2 throughout, matching what the engine registers today:
// both `mesh-visuals` and `voxel-mesh-visuals` query `Optional(Up(ModelTrait))`,
// so every room has two resolving the same trait.

import { bench, group } from '@pmndrs/labs';
import { Optional, Up } from '../src/core/scene/conditions';
import {
    addChild,
    addTrait,
    createNode,
    createSceneTree,
    type Node,
    query,
    removeChild,
    reparent,
    type SceneTree,
} from '../src/core/scene/scene-tree';
import { trait } from '../src/core/scene/traits';

const Mesh = trait('shape/mesh', { id: 0 });
const VoxelMesh = trait('shape/voxel-mesh', { id: 0 });
/** stands in for ModelTrait: the lighting group both renderers resolve. */
const Model = trait('shape/model', { light: 0 });
/** traits nothing in the fixture carries, for registering queries that can
 *  never match — the wasted scan a trait→query index would eliminate. */
const Unrelated = Array.from({ length: 32 }, (_, i) => trait(`shape/unrelated-${i}`, { n: 0 }));

/** one prop: a model root with `meshes` mesh children. Depth 2. */
function buildProp(meshes: number): Node {
    const root = createNode({ name: 'prop' });
    addTrait(root, Model);
    for (let i = 0; i < meshes; i++) {
        const m = createNode({ name: `m${i}` });
        addTrait(m, Mesh);
        if (i % 4 === 3) addTrait(m, VoxelMesh);
        addChild(root, m);
    }
    return root;
}

/** a container holding `props` props. Depth 3 from the scene root. */
function buildContainer(sceneTree: SceneTree, props: number, meshes: number): Node {
    const container = createNode({ name: 'container' });
    addChild(sceneTree.root, container);
    for (let i = 0; i < props; i++) addChild(container, buildProp(meshes));
    return container;
}

function withResolutions(sceneTree: SceneTree, count: number): void {
    if (count > 0) query(sceneTree, [Mesh, Optional(Up(Model))]);
    if (count > 1) query(sceneTree, [VoxelMesh, Optional(Up(Model))]);
}

group('scene shapes: spawn a prop into a populated container @shape @spawn', () => {
    for (const count of [0, 2]) {
        bench(`spawn+despawn 1 prop (6 nodes), 200 props present, ${count} resolutions`, function* () {
            const sceneTree = createSceneTree();
            const container = buildContainer(sceneTree, 200, 5);
            withResolutions(sceneTree, count);
            const prop = buildProp(5);
            yield () => {
                addChild(container, prop);
                removeChild(container, prop);
            };
        }).gc(true);
    }
});

group('scene shapes: reparent a prop between containers @shape @reparent', () => {
    for (const count of [0, 2]) {
        bench(`reparent 1 prop (6 nodes) between containers, ${count} resolutions`, function* () {
            const sceneTree = createSceneTree();
            const a = buildContainer(sceneTree, 100, 5);
            const b = buildContainer(sceneTree, 100, 5);
            withResolutions(sceneTree, count);
            const prop = buildProp(5);
            addChild(a, prop);
            yield () => {
                reparent(prop, b);
                reparent(prop, a);
            };
        }).gc(true);
    }
});

group('scene shapes: scene load, one attach of a whole container @shape @load', () => {
    for (const count of [0, 2]) {
        bench(`attach container of 200 props (1200 nodes), ${count} resolutions`, function* () {
            const sceneTree = createSceneTree();
            withResolutions(sceneTree, count);
            // built detached, attached in one go — the scene-load shape.
            const container = createNode({ name: 'container' });
            for (let i = 0; i < 200; i++) addChild(container, buildProp(5));
            yield () => {
                addChild(sceneTree.root, container);
                removeChild(sceneTree.root, container);
            };
        }).gc(true);
    }
});

group('scene shapes: deep vs wide, same node count @shape @topology', () => {
    // 240 nodes either way: the stress shape the other bench file uses vs the
    // shape a real scene has. If these differ sharply, chain numbers don't
    // transfer.
    bench('reparent 240 nodes as a chain, 2 resolutions', function* () {
        const sceneTree = createSceneTree();
        const a = createNode({ name: 'a' });
        const b = createNode({ name: 'b' });
        addChild(sceneTree.root, a);
        addChild(sceneTree.root, b);
        addTrait(a, Model);
        addTrait(b, Model);
        withResolutions(sceneTree, 2);
        const root = createNode({ name: 'chain' });
        addTrait(root, Mesh);
        let cur = root;
        for (let i = 1; i < 240; i++) {
            const n = createNode({ name: `n${i}` });
            addTrait(n, Mesh);
            addChild(cur, n);
            cur = n;
        }
        addChild(a, root);
        yield () => {
            reparent(root, b);
            reparent(root, a);
        };
    }).gc(true);

    bench('reparent 240 nodes as 40 props x 6, 2 resolutions', function* () {
        const sceneTree = createSceneTree();
        const a = createNode({ name: 'a' });
        const b = createNode({ name: 'b' });
        addChild(sceneTree.root, a);
        addChild(sceneTree.root, b);
        addTrait(a, Model);
        addTrait(b, Model);
        withResolutions(sceneTree, 2);
        const group_ = createNode({ name: 'wide' });
        for (let i = 0; i < 40; i++) addChild(group_, buildProp(5));
        addChild(a, group_);
        yield () => {
            reparent(group_, b);
            reparent(group_, a);
        };
    }).gc(true);
});

// ── scaling sweeps ──────────────────────────────────────────────────
//
// Absolute attach numbers carry ~±15% run-to-run drift on this machine, which
// is wider than most effects we care about. These arms are built to be read as
// SLOPES instead: cost across node counts at fixed queries gives per-node cost
// with the noisy fixed overhead factored out, and cost across query counts at
// fixed nodes gives per-node-per-query cost.
//
// The second sweep is the one that justified the trait→query index. Membership
// used to loop EVERY query in the tree for every node, so a node bearing Mesh
// was tested against queries for traits it could never have. The extra queries
// here deliberately match nothing, which is the realistic case: most queries in
// a game don't match most nodes.
//
// Measured (2026-09), attach+detach of 1200 nodes:
//
//   queries      index on   index off
//        2        453.5us     432.7us   index 4.8% SLOWER
//        8        479.9us     501.6us   index 4.3% faster
//       32        578.2us     776.1us   index 25.5% faster
//
//   per-query slope: 4.2us with the index, 11.4us without
//
// The crossover sits between 2 and 8 queries: below it, candidate collection
// (generation bump, always-list sweep, bitset walk) costs more than the
// `nodeMatchesQuery` calls it avoids. The engine alone registers ~28 queries
// across 13 files before any game script, so a real room is far past that.
// Read the 2-query arms as a floor, not as the operating point.

/** a detached container of `props` props (6 nodes each). */
function detachedContainer(props: number): Node {
    const container = createNode({ name: 'container' });
    for (let i = 0; i < props; i++) addChild(container, buildProp(5));
    return container;
}

function loadFixture(props: number, unrelatedQueries: number) {
    const sceneTree = createSceneTree();
    withResolutions(sceneTree, 2);
    for (let i = 0; i < unrelatedQueries; i++) query(sceneTree, [Unrelated[i]!]);
    return { sceneTree, container: detachedContainer(props) };
}

group('scene load: node count sweep, 2 queries @sweep @nodes', () => {
    for (const [props, nodes] of [
        [17, 102],
        [67, 402],
        [200, 1200],
    ] as const) {
        bench(`attach+detach ${nodes} nodes`, function* () {
            const f = loadFixture(props, 0);
            yield () => {
                addChild(f.sceneTree.root, f.container);
                removeChild(f.sceneTree.root, f.container);
            };
        }).gc(true);
    }
});

group('scene load: query count sweep, 1200 nodes @sweep @queries', () => {
    for (const extra of [0, 6, 30]) {
        bench(`attach+detach 1200 nodes, ${extra + 2} queries`, function* () {
            const f = loadFixture(200, extra);
            yield () => {
                addChild(f.sceneTree.root, f.container);
                removeChild(f.sceneTree.root, f.container);
            };
        }).gc(true);
    }
});

group('spawn churn: query count sweep @sweep @queries', () => {
    for (const extra of [0, 30]) {
        bench(`spawn+despawn 1 prop, ${extra + 2} queries`, function* () {
            const f = loadFixture(200, extra);
            addChild(f.sceneTree.root, f.container);
            const prop = buildProp(5);
            yield () => {
                addChild(f.container, prop);
                removeChild(f.container, prop);
            };
        }).gc(true);
    }
});
