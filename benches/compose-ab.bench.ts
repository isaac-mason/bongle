// A/B instrument for the transform compose path. run: labs compose-ab
//
// `frame-scenarios` is the broad picture; this is the narrow one. It carries only the
// scenarios that can distinguish compose-path changes, so a saved run finishes in a
// quarter of the time and survives being backgrounded. Same rig shape and populations as
// `frame-scenarios` (7 bones + a mesh node each, 6 bones rotated per frame, drawn from
// `probe-identity-fraction.mjs` over the shipped avatars).
//
// The three rows answer different questions:
//
//   concatenate only  the visual chain in isolation, one compose per bone
//   two chains        the world chain (as the animator's reconcile drives it) AND the
//                     visual chain on the same bone, so the local basis is derived twice
//                     per bone per frame. The only row where caching that basis can pay.
//   full frame        everything, at the scale we actually care about
//
// Reads return a sink so they cannot be eliminated; a discarded `getWorldMatrix` is
// exactly the shape V8 folds away, and labs detects DCE by comparing against an empty call.

import { bench, group } from '@pmndrs/labs';
import { MeshTrait } from '../src/builtins/mesh';
import {
    getVisualWorldMatrix,
    getWorldMatrix,
    setInterpolation,
    setPosition,
    setQuaternion,
    TransformTrait,
} from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree, type Node, type SceneTree } from '../src/core/scene/scene-tree';
import { concatenate, interpolate, snapshot } from '../src/render/transform/interpolation';

const COUNT = 1000;
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
const ROTATED = new Set(['waist', 'leg_left', 'leg_right', 'arm_left', 'arm_right', 'head']);

let sink = 0;

type Rig = { root: TransformTrait; rotated: TransformTrait[]; all: TransformTrait[] };

function makecatRig(sceneTree: SceneTree, i: number): Rig {
    const rootNode = createNode({ name: `char${i}` });
    addChild(sceneTree.root, rootNode);
    const root = addTrait(rootNode, TransformTrait);
    const byName = new Map<string, Node>();
    const rotated: TransformTrait[] = [];
    const all: TransformTrait[] = [];
    for (const name of BONES) {
        const boneNode = createNode({ name });
        addChild(PARENT_OF[name] === null ? rootNode : byName.get(PARENT_OF[name]!)!, boneNode);
        byName.set(name, boneNode);
        const bone = addTrait(boneNode, TransformTrait, { position: [0, 0.3, 0] });
        all.push(bone);
        if (ROTATED.has(name)) rotated.push(bone);

        const meshNode = createNode({ name: `${name}_mesh` });
        addChild(boneNode, meshNode);
        all.push(addTrait(meshNode, TransformTrait, { position: [0, 0.1, 0] }));
        addTrait(meshNode, MeshTrait).meshId = { modelId: 'bench', meshName: name };
    }
    setInterpolation(rootNode, true);
    return { root, rotated, all };
}

function build(): { sceneTree: SceneTree; rigs: Rig[] } {
    const sceneTree = createSceneTree();
    const rigs: Rig[] = [];
    for (let i = 0; i < COUNT; i++) rigs.push(makecatRig(sceneTree, i));
    return { sceneTree, rigs };
}

function poseRigs(rigs: Rig[], tick: number): void {
    const s = Math.sin(tick * 0.1) * 0.3;
    const w = 1 - s * s * 0.5;
    for (let i = 0; i < rigs.length; i++) {
        const rotated = rigs[i]!.rotated;
        for (let b = 0; b < rotated.length; b++) setQuaternion(rotated[b]!, [s, 0, 0, w]);
    }
}

group('compose: A/B rows @compose @ab', () => {
    bench(`${COUNT} rigs: concatenate only`, function* () {
        const { sceneTree, rigs } = build();
        poseRigs(rigs, 1);
        snapshot(sceneTree);
        interpolate(sceneTree, 'nobody' as never, 0.5, 1 / 60);
        yield () => {
            concatenate(sceneTree);
            return sceneTree;
        };
    }).gc(true);

    bench(`${COUNT} rigs: two chains (world + visual) on one bone`, function* () {
        const { sceneTree, rigs } = build();
        let tick = 0;
        yield () => {
            tick++;
            for (let i = 0; i < rigs.length; i++) setPosition(rigs[i]!.root, [i * 0.5, tick * 0.01, 0]);
            snapshot(sceneTree);
            interpolate(sceneTree, 'nobody' as never, 0.5, 1 / 60);
            poseRigs(rigs, tick);
            for (let i = 0; i < rigs.length; i++) {
                const all = rigs[i]!.all;
                for (let b = 0; b < all.length; b++) sink += getWorldMatrix(all[b]!)[12]!;
            }
            concatenate(sceneTree);
            for (let i = 0; i < rigs.length; i++) {
                const all = rigs[i]!.all;
                for (let b = 0; b < all.length; b++) sink += getVisualWorldMatrix(all[b]!)[12]!;
            }
            return sink;
        };
    }).gc(true);

    bench(`${COUNT} rigs: full interpolated frame`, function* () {
        const { sceneTree, rigs } = build();
        let tick = 0;
        yield () => {
            tick++;
            for (let i = 0; i < rigs.length; i++) setPosition(rigs[i]!.root, [i * 0.5, tick * 0.01, 0]);
            snapshot(sceneTree);
            interpolate(sceneTree, 'nobody' as never, 0.5, 1 / 60);
            poseRigs(rigs, tick);
            concatenate(sceneTree);
            for (let i = 0; i < rigs.length; i++) {
                const all = rigs[i]!.all;
                for (let b = 0; b < all.length; b++) sink += getVisualWorldMatrix(all[b]!)[12]!;
            }
            return sink;
        };
    }).gc(true);
});
