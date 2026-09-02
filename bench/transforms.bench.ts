// scene tree transform write / invalidate / read cost.
// run: labs transforms

import { bench, group } from '@pmndrs/labs';
import type { Vec3 } from 'math';
import {
    computeWorldTransforms,
    getVisualWorldMatrix,
    getWorldMatrix,
    getWorldPosition,
    getWorldQuaternion,
    setInterpolation,
    setPosition,
    TransformTrait,
} from '../src/builtins/transform';
import {
    addChild,
    addTrait,
    createNode,
    createSceneTree,
    type Node,
    removeTrait,
    reparent,
    type SceneTree,
} from '../src/core/scene/scene-tree';

/* ── fixture helpers ── */

/** a node carrying a TransformTrait, attached to `parent`. */
function transformNode(parent: Node, name: string): TransformTrait {
    const node = createNode({ name });
    addChild(parent, node);
    return addTrait(node, TransformTrait);
}

/** a node with NO TransformTrait: the logical / passthrough case. */
function logicalNode(parent: Node, name: string): Node {
    const node = createNode({ name });
    addChild(parent, node);
    return node;
}

function buildChain(sceneTree: SceneTree, depth: number, passthrough = 0): TransformTrait[] {
    const chain: TransformTrait[] = [];
    let cursor: Node = sceneTree.root;
    for (let i = 0; i < depth; i++) {
        for (let p = 0; p < passthrough; p++) cursor = logicalNode(cursor, `p${i}_${p}`);
        const transform = transformNode(cursor, `t${i}`);
        chain.push(transform);
        cursor = transform._node;
    }
    return chain;
}

/** one root with `width` transform children: the "container of props" shape. */
function buildFan(sceneTree: SceneTree, width: number): { root: TransformTrait; children: TransformTrait[] } {
    const root = transformNode(sceneTree.root, 'root');
    const children: TransformTrait[] = [];
    for (let i = 0; i < width; i++) children.push(transformNode(root._node, `c${i}`));
    return { root, children };
}

/** `props` model roots, each with `meshes` transform children. Depth 2. */
function buildProps(sceneTree: SceneTree, props: number, meshes: number): TransformTrait[] {
    const roots: TransformTrait[] = [];
    for (let i = 0; i < props; i++) {
        const root = transformNode(sceneTree.root, `prop${i}`);
        for (let m = 0; m < meshes; m++) transformNode(root._node, `m${m}`);
        roots.push(root);
    }
    return roots;
}

/** writes distinct values so nothing can be optimised away as a no-op store. */
function makeWriter(targets: TransformTrait[]): () => number {
    const p: Vec3 = [0, 0, 0];
    let phase = 0;
    return () => {
        phase += 0.01;
        p[0] = Math.sin(phase);
        p[1] = phase;
        for (let i = 0; i < targets.length; i++) setPosition(targets[i]!, p);
        return targets.length;
    };
}

/* ── local writes, no descendants ── */

group('transforms: local write floor @xform @write', () => {
    for (const count of [1, 100, 2000]) {
        bench(`setPosition on ${count} childless transforms`, function* () {
            const sceneTree = createSceneTree();
            const targets: TransformTrait[] = [];
            for (let i = 0; i < count; i++) targets.push(transformNode(sceneTree.root, `n${i}`));
            const write = makeWriter(targets);
            yield write;
        }).gc(true);
    }

    // the same writes with the per-tick drain the engine's snapshot pass does,
    // so `_transformDirty` re-fills from empty instead of re-hitting warm keys.
    bench('setPosition on 2000, draining _transformDirty each iteration', function* () {
        const sceneTree = createSceneTree();
        const targets: TransformTrait[] = [];
        for (let i = 0; i < 2000; i++) targets.push(transformNode(sceneTree.root, `n${i}`));
        const write = makeWriter(targets);
        yield () => {
            sceneTree._transformDirty.clear();
            return write();
        };
    }).gc(true);
});

/* ── descendant invalidation ── */

group('transforms: descendant invalidation, subtree size @xform @invalidate', () => {
    for (const width of [8, 64, 512]) {
        bench(`write root of a fan of ${width} transforms`, function* () {
            const sceneTree = createSceneTree();
            const f = buildFan(sceneTree, width);
            // clean the subtree so each write does a full invalidation walk.
            computeWorldTransforms(sceneTree);
            const write = makeWriter([f.root]);
            yield () => {
                const n = write();
                // read one leaf so the next write starts from clean again.
                getWorldMatrix(f.children[width - 1]!);
                return n;
            };
        }).gc(true);
    }
});

group('transforms: passthrough (logical-only) nodes @xform @invalidate @passthrough', () => {
    for (const passthrough of [0, 1, 4]) {
        bench(`write root of a 16-deep chain, ${passthrough} passthrough nodes per link`, function* () {
            const sceneTree = createSceneTree();
            const chain = buildChain(sceneTree, 16, passthrough);
            computeWorldTransforms(sceneTree);
            const write = makeWriter([chain[0]!]);
            yield () => {
                const n = write();
                getWorldMatrix(chain[15]!);
                return n;
            };
        }).gc(true);
    }
});

/* ── world reads ── */

group('transforms: world reads @xform @read', () => {
    bench('getWorldMatrix x2000, all clean (cache hit)', function* () {
        const sceneTree = createSceneTree();
        const props = buildProps(sceneTree, 400, 4);
        computeWorldTransforms(sceneTree);
        yield () => {
            let acc = 0;
            for (let i = 0; i < props.length; i++) acc += getWorldMatrix(props[i]!)[12]!;
            return acc;
        };
    }).gc(true);

    for (const depth of [2, 8, 32]) {
        bench(`getWorldMatrix on a ${depth}-deep chain, root dirtied each iteration`, function* () {
            const sceneTree = createSceneTree();
            const chain = buildChain(sceneTree, depth);
            computeWorldTransforms(sceneTree);
            const write = makeWriter([chain[0]!]);
            yield () => {
                write();
                return getWorldMatrix(chain[depth - 1]!)[12]!;
            };
        }).gc(true);
    }

    bench('getWorldPosition + getWorldQuaternion (decompose) x1000, dirtied', function* () {
        const sceneTree = createSceneTree();
        const roots = buildProps(sceneTree, 200, 4);
        const leaves: TransformTrait[] = [];
        for (const root of roots) {
            for (const child of root._node.children) {
                const t = child._traits[TransformTrait._slot] as TransformTrait;
                leaves.push(t);
            }
        }
        const write = makeWriter(roots);
        yield () => {
            write();
            let acc = 0;
            for (let i = 0; i < leaves.length; i++) {
                acc += getWorldPosition(leaves[i]!)[0]! + getWorldQuaternion(leaves[i]!)[3]!;
            }
            return acc;
        };
    }).gc(true);
});

/* ── the parallel interpolated (visual) chain ── */

group('transforms: visual chain @xform @visual', () => {
    bench('getVisualWorldMatrix x2000, not interpolated (world short-circuit)', function* () {
        const sceneTree = createSceneTree();
        const props = buildProps(sceneTree, 400, 4);
        computeWorldTransforms(sceneTree);
        yield () => {
            let acc = 0;
            for (let i = 0; i < props.length; i++) acc += getVisualWorldMatrix(props[i]!)[12]!;
            return acc;
        };
    }).gc(true);

    bench('getVisualWorldMatrix x2000, interpolated, dirtied each iteration', function* () {
        const sceneTree = createSceneTree();
        const props = buildProps(sceneTree, 400, 4);
        for (const t of props) setInterpolation(t._node, true);
        // force the visual chain on: the getters short-circuit to world while
        // `_interpolated` is 0.
        for (const t of props) t._interpolated = 1;
        const write = makeWriter(props);
        yield () => {
            write();
            let acc = 0;
            for (let i = 0; i < props.length; i++) acc += getVisualWorldMatrix(props[i]!)[12]!;
            return acc;
        };
    }).gc(true);
});

/* ── batch recompute ── */

group('transforms: computeWorldTransforms @xform @batch', () => {
    for (const [props, meshes, total] of [
        [200, 5, 1200],
        [1000, 5, 6000],
    ] as const) {
        bench(`computeWorldTransforms over ${total} nodes, all dirty`, function* () {
            const sceneTree = createSceneTree();
            const roots = buildProps(sceneTree, props, meshes);
            const write = makeWriter(roots);
            yield () => {
                write();
                computeWorldTransforms(sceneTree);
                return roots.length;
            };
        }).gc(true);

        bench(`computeWorldTransforms over ${total} nodes, all clean`, function* () {
            const sceneTree = createSceneTree();
            buildProps(sceneTree, props, meshes);
            computeWorldTransforms(sceneTree);
            yield () => {
                computeWorldTransforms(sceneTree);
                return total;
            };
        }).gc(true);
    }
});

/* ── structural churn ── */

group('transforms: add/remove/reparent @xform @spawn', () => {
    bench('addTrait+removeTrait TransformTrait, 1000 nodes present', function* () {
        const sceneTree = createSceneTree();
        buildProps(sceneTree, 200, 4);
        const node = createNode({ name: 'churn' });
        addChild(sceneTree.root, node);
        yield () => {
            const t = addTrait(node, TransformTrait);
            removeTrait(node, TransformTrait);
            return t._version;
        };
    }).gc(true);

    for (const size of [6, 64]) {
        bench(`reparent a ${size}-transform subtree (markAncestryChanged)`, function* () {
            const sceneTree = createSceneTree();
            const a = transformNode(sceneTree.root, 'a');
            const b = transformNode(sceneTree.root, 'b');
            const sub = transformNode(a._node, 'sub');
            for (let i = 1; i < size; i++) transformNode(sub._node, `s${i}`);
            computeWorldTransforms(sceneTree);
            yield () => {
                reparent(sub._node, b._node);
                reparent(sub._node, a._node);
                return sub._version;
            };
        }).gc(true);
    }
});
