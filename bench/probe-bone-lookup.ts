// character.ts resolves bones by name every frame, per character.
//
//   ./node_modules/.bin/tsx bench/probe-bone-lookup.ts [chars]
//
// `updateHeadOrientation` does one `findByName(node, 'head')`; `driveProceduralLocomotion`
// does five more via `applyLimb` (waist, leg_left, leg_right, arm_left, arm_right); the
// crouch path adds a seventh for `waist`. `findByName` allocates a `Node[]` stack and
// DFS-walks the rig comparing `node.name` strings.
//
// The rig already carries the answer: `CharacterTrait.state.modelHandle.nodes` is a
// name -> Node map the reconciler fills on mount. `applyWaistCrouchDrop` already uses it
// for the REST pose ("one indexed lookup with no findByName walk"), then calls
// findByName for the live bone two lines later.
//
// Both arms do the same setQuaternion work, so the delta is lookup only.

import { findByName, getTrait } from '../src/api/scene-tree';
import { MeshTrait } from '../src/builtins/mesh';
import { setQuaternion, TransformTrait } from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree, type Node } from '../src/core/scene/scene-tree';

const COUNT = Number(process.argv[2] ?? 1000);
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
// the seven lookups a walking, crouching character performs each frame
const PER_FRAME = ['head', 'waist', 'leg_left', 'leg_right', 'arm_left', 'arm_right', 'waist'] as const;

const sceneTree = createSceneTree();
const roots: Node[] = [];
const handles: Array<Record<string, Node>> = [];
for (let i = 0; i < COUNT; i++) {
    const rootNode = createNode({ name: `char${i}` });
    addChild(sceneTree.root, rootNode);
    addTrait(rootNode, TransformTrait);
    const byName: Record<string, Node> = {};
    for (const name of BONES) {
        const n = createNode({ name });
        addChild(PARENT_OF[name] === null ? rootNode : byName[PARENT_OF[name]!]!, n);
        byName[name] = n;
        addTrait(n, TransformTrait);
        (addTrait(n, MeshTrait) as any).meshId = { modelId: 'probe', meshName: name };
    }
    roots.push(rootNode);
    handles.push(byName); // stands in for state.modelHandle.nodes
}

const q = [0, 0, 0, 1] as [number, number, number, number];

function walkArm(): void {
    for (let i = 0; i < roots.length; i++) {
        const root = roots[i]!;
        for (let b = 0; b < PER_FRAME.length; b++) {
            const bone = findByName(root, PER_FRAME[b]!);
            if (!bone) continue;
            const t = getTrait(bone, TransformTrait);
            if (!t) continue;
            setQuaternion(t, q);
        }
    }
}

function indexedArm(): void {
    for (let i = 0; i < roots.length; i++) {
        const nodes = handles[i]!;
        for (let b = 0; b < PER_FRAME.length; b++) {
            const bone = nodes[PER_FRAME[b]!];
            if (!bone) continue;
            const t = getTrait(bone, TransformTrait);
            if (!t) continue;
            setQuaternion(t, q);
        }
    }
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

// interleave, discard the first pass of each
walkArm();
indexedArm();
const results: Array<[string, number]> = [];
for (let round = 0; round < 3; round++) {
    results.push(['findByName', best(walkArm, 30)]);
    results.push(['indexed', best(indexedArm, 30)]);
}
const bestOf = (name: string) => Math.min(...results.filter((r) => r[0] === name).map((r) => r[1]));
const w = bestOf('findByName');
const idx = bestOf('indexed');

console.log(`\n${COUNT} characters, ${PER_FRAME.length} bone lookups each per frame\n`);
console.log(`  findByName (current)  ${w.toFixed(3).padStart(7)} ms/frame`);
console.log(`  indexed (modelHandle) ${idx.toFixed(3).padStart(7)} ms/frame`);
console.log(`  ${(w / idx).toFixed(1)}x, ${(w - idx).toFixed(3)} ms/frame saved at ${COUNT} characters\n`);
