// Times `concatenate()` alone, which is the only thing the translation-only fast path in
// `composeInterpolatedWorldMatrix` changes.
//
//   ./node_modules/.bin/tsx bench/probe-concat-fastpath.ts [chars] [rotatedFraction]
//
// A full-frame probe could not resolve this: between-run variance was ~45% on this
// machine, and concatenate is only a slice of that frame. This calls concatenate in a
// tight best-of loop with nothing else in it. `sweepInterpolatedDescendants` composes
// unconditionally, so repeated calls redo identical work and the loop is valid.
//
// Sweeps the rotated fraction because that is what decides the win, and real avatars
// measure 31-43% rotated at runtime (`probe-identity-fraction.mjs`). A rotated bone has a
// non-identity quaternion and takes the general path; the rest are translation-only.

import { MeshTrait } from '../src/builtins/mesh';
import { ModelTrait } from '../src/builtins/model';
import { setInterpolation, setQuaternion, TransformTrait } from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree, type Node } from '../src/core/scene/scene-tree';
import { concatenate, interpolate, snapshot } from '../src/render/transform/interpolation';

const CHARS = Number(process.argv[2] ?? 1000);
const BONES = ['waist', 'body', 'head', 'arm_left', 'arm_right', 'leg_left', 'leg_right'] as const;
const PARENT_OF: Record<string, string | null> = {
    waist: null, leg_left: null, leg_right: null,
    body: 'waist', head: 'waist', arm_left: 'waist', arm_right: 'waist',
};

/** rig shaped like a real avatar: a bone chain plus a mesh node per bone. */
function build(rotatedFraction: number) {
    const sceneTree = createSceneTree();
    let transforms = 0;
    let rotated = 0;
    for (let i = 0; i < CHARS; i++) {
        const rootNode = createNode({ name: `char${i}` });
        addChild(sceneTree.root, rootNode);
        addTrait(rootNode, TransformTrait);
        addTrait(rootNode, ModelTrait);
        const byName = new Map<string, Node>();
        let boneIdx = 0;
        for (const name of BONES) {
            const n = createNode({ name });
            addChild(PARENT_OF[name] === null ? rootNode : byName.get(PARENT_OF[name]!)!, n);
            byName.set(name, n);
            const t = addTrait(n, TransformTrait, { position: [0, 0.3, 0] } as any) as any;
            transforms++;
            // rotate the first `rotatedFraction` of bones, as an animator or applyLimb would
            if (boneIdx / (BONES.length * 2) < rotatedFraction) {
                setQuaternion(t, [0.2, 0, 0, 0.9797958971132712]);
                rotated++;
            }
            boneIdx++;

            const part = createNode({ name: `${name}_mesh` });
            addChild(n, part);
            addTrait(part, TransformTrait, { position: [0, 0.1, 0] } as any);
            (addTrait(part, MeshTrait) as any).meshId = { modelId: 'probe', meshName: name };
            transforms++;
            boneIdx++;
        }
        setInterpolation(rootNode, true);
    }
    snapshot(sceneTree);
    interpolate(sceneTree, 'nobody' as any, 0.5, 1 / 60);
    return { sceneTree, transforms: transforms / CHARS, rotated: rotated / CHARS };
}

function best(fn: () => void, reps: number): number {
    for (let i = 0; i < 30; i++) fn();
    let b = Infinity;
    for (let r = 0; r < reps; r++) {
        const t0 = process.hrtime.bigint();
        fn();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms < b) b = ms;
    }
    return b;
}

console.log(`\nconcatenate() alone, ${CHARS} characters. best-of-120.\n`);
console.log(`${'rotated'.padStart(8)} ${'transforms/rig'.padStart(15)} ${'ms'.padStart(8)} ${'ns/transform'.padStart(13)}`);

for (const frac of [0, 0.25, 0.43, 0.6, 1]) {
    const w = build(frac);
    const ms = best(() => concatenate(w.sceneTree), 120);
    const total = CHARS * w.transforms;
    console.log(
        `${`${(frac * 100).toFixed(0)}%`.padStart(8)} ${w.transforms.toFixed(0).padStart(15)} ${ms.toFixed(3).padStart(8)} ${((ms * 1e6) / total).toFixed(1).padStart(13)}`,
    );
}
console.log('\nReal avatars: 31-43% rotated at runtime.\n');
