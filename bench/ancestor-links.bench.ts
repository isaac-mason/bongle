// ── ancestor links: relink cost per structural mutation ─────────────
//
// run: pnpm bench            (all)
//      pnpm bench --filter relink
//
// `Up` / `Ancestor` terms resolve against the hierarchy, so their cost lands on
// structural mutations, not on reads — a match holds its resolved value in the
// tuple and a linked field holds it directly, so reading is an array index.
//
// Every bench here builds its scene in the generator body, before the `yield`,
// so only the mutation is measured. That distinction matters: an earlier vitest
// version built the tree inside the measured closure and node construction
// swamped the signal entirely.

import { bench, group } from '@pmndrs/labs';
import { Optional, Up } from '../src/core/scene/conditions';
import { addChild, addTrait, createNode, createSceneTree, type Node, query, reparent } from '../src/core/scene/scene-tree';
import { trait } from '../src/core/scene/traits';

const Mesh = trait('bench/link-mesh', { id: 0 });
const Group = trait('bench/link-group', { name: '' });

/** distinct link targets, so links can't share a descent unless we make them. */
const Targets = Array.from({ length: 16 }, (_, i) => trait(`bench/link-target-${i}`, { n: 0 }));
/** distinct owner traits, for links that DO share one target. */
const Owners = Array.from({ length: 16 }, (_, i) => trait(`bench/link-owner-${i}`, { n: 0 }));

/**
 * a chain of `count` nodes, every node carrying Mesh (and every owner trait, so
 * same-target links all have something to write). `groupEvery` places a Group
 * every N nodes: 1 prunes the descent immediately, 0 never prunes.
 */
function buildSubtree(count: number, groupEvery: number, owners = 0): Node {
    const root = createNode({ name: 'sub' });
    addTrait(root, Mesh);
    let cur = root;
    for (let i = 1; i < count; i++) {
        const n = createNode({ name: `n${i}` });
        addTrait(n, Mesh);
        for (let o = 0; o < owners; o++) addTrait(n, Owners[o]!);
        if (groupEvery > 0 && i % groupEvery === 0) addTrait(n, Group);
        addChild(cur, n);
        cur = n;
    }
    return root;
}

/** two group hosts with a subtree parked under `a`, ready to swing to `b`. */
function swingFixture(opts: {
    count: number;
    groupEvery?: number;
    /** links on distinct targets — the shape a shared descent cannot help. */
    distinctLinks?: number;
    /** links sharing ONE target — the shape a shared descent collapses. */
    sharedLinks?: number;
    /** both hosts under one Group, so a move resolves identically either side. */
    unchanged?: boolean;
}) {
    const sceneTree = createSceneTree();
    let a: Node;
    let b: Node;
    if (opts.unchanged) {
        const host = createNode({ name: 'host' });
        addChild(sceneTree.root, host);
        addTrait(host, Group, { name: 'host' });
        a = createNode({ name: 'a' });
        b = createNode({ name: 'b' });
        addChild(host, a);
        addChild(host, b);
    } else {
        a = createNode({ name: 'a' });
        b = createNode({ name: 'b' });
        addChild(sceneTree.root, a);
        addChild(sceneTree.root, b);
        addTrait(a, Group, { name: 'a' });
        addTrait(b, Group, { name: 'b' });
    }

    for (let i = 0; i < (opts.distinctLinks ?? 0); i++) {
        query(sceneTree, [Mesh, Optional(Up(Targets[i]!))]);
    }
    for (let i = 0; i < (opts.sharedLinks ?? 0); i++) {
        query(sceneTree, [Owners[i]!, Optional(Up(Group))]);
    }

    const sub = buildSubtree(opts.count, opts.groupEvery ?? 0, opts.sharedLinks ?? 0);
    addChild(a, sub);
    return { a, b, sub };
}

group('relink: cost of one traversal link @relink', () => {
    bench('reparent 64, no links', function* () {
        const f = swingFixture({ count: 64 });
        yield () => {
            reparent(f.sub, f.b);
            reparent(f.sub, f.a);
        };
    })
        .gc(true)
        .baseline(true);

    bench('reparent 64, 1 link', function* () {
        const f = swingFixture({ count: 64, sharedLinks: 1 });
        yield () => {
            reparent(f.sub, f.b);
            reparent(f.sub, f.a);
        };
    }).gc(true);
});

group('relink: N links on ONE target @relink @shared', () => {
    for (const n of [1, 4, 16]) {
        bench(`reparent 64, ${n} shared-target links`, function* () {
            const f = swingFixture({ count: 64, sharedLinks: n });
            yield () => {
                reparent(f.sub, f.b);
                reparent(f.sub, f.a);
            };
        }).gc(true);
    }
});

group('relink: N links on DISTINCT targets @relink @distinct', () => {
    for (const n of [1, 4, 16]) {
        bench(`reparent 64, ${n} distinct-target links`, function* () {
            const f = swingFixture({ count: 64, distinctLinks: n });
            yield () => {
                reparent(f.sub, f.b);
                reparent(f.sub, f.a);
            };
        }).gc(true);
    }
});

group('relink: pruning @relink @prune', () => {
    for (const [label, groupEvery] of [
        ['never (worst case)', 0],
        ['every 8', 8],
        ['every node', 1],
    ] as const) {
        bench(`reparent 64, prune ${label}`, function* () {
            const f = swingFixture({ count: 64, groupEvery, sharedLinks: 1 });
            yield () => {
                reparent(f.sub, f.b);
                reparent(f.sub, f.a);
            };
        }).gc(true);
    }
});

group('relink: move that resolves identically @relink @skip', () => {
    for (const n of [1, 16]) {
        bench(`reparent 64, ${n} links, same resolution`, function* () {
            const f = swingFixture({ count: 64, sharedLinks: n, unchanged: true });
            yield () => {
                reparent(f.sub, f.b);
                reparent(f.sub, f.a);
            };
        }).gc(true);
    }
});

group('relink: subtree size @relink @size', () => {
    for (const size of [16, 64, 256]) {
        bench(`reparent ${size}, 1 link`, function* () {
            const f = swingFixture({ count: size, sharedLinks: 1 });
            yield () => {
                reparent(f.sub, f.b);
                reparent(f.sub, f.a);
            };
        }).gc(true);
    }
});
