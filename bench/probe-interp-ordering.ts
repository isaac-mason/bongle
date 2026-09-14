// Where should the interp subtree concatenation run in the frame?
//
//   ./node_modules/.bin/tsx bench/probe-interp-ordering.ts [chars]
//
// The client render pass writes bone locals in three phases after `interpolate()`:
// frame scripts (character locomotion), the animator, and post-animate hooks. Anything
// composed before those is dirtied by them and composed again on read, so composing the
// subtree at the top of the frame is work that is thrown away.
//
// Two arms, identical work, differing only in WHERE `concatenate()` is called:
//
//   early   interpolate(); concatenate(); locomotion(); read     (what shipped)
//   late    interpolate(); locomotion(); concatenate(); read     (godot's second pass)
//
// Wall time is the weaker evidence here and the ordering is the point: the previous
// benchmark for this code path measured 1.55x by running locomotion BEFORE interpolate,
// which structurally could not observe the duplication it was meant to measure. Counting
// `composeInterpolatedWorldMatrix` calls during development gave the deterministic answer:
// 2.00 composes per bone per frame on `early`, exactly 1.00 on `late`.

import { MeshTrait } from '../src/builtins/mesh';
import { getVisualWorldMatrix, setInterpolation, setPosition, setQuaternion, TransformTrait } from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree, type Node } from '../src/core/scene/scene-tree';
import { concatenate, interpolate, snapshot } from '../src/render/transform/interpolation';

const CHARS = Number(process.argv[2] ?? 1000);
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
// character.ts writes these every frame: applyLimb x5 plus updateHeadOrientation
const DRIVEN = ['waist', 'leg_left', 'leg_right', 'arm_left', 'arm_right', 'head'] as const;

function build() {
    const sceneTree = createSceneTree();
    const roots: any[] = [];
    const driven: any[] = [];
    const bones: any[] = [];
    for (let i = 0; i < CHARS; i++) {
        const rootNode = createNode({ name: `char${i}` });
        addChild(sceneTree.root, rootNode);
        addTrait(rootNode, TransformTrait);
        const byName = new Map<string, Node>();
        for (const name of BONES) {
            const n = createNode({ name });
            addChild(PARENT_OF[name] === null ? rootNode : byName.get(PARENT_OF[name]!)!, n);
            byName.set(name, n);
            addTrait(n, TransformTrait);
            const t = n.traits[(TransformTrait as any)._slot];
            bones.push(t);
            if ((DRIVEN as readonly string[]).includes(name)) driven.push(t);
            // real avatars carry the mesh on a child node offset from the bone, and those
            // nodes are never rotated: 14-19 nodes per rig of which only 31-43% are
            // animation targets (`probe-identity-fraction.mjs`). Modelling only the bones
            // would make the rig 86% rotated and understate the translation-only path.
            const part = createNode({ name: `${name}_mesh` });
            addChild(n, part);
            addTrait(part, TransformTrait, { position: [0, 0.1, 0] } as any);
            (addTrait(part, MeshTrait) as any).meshId = { modelId: 'probe', meshName: name };
            bones.push(part.traits[(TransformTrait as any)._slot]);
        }
        setInterpolation(rootNode, true);
        roots.push(rootNode.traits[(TransformTrait as any)._slot]);
    }
    return { sceneTree, roots, driven, bones };
}

function makeFrame(w: ReturnType<typeof build>, late: boolean) {
    let tick = 0;
    return () => {
        tick++;
        // sim moved the rig root (a received pose being applied)
        for (let i = 0; i < w.roots.length; i++) setPosition(w.roots[i], [i * 0.01, tick * 0.001, 0]);
        snapshot(w.sceneTree);
        interpolate(w.sceneTree, 'nobody' as any, 0.5, 1 / 60);
        if (!late) concatenate(w.sceneTree);
        // character.ts onFrame: procedural limb swing + head look
        const s = Math.sin(tick * 0.1) * 0.3;
        for (let i = 0; i < w.driven.length; i++) setQuaternion(w.driven[i], [s, 0, 0, 1 - s * s * 0.5]);
        if (late) concatenate(w.sceneTree);
        // the renderer reads every bone's visual matrix
        for (let i = 0; i < w.bones.length; i++) getVisualWorldMatrix(w.bones[i]);
    };
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

const nodes = CHARS * (BONES.length * 2 + 1);
console.log(
    `\n${CHARS} characters: ${BONES.length} bones + ${BONES.length} mesh nodes + root (${nodes} nodes). ` +
        `${DRIVEN.length} rotated per frame (${((DRIVEN.length / (BONES.length * 2)) * 100).toFixed(0)}%).\n`,
);
console.log(`${'arm'.padEnd(7)} ${'ms/frame'.padStart(9)} ${'us/char'.padStart(9)}`);

const results: Record<string, number> = {};
for (const [label, late] of [
    ['early', false],
    ['late', true],
] as Array<[string, boolean]>) {
    const w = build();
    const ms = best(makeFrame(w, late), 40);
    results[label] = ms;
    console.log(`${label.padEnd(7)} ${ms.toFixed(3).padStart(9)} ${((ms * 1000) / CHARS).toFixed(2).padStart(9)}`);
}
console.log(`\nlate vs early: ${(results.early! / results.late!).toFixed(2)}x\n`);
