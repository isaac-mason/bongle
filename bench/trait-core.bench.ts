// ── trait + query core: where the bytes and the time go ─────────────
//
// run: pnpm bench trait-core
//
// `scene-shapes` measures whole mutations. This file isolates the primitives
// underneath them, and attributes allocation by ablation: each group varies
// exactly one thing, so the heap/iter delta between siblings IS the cost of
// that thing. labs' heap metric is per-iteration with gc(true), which is the
// only allocation number here worth trusting.

import { bench, group } from '@pmndrs/labs';
import { Not, Optional, Up } from '../src/core/scene/conditions';
import {
    addChild,
    addTrait,
    createNode,
    createSceneTree,
    getTrait,
    type Node,
    query,
    removeChild,
    removeTrait,
    type SceneTree,
} from '../src/core/scene/scene-tree';
import { trait } from '../src/core/scene/traits';

const A = trait('core/a', { x: 0 });
const B = trait('core/b', { y: 0 });
const C = trait('core/c', { z: 0 });
const Absent = trait('core/absent', { n: 0 });
const Wide = trait('core/wide', { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, h: 0 });

group('trait core: node cost @traits @alloc', () => {
    bench('createNode, bare', function* () {
        yield () => createNode({ name: 'n' });
    }).gc(true);

    bench('createNode + 1 trait', function* () {
        yield () => addTrait(createNode({ name: 'n' }), A);
    }).gc(true);

    bench('createNode + 3 traits', function* () {
        yield () => {
            const n = createNode({ name: 'n' });
            addTrait(n, A);
            addTrait(n, B);
            addTrait(n, C);
        };
    }).gc(true);

    bench('createNode + 1 wide trait (8 fields)', function* () {
        yield () => addTrait(createNode({ name: 'n' }), Wide);
    }).gc(true);
});

group('trait core: add/remove churn on a live node @traits @churn', () => {
    for (const queries of [0, 4]) {
        bench(`addTrait+removeTrait, ${queries} queries watching`, function* () {
            const sceneTree = createSceneTree();
            for (let i = 0; i < queries; i++) query(sceneTree, [A]);
            const node = createNode({ name: 'n' });
            addChild(sceneTree.root, node);
            yield () => {
                addTrait(node, A);
                removeTrait(node, A);
            };
        }).gc(true);
    }
});

group('trait core: getTrait read @traits @read', () => {
    const sceneTree = createSceneTree();
    const shallow = createNode({ name: 'shallow' });
    addTrait(shallow, A);
    addChild(sceneTree.root, shallow);
    const many = createNode({ name: 'many' });
    for (const t of [A, B, C, Wide]) addTrait(many, t);
    addChild(sceneTree.root, many);

    bench('getTrait present, 1 trait on node', function* () {
        yield () => getTrait(shallow, A);
    });
    bench('getTrait present, 4 traits on node', function* () {
        yield () => getTrait(many, Wide);
    });
    bench('getTrait absent', function* () {
        yield () => getTrait(shallow, C);
    });
});

/** attach+detach ablation: isolate what each layer of the subtree walk costs. */
function buildFlat(count: number, withTrait: boolean): Node {
    const container = createNode({ name: 'container' });
    for (let i = 0; i < count; i++) {
        const n = createNode({ name: `n${i}` });
        if (withTrait) addTrait(n, A);
        addChild(container, n);
    }
    return container;
}

group('trait core: attach+detach ablation, 1200 flat nodes @traits @alloc', () => {
    const cases: Array<[string, boolean, number, boolean]> = [
        ['no traits, no queries', false, 0, false],
        ['1 trait, no queries', true, 0, false],
        ['1 trait, 1 plain query', true, 1, false],
        ['1 trait, 1 resolving query', true, 1, true],
    ];
    for (const [label, withTrait, queries, resolving] of cases) {
        bench(label, function* () {
            const sceneTree: SceneTree = createSceneTree();
            for (let i = 0; i < queries; i++) {
                if (resolving) query(sceneTree, [A, Optional(Up(B))]);
                else query(sceneTree, [A]);
            }
            const container = buildFlat(1200, withTrait);
            yield () => {
                addChild(sceneTree.root, container);
                removeChild(sceneTree.root, container);
            };
        }).gc(true);
    }
});

/** 1200 nodes each carrying A, B and C, so tuple width is the only variable. */
function buildTriple(count: number): Node {
    const container = createNode({ name: 'container' });
    for (let i = 0; i < count; i++) {
        const n = createNode({ name: `n${i}` });
        addTrait(n, A);
        addTrait(n, B);
        addTrait(n, C);
        addChild(container, n);
    }
    return container;
}

group('trait core: query membership by tuple width, 1200 nodes @queries @alloc', () => {
    const widths: Array<[string, (t: SceneTree) => void]> = [
        ['no query (baseline)', () => {}],
        ['1 condition', (t) => void query(t, [A])],
        ['2 conditions', (t) => void query(t, [A, B])],
        ['3 conditions', (t) => void query(t, [A, B, C])],
        // Not contributes no tuple entry, so this isolates the cost of the empty
        // array object from the cost of what goes in it.
        ['1 Not condition (empty tuple)', (t) => void query(t, [Not(Absent)])],
    ];
    for (const [label, install] of widths) {
        bench(label, function* () {
            const sceneTree = createSceneTree();
            install(sceneTree);
            const container = buildTriple(1200);
            yield () => {
                addChild(sceneTree.root, container);
                removeChild(sceneTree.root, container);
            };
        }).gc(true);
    }
});
