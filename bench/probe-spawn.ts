// spawn/despawn and attach/detach cost.
// run: node_modules/.bin/tsx bench/probe-spawn.ts

import { TransformTrait } from '../src/builtins/transform';
import { Optional, Up } from '../src/core/scene/conditions';
import {
    addChild,
    addTrait,
    createNode,
    createSceneTree,
    type Node,
    query,
    removeChild,
    type SceneTree,
} from '../src/core/scene/scene-tree';
import { trait } from '../src/core/scene/traits';

const Mesh = trait('probe/mesh', { id: 0 });
const VoxelMesh = trait('probe/voxel-mesh', { id: 0 });
const Model = trait('probe/model', { light: 0 });

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

function buildContainer(sceneTree: SceneTree, props: number, meshes: number): Node {
    const container = createNode({ name: 'container' });
    addChild(sceneTree.root, container);
    for (let i = 0; i < props; i++) addChild(container, buildProp(meshes));
    return container;
}

function measure(label: string, fn: () => void, iters: number): void {
    for (let i = 0; i < Math.min(iters, 500); i++) fn();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn();
    const t1 = process.hrtime.bigint();
    console.log(`${label.padEnd(46)} ${(Number(t1 - t0) / 1e3 / iters).toFixed(2)} µs`);
}

{
    const sceneTree = createSceneTree();
    const container = buildContainer(sceneTree, 200, 5);
    query(sceneTree, [Mesh, Optional(Up(Model))]);
    query(sceneTree, [VoxelMesh, Optional(Up(Model))]);
    const prop = buildProp(5);
    measure(
        'spawn+despawn 1 prop, 200 props present',
        () => {
            addChild(container, prop);
            removeChild(container, prop);
        },
        20000,
    );
}

{
    const sceneTree = createSceneTree();
    query(sceneTree, [Mesh, Optional(Up(Model))]);
    query(sceneTree, [VoxelMesh, Optional(Up(Model))]);
    const container = createNode({ name: 'container' });
    for (let i = 0; i < 17; i++) addChild(container, buildProp(5));
    measure(
        'attach+detach 102 nodes',
        () => {
            addChild(sceneTree.root, container);
            removeChild(sceneTree.root, container);
        },
        5000,
    );
}

{
    const sceneTree = createSceneTree();
    query(sceneTree, [Mesh, Optional(Up(Model))]);
    query(sceneTree, [VoxelMesh, Optional(Up(Model))]);
    const container = createNode({ name: 'container' });
    for (let i = 0; i < 200; i++) addChild(container, buildProp(5));
    measure(
        'attach+detach 1200 nodes',
        () => {
            addChild(sceneTree.root, container);
            removeChild(sceneTree.root, container);
        },
        500,
    );
}

{
    // 200 props built from scratch each iteration: the trait-instantiation path.
    const sceneTree = createSceneTree();
    query(sceneTree, [Mesh, Optional(Up(Model))]);
    measure(
        'build 200 detached props (1200 nodes)',
        () => {
            const container = createNode({ name: 'container' });
            for (let i = 0; i < 200; i++) addChild(container, buildProp(5));
            return container;
        },
        200,
    );
}

{
    const sceneTree = createSceneTree();
    query(sceneTree, [Mesh, Optional(Up(Model))]);
    const container = createNode({ name: 'container' });
    addChild(sceneTree.root, container);
    addTrait(container, TransformTrait);

    const prop = createNode({ name: 'prop' });
    addTrait(prop, TransformTrait);
    for (let i = 0; i < 63; i++) {
        const child = createNode({ name: `c${i}` });
        addTrait(child, TransformTrait);
        addChild(prop, child);
    }

    measure(
        'attach+detach 64 transforms under a transform',
        () => {
            addChild(container, prop);
            removeChild(container, prop);
        },
        20000,
    );
}
