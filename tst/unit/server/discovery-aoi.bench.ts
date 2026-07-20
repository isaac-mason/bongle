import { bench, describe } from 'vitest';
import { setPosition, TransformTrait } from '../../../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree, reconcileRootChunks } from '../../../src/core/scene/scene-tree';

// ── reconcileRootChunks bench ────────────────────────────────────────
//
// the per-tick transform-root chunk-index maintenance introduced for chunk-tied
// AOI. it runs once per room each tick, off dirtyNodes, and files/unfiles/rebuckets
// transform roots + emits the rootChunkChanges changeset the presence pass consumes.
//
// the point of the design is that steady-state cost is O(roots that MOVED), not
// O(total roots): a mostly-static world with a few hundred movers pays for the
// movers, not the whole scene. these benches make that visible — compare the "cross
// a chunk boundary" and "move within chunk" passes (which touch only the movers)
// against the "cold file all" pass (the join / mass-spawn one-off).
//
// run: `pnpm bench discovery-aoi`.

const N = 2000; // total transform roots in the world
const MOVERS = 200; // how many move each tick

// a world of N transform roots, each a direct child of root (so it IS a transform
// root), spread across distinct chunks. the index is pre-seeded so the benched pass
// measures steady-state reconcile, not first-file.
function world() {
    const sceneTree = createSceneTree();
    const roots: Array<{ node: ReturnType<typeof createNode>; t: TransformTrait }> = [];
    for (let i = 0; i < N; i++) {
        const node = createNode();
        addChild(sceneTree.root, node);
        const t = addTrait(node, TransformTrait);
        setPosition(t, [i * 64, 0, 0]); // 4 chunks apart, all distinct
        roots.push({ node, t });
        sceneTree.dirtyNodes.add(node);
    }
    reconcileRootChunks(sceneTree); // seed: files all N
    sceneTree.dirtyNodes.clear();
    return { sceneTree, roots };
}

describe('reconcileRootChunks', () => {
    {
        // COLD (build): the true join / mass-spawn one-off — CONSTRUCT N transform
        // nodes AND file them. dominated by addTrait(TransformTrait) + setPosition,
        // NOT by reconcile; kept to show where the join cost actually goes.
        bench(`cold-build: construct + file ${N} roots`, () => {
            const sceneTree = createSceneTree();
            for (let i = 0; i < N; i++) {
                const node = createNode();
                addChild(sceneTree.root, node);
                setPosition(addTrait(node, TransformTrait), [i * 64, 0, 0]);
                sceneTree.dirtyNodes.add(node);
            }
            reconcileRootChunks(sceneTree);
        });
    }
    {
        // COLD (index): the file-all bookkeeping in isolation — scene built once
        // outside the loop, then each iteration resets the index and re-files all N.
        // (worldChunk is cached from the seed, so this is pure map/Set/changeset cost;
        // a genuinely fresh spawn adds one getWorldChunk matrix decompose per root.)
        const { sceneTree, roots } = world();
        bench(`cold-index: re-file all ${N} roots into a fresh index`, () => {
            sceneTree.chunkToRoots.clear();
            sceneTree.rootToChunk.clear();
            for (const r of roots) sceneTree.dirtyNodes.add(r.node);
            reconcileRootChunks(sceneTree);
            sceneTree.dirtyNodes.clear();
        });
    }
    {
        // HOT: MOVERS of N cross a chunk boundary each tick → unfile + file + changeset.
        // this is the steady-state cost the design optimises: O(movers), not O(N).
        const { sceneTree, roots } = world();
        let tick = 0;
        bench(`hot: ${MOVERS}/${N} roots cross a chunk boundary`, () => {
            tick++;
            for (let i = 0; i < MOVERS; i++) {
                const r = roots[i]!;
                setPosition(r.t, [i * 64 + tick * 16, 0, 0]); // +1 chunk each tick
                sceneTree.dirtyNodes.add(r.node);
            }
            reconcileRootChunks(sceneTree);
            sceneTree.dirtyNodes.clear();
        });
    }
    {
        // WARM: MOVERS dirty but moving WITHIN their chunk → getWorldChunk + compare,
        // no rebucket (the `filed === key` fast path). the cheapest per-mover cost.
        const { sceneTree, roots } = world();
        let tick = 0;
        bench(`warm: ${MOVERS}/${N} roots move within their chunk`, () => {
            tick++;
            for (let i = 0; i < MOVERS; i++) {
                const r = roots[i]!;
                setPosition(r.t, [i * 64 + (tick % 8), 0, 0]); // stays inside the chunk
                sceneTree.dirtyNodes.add(r.node);
            }
            reconcileRootChunks(sceneTree);
            sceneTree.dirtyNodes.clear();
        });
    }
});
