// What does `interpolate()` cost as NPC count grows?
//
//   ./node_modules/.bin/tsx bench/probe-interp-walk.ts [maxRigs]
//
// `interpolate()` iterates `sceneTree.interpolating` and, per interp root, sweeps the
// subtree top-down (`sweepInterpolatedDescendants`). It used to mark the subtree's two
// interp dirty bits instead and let each bone recompose lazily, which cost the bit-set
// walk plus a per-bone walk up to the nearest clean ancestor; at 128 rigs the sweep took
// the frame from 0.107 ms to 0.066 ms and removed `updateInterpolatedWorldTransform`
// (16.2% self) from the profile entirely.
//
// Reported as one frame (snapshot + interpolate), plus the same frame with the render
// reads that clean the bits again, which is what makes the next frame's walk real work
// rather than a no-op over already-dirty nodes.

import { MeshTrait } from '../src/builtins/mesh';
import { ModelTrait } from '../src/builtins/model';
import { getWorldMatrix, setInterpolation, setPosition, TransformTrait } from '../src/builtins/transform';
import { getVisualWorldMatrix } from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree, type Node } from '../src/core/scene/scene-tree';
import { interpolate, snapshot } from '../src/render/transform/interpolation';

const MAX = Number(process.argv[2] ?? 1024);
const BONES = ['waist', 'body', 'head', 'arm_left', 'arm_right', 'leg_left', 'leg_right'] as const;
const PARENT_OF: Record<string, string | null> = {
    waist: null, leg_left: null, leg_right: null,
    body: 'waist', head: 'waist', arm_left: 'waist', arm_right: 'waist',
};

function buildRig(sceneTree: ReturnType<typeof createSceneTree>, i: number) {
    const rootNode = createNode({ name: `rig${i}` });
    addChild(sceneTree.root, rootNode);
    addTrait(rootNode, TransformTrait);
    addTrait(rootNode, ModelTrait);
    const byName = new Map<string, Node>();
    const bones: any[] = [];
    for (const name of BONES) {
        const n = createNode({ name });
        addChild(PARENT_OF[name] === null ? rootNode : byName.get(PARENT_OF[name]!)!, n);
        byName.set(name, n);
        addTrait(n, TransformTrait);
        const mesh = addTrait(n, MeshTrait) as any;
        mesh.meshId = { modelId: 'probe', meshName: name };
        bones.push(n.traits[(TransformTrait as any)._slot]);
    }
    // remote NPC: not owned by us, so interpolate() takes the chase-latest branch
    setInterpolation(rootNode, true);
    return { node: rootNode, root: rootNode.traits[(TransformTrait as any)._slot] as any, bones };
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

console.log(`\nremote NPC rigs, ${BONES.length} bones + 1 root each. best-of; budget 16.67 ms/frame\n`);
console.log(`${'rigs'.padStart(6)} ${'nodes'.padStart(7)} ${'frame'.padStart(9)} ${'us/rig'.padStart(8)} ${'ns/node'.padStart(8)}  rigs@16.67ms`);

for (const rigCount of [64, 128, 256, 512, MAX].filter((n, i, a) => n <= MAX && a.indexOf(n) === i)) {
    const sceneTree = createSceneTree();
    const rigs = [];
    for (let i = 0; i < rigCount; i++) rigs.push(buildRig(sceneTree, i));
    const nodes = rigCount * (BONES.length + 1);

    let tick = 0;
    // a full render frame: sim moves the roots, snapshot latches prev, interpolate
    // writes the visual pose and dirties every descendant, then the renderer reads
    // every bone's interpolated matrix (which is what re-cleans the bits).
    const frame = () => {
        tick++;
        for (let i = 0; i < rigs.length; i++) setPosition(rigs[i]!.root, [i * 0.01, tick * 0.001, 0]);
        snapshot(sceneTree);
        interpolate(sceneTree, 'nobody' as any, 0.5, 1 / 60);
        for (let i = 0; i < rigs.length; i++) {
            const bones = rigs[i]!.bones;
            for (let b = 0; b < bones.length; b++) getVisualWorldMatrix(bones[b]);
        }
    };

    const ms = best(frame, 60);
    console.log(
        `${String(rigCount).padStart(6)} ${String(nodes).padStart(7)} ${ms.toFixed(3).padStart(7)}ms ${((ms * 1000) / rigCount).toFixed(2).padStart(8)} ${((ms * 1e6) / nodes).toFixed(0).padStart(8)}  ${Math.floor((16.67 / ms) * rigCount)}`,
    );
}
console.log();
