// does repeated addTrait/removeTrait under watching queries grow without bound?
//   NODE_OPTIONS=--expose-gc ./node_modules/.bin/tsx bench/probe-query-churn.ts [queries]
import { addChild, addTrait, createNode, createSceneTree, query, removeTrait } from '../src/core/scene/scene-tree';
import { trait } from '../src/core/scene/traits';

const QUERIES = Number(process.argv[2] ?? 4);
const A = trait('churn/a', { x: 0 });

const sceneTree = createSceneTree();
const queries = [];
for (let i = 0; i < QUERIES; i++) queries.push(query(sceneTree, [A]));
const node = createNode({ name: 'n' });
addChild(sceneTree.root, node);

const gc = (globalThis as any).gc as () => void;
const BATCH = 200_000;
for (let batch = 0; batch < 5; batch++) {
    gc();
    gc();
    const before = process.memoryUsage().heapUsed;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < BATCH; i++) {
        addTrait(node, A);
        removeTrait(node, A);
    }
    const t1 = process.hrtime.bigint();
    gc();
    gc();
    const retained = process.memoryUsage().heapUsed - before;
    const q0 = queries[0]!;
    console.log(
        `batch ${batch}  ${(Number(t1 - t0) / BATCH).toFixed(0).padStart(4)} ns/cycle` +
            `  retained ${(retained / 1024).toFixed(1).padStart(8)} kb` +
            `  matches=${q0.matches.length} matchNodes=${q0.matchNodes.length} sparse=${(q0 as any)._sparse.length}`,
    );
}
