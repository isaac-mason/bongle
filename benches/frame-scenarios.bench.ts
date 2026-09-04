// Whole-frame scene workloads, shaped like real content rather than isolated primitives.
// run: labs frame-scenarios
//
// The other bench files measure one operation at a time (a write, a read, one resolve).
// That is the right instrument for a primitive and the wrong one for a decision about the
// compose path, because the answer depends entirely on the MIX: how many things move, how
// deep they are, how many are interpolating, and what fraction of locals carry a rotation.
//
// Populations here are drawn from the shipped avatars rather than invented. Measured with
// `probe-identity-fraction.mjs` across avatars/*/*.glb:
//
//   14-19 nodes per rig, of which 31-43% are animation targets (the rest are mesh nodes
//   hanging off a bone at a fixed offset), and 100% carry an identity rotation at rest.
//
// So a rig is modelled as a 7-bone chain (character.ts's canonical waist/body/head/arms/
// legs) with one mesh node per bone, and the six bones `applyLimb` + `updateHeadOrientation`
// rewrite each frame are the ones that get a rotation.

import { bench, group } from '@pmndrs/labs';
import { MeshTrait } from '../src/builtins/mesh';
import { ModelTrait } from '../src/builtins/model';
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

/* fixtures */

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
/** the bones character.ts rewrites every frame: applyLimb x5 plus updateHeadOrientation. */
const ROTATED = new Set(['waist', 'leg_left', 'leg_right', 'arm_left', 'arm_right', 'head']);

type Rig = { root: TransformTrait; rotated: TransformTrait[]; all: TransformTrait[] };

/** the makecat rig: 7 bones plus a mesh node per bone, 15 transforms. */
function makecatRig(sceneTree: SceneTree, i: number, interpolating: boolean): Rig {
    const rootNode = createNode({ name: `char${i}` });
    addChild(sceneTree.root, rootNode);
    const root = addTrait(rootNode, TransformTrait);
    addTrait(rootNode, ModelTrait);

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

        // mesh nodes sit at a fixed offset under their bone and are never rotated
        const meshNode = createNode({ name: `${name}_mesh` });
        addChild(boneNode, meshNode);
        all.push(addTrait(meshNode, TransformTrait, { position: [0, 0.1, 0] }));
        addTrait(meshNode, MeshTrait).meshId = { modelId: 'bench', meshName: name };
    }
    if (interpolating) setInterpolation(rootNode, true);
    return { root, rotated, all };
}

/** flat scenery: a mesh-bearing transform directly under the scene root. */
function prop(sceneTree: SceneTree, i: number): TransformTrait {
    const node = createNode({ name: `prop${i}` });
    addChild(sceneTree.root, node);
    const t = addTrait(node, TransformTrait, { position: [i * 0.5, 0, 0] });
    addTrait(node, MeshTrait).meshId = { modelId: 'bench', meshName: 'prop' };
    return t;
}

/** the six-bone pose write character.ts does each frame. */
function poseRigs(rigs: Rig[], tick: number): void {
    const s = Math.sin(tick * 0.1) * 0.3;
    const w = 1 - s * s * 0.5;
    for (let i = 0; i < rigs.length; i++) {
        const rotated = rigs[i]!.rotated;
        for (let b = 0; b < rotated.length; b++) setQuaternion(rotated[b]!, [s, 0, 0, w]);
    }
}

/* scenarios */

group('frame: static scene, nothing moves @frame @static', () => {
    for (const count of [500, 4000]) {
        bench(`read ${count} clean props (cache-hit floor)`, function* () {
            const sceneTree = createSceneTree();
            const props: TransformTrait[] = [];
            for (let i = 0; i < count; i++) props.push(prop(sceneTree, i));
            for (let i = 0; i < props.length; i++) getWorldMatrix(props[i]!);
            yield () => {
                for (let i = 0; i < props.length; i++) getWorldMatrix(props[i]!);
            };
        }).gc(true);
    }

    bench('read 1000 static rigs (15 transforms each, all clean)', function* () {
        const sceneTree = createSceneTree();
        const rigs: Rig[] = [];
        for (let i = 0; i < 1000; i++) rigs.push(makecatRig(sceneTree, i, false));
        for (const r of rigs) for (const t of r.all) getWorldMatrix(t);
        yield () => {
            for (let i = 0; i < rigs.length; i++) {
                const all = rigs[i]!.all;
                for (let b = 0; b < all.length; b++) getWorldMatrix(all[b]!);
            }
        };
    }).gc(true);
});

group('frame: shallow movers, no hierarchy @frame @shallow', () => {
    for (const count of [500, 4000]) {
        bench(`move + read ${count} flat props`, function* () {
            const sceneTree = createSceneTree();
            const props: TransformTrait[] = [];
            for (let i = 0; i < count; i++) props.push(prop(sceneTree, i));
            let tick = 0;
            yield () => {
                tick++;
                for (let i = 0; i < props.length; i++) setPosition(props[i]!, [i * 0.5, tick * 0.01, 0]);
                for (let i = 0; i < props.length; i++) getWorldMatrix(props[i]!);
            };
        }).gc(true);
    }
});

group('frame: makecat rigs, animated, no interpolation @frame @rig', () => {
    for (const count of [125, 1000]) {
        bench(`${count} rigs: move root, pose 6 bones, read 15 transforms`, function* () {
            const sceneTree = createSceneTree();
            const rigs: Rig[] = [];
            for (let i = 0; i < count; i++) rigs.push(makecatRig(sceneTree, i, false));
            let tick = 0;
            yield () => {
                tick++;
                for (let i = 0; i < rigs.length; i++) setPosition(rigs[i]!.root, [i * 0.5, tick * 0.01, 0]);
                poseRigs(rigs, tick);
                for (let i = 0; i < rigs.length; i++) {
                    const all = rigs[i]!.all;
                    for (let b = 0; b < all.length; b++) getWorldMatrix(all[b]!);
                }
            };
        }).gc(true);
    }
});

group('frame: interpolating rigs, full render pass @frame @interp', () => {
    for (const count of [125, 1000]) {
        bench(`${count} networked rigs: snapshot, interpolate, pose, concatenate, read`, function* () {
            const sceneTree = createSceneTree();
            const rigs: Rig[] = [];
            for (let i = 0; i < count; i++) rigs.push(makecatRig(sceneTree, i, true));
            let tick = 0;
            yield () => {
                tick++;
                // a received pose lands on each rig root
                for (let i = 0; i < rigs.length; i++) setPosition(rigs[i]!.root, [i * 0.5, tick * 0.01, 0]);
                snapshot(sceneTree);
                interpolate(sceneTree, 'nobody' as never, 0.5, 1 / 60);
                poseRigs(rigs, tick);
                concatenate(sceneTree);
                for (let i = 0; i < rigs.length; i++) {
                    const all = rigs[i]!.all;
                    for (let b = 0; b < all.length; b++) getVisualWorldMatrix(all[b]!);
                }
            };
        }).gc(true);
    }

    // the concatenation on its own, which is what the compose fast path changes
    for (const count of [1000]) {
        bench(`${count} rigs: concatenate only`, function* () {
            const sceneTree = createSceneTree();
            const rigs: Rig[] = [];
            for (let i = 0; i < count; i++) rigs.push(makecatRig(sceneTree, i, true));
            poseRigs(rigs, 1);
            snapshot(sceneTree);
            interpolate(sceneTree, 'nobody' as never, 0.5, 1 / 60);
            yield () => concatenate(sceneTree);
        }).gc(true);
    }

    // every bone at rest, so every local is translation-only: the fast path's best case
    bench('1000 rigs at rest (no bone rotated): concatenate only', function* () {
        const sceneTree = createSceneTree();
        const rigs: Rig[] = [];
        for (let i = 0; i < 1000; i++) rigs.push(makecatRig(sceneTree, i, true));
        snapshot(sceneTree);
        interpolate(sceneTree, 'nobody' as never, 0.5, 1 / 60);
        if (rigs.length === 0) throw new Error('unreachable');
        yield () => concatenate(sceneTree);
    }).gc(true);
});

// The animator's end-of-tick reconcile composes the WORLD chain for every dirty bone
// (`composeWorldMatrix`), and `concatenate` then composes the VISUAL chain for the same
// bones. Both derive the local basis from the same quaternion, so an animated interpolated
// bone expands its quaternion twice per frame. This is the only scenario here that puts
// both chains on one bone, and so the only one where a cached local basis can pay.
group('frame: both chains on one bone @frame @interp @twochain', () => {
    for (const count of [1000]) {
        bench(`${count} rigs: world chain (animator) + visual chain (concatenate)`, function* () {
            const sceneTree = createSceneTree();
            const rigs: Rig[] = [];
            for (let i = 0; i < count; i++) rigs.push(makecatRig(sceneTree, i, true));
            let tick = 0;
            yield () => {
                tick++;
                for (let i = 0; i < rigs.length; i++) setPosition(rigs[i]!.root, [i * 0.5, tick * 0.01, 0]);
                snapshot(sceneTree);
                interpolate(sceneTree, 'nobody' as never, 0.5, 1 / 60);
                poseRigs(rigs, tick);
                // the animator's reconcile: world matrices for every posed bone
                for (let i = 0; i < rigs.length; i++) {
                    const all = rigs[i]!.all;
                    for (let b = 0; b < all.length; b++) getWorldMatrix(all[b]!);
                }
                concatenate(sceneTree);
                for (let i = 0; i < rigs.length; i++) {
                    const all = rigs[i]!.all;
                    for (let b = 0; b < all.length; b++) getVisualWorldMatrix(all[b]!);
                }
            };
        }).gc(true);
    }
});

group('frame: mixed world @frame @mixed', () => {
    bench('2000 static props + 500 shallow movers + 250 interpolating rigs', function* () {
        const sceneTree = createSceneTree();
        const statics: TransformTrait[] = [];
        for (let i = 0; i < 2000; i++) statics.push(prop(sceneTree, i));
        const movers: TransformTrait[] = [];
        for (let i = 0; i < 500; i++) movers.push(prop(sceneTree, 10000 + i));
        const rigs: Rig[] = [];
        for (let i = 0; i < 250; i++) rigs.push(makecatRig(sceneTree, i, true));
        for (let i = 0; i < statics.length; i++) getWorldMatrix(statics[i]!);
        let tick = 0;
        yield () => {
            tick++;
            for (let i = 0; i < movers.length; i++) setPosition(movers[i]!, [i * 0.5, tick * 0.01, 0]);
            for (let i = 0; i < rigs.length; i++) setPosition(rigs[i]!.root, [i * 0.5, tick * 0.01, 0]);
            snapshot(sceneTree);
            interpolate(sceneTree, 'nobody' as never, 0.5, 1 / 60);
            poseRigs(rigs, tick);
            concatenate(sceneTree);
            for (let i = 0; i < statics.length; i++) getWorldMatrix(statics[i]!);
            for (let i = 0; i < movers.length; i++) getWorldMatrix(movers[i]!);
            for (let i = 0; i < rigs.length; i++) {
                const all = rigs[i]!.all;
                for (let b = 0; b < all.length; b++) getVisualWorldMatrix(all[b]!);
            }
        };
    }).gc(true);
});
