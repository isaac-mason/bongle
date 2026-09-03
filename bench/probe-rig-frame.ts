// How many moving 6-bone rigs fit in a frame, across the transform and model systems?
//
//   ./node_modules/.bin/tsx bench/probe-rig-frame.ts [maxRigs]
//
// The per-frame shape a rig actually costs, in three parts:
//
//   move    setPosition on each rig root. Dirties the root and, via `markDescendants`,
//           every bone under it.
//   world   read every bone's world matrix. This is the lazy walk-up-then-compose-down,
//           i.e. where the matrix math lands.
//   query   iterate `[MeshTrait, TransformTrait, Optional(Up(ModelTrait))]` exactly as
//           `model-visuals` phase 1 does, including the tuple destructure and the
//           `_state`/`meshId` fast-path check.
//
// Stops short of the GPU instance-buffer writes: `ModelVisuals.update` needs a ModelBatch,
// ModelResources, Resources, Visibility and Voxels, which is the reason no bench for this
// existed. Everything upstream of that write is here and is real.
//
// Rig shape is the engine's canonical 6-bone parenting (see character.ts):
//
//     rigRoot (ModelTrait)
//       ├ waist
//       │   ├ body ├ head ├ arm_left ├ arm_right
//       ├ leg_left
//       └ leg_right

import { ModelTrait } from '../src/builtins/model';
import { MeshTrait } from '../src/builtins/mesh';
import { getWorldMatrix, setPosition, TransformTrait } from '../src/builtins/transform';
import { Optional, Up } from '../src/core/scene/conditions';
import { addChild, addTrait, createNode, createSceneTree, type Node, query } from '../src/core/scene/scene-tree';

const MAX = Number(process.argv[2] ?? 4000);
const BONES = ['waist', 'body', 'head', 'arm_left', 'arm_right', 'leg_left', 'leg_right'] as const;
const PARENT_OF: Record<string, string | null> = {
    waist: null,
    leg_left: null,
    leg_right: null,
    body: 'waist',
    head: 'waist',
    arm_left: 'waist',
    arm_right: 'waist',
};

type Rig = { root: any; bones: any[] };

/** one rig: a ModelTrait root plus the canonical bones, each a mesh-bearing transform. */
function buildRig(sceneTree: ReturnType<typeof createSceneTree>, i: number): Rig {
    const rootNode = createNode({ name: `rig${i}` });
    addChild(sceneTree.root, rootNode);
    addTrait(rootNode, TransformTrait);
    addTrait(rootNode, ModelTrait);

    const byName = new Map<string, Node>();
    const bones: any[] = [];
    for (const name of BONES) {
        const n = createNode({ name });
        const parentName = PARENT_OF[name];
        addChild(parentName === null ? rootNode : byName.get(parentName)!, n);
        byName.set(name, n);
        addTrait(n, TransformTrait);
        // a real mesh trait, so the query matches and phase 1's fast path is exercised
        const mesh = addTrait(n, MeshTrait) as any;
        mesh.meshId = { modelId: 'probe', meshName: name };
        bones.push(n._traits[TransformTrait._slot]);
    }
    return { root: rootNode._traits[TransformTrait._slot], bones };
}

function best(fn: () => void, reps: number): number {
    for (let i = 0; i < 20; i++) fn();
    let b = Infinity;
    for (let r = 0; r < reps; r++) {
        const t0 = process.hrtime.bigint();
        fn();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms < b) b = ms;
    }
    return b;
}

console.log(`\n6-bone rigs, ${BONES.length} bones + 1 root each. best-of; budget 16.67 ms/frame\n`);
console.log(
    `${'rigs'.padStart(6)} ${'nodes'.padStart(7)} ${'move'.padStart(8)} ${'world'.padStart(8)} ${'query'.padStart(8)} ${'total'.padStart(8)}   ${'us/rig'.padStart(7)}  frames@16.67ms`,
);

for (const rigCount of [64, 256, 1024, 2048, MAX].filter((n, i, a) => n <= MAX && a.indexOf(n) === i)) {
    const sceneTree = createSceneTree();
    const q = query(sceneTree, [MeshTrait, TransformTrait, Optional(Up(ModelTrait))]);
    const rigs: Rig[] = [];
    for (let i = 0; i < rigCount; i++) rigs.push(buildRig(sceneTree, i));

    let tick = 0;
    const move = () => {
        tick++;
        for (let i = 0; i < rigs.length; i++) setPosition(rigs[i]!.root, [i * 0.01, tick * 0.001, 0]);
    };
    const world = () => {
        for (let i = 0; i < rigs.length; i++) {
            const bones = rigs[i]!.bones;
            for (let b = 0; b < bones.length; b++) getWorldMatrix(bones[b]);
        }
    };
    // model-visuals phase 1, minus the GPU write
    let frameId = 0;
    let seen = 0;
    const iterate = () => {
        frameId++;
        for (const [meshTrait, , model] of q.matches) {
            const state = (meshTrait as any)._state;
            const meshId = (meshTrait as any).meshId;
            if (state !== null && state.meshIdRef === meshId && meshId !== null) {
                state.lastSeenFrame = frameId;
                state.model = model;
                continue;
            }
            seen += model === null ? 1 : 2;
        }
    };

    const tMove = best(move, 200);
    const tWorld = best(() => {
        move();
        world();
    }, 200);
    const tQuery = best(iterate, 200);
    const worldOnly = Math.max(tWorld - tMove, 0);
    const total = tMove + worldOnly + tQuery;
    const nodes = rigCount * (BONES.length + 1);
    console.log(
        `${String(rigCount).padStart(6)} ${String(nodes).padStart(7)} ${tMove.toFixed(3).padStart(8)} ${worldOnly.toFixed(3).padStart(8)} ${tQuery.toFixed(3).padStart(8)} ${total.toFixed(3).padStart(8)}   ${((total / rigCount) * 1000).toFixed(2).padStart(7)}  ${Math.floor((16.67 / total) * rigCount)}`,
    );
    if (seen < 0) throw new Error('unreachable');
}
