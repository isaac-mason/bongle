// What does a client frame cost, on CPU, for N characters?
//
//   ./node_modules/.bin/tsx bench/probe-character-frame.ts [maxChars]
//
// Models the per-character work in `client.ts`'s per-room visual pass, using the real
// engine code for each stage. Reported per stage, each measured as its own best-of loop
// over a settled tree, plus a whole-frame number (the stages are NOT additive: earlier
// stages leave the tree dirty in ways that change later ones, so trust `frame`).
//
//   move       sim writes the rig root (replication applying a received pose)
//   locomotion character.ts's onFrame: 4 bone quaternions per rig, ungated by visibility
//   interp     snapshot + Interpolation.interpolate (sweeps each rig's subtree)
//   lighting   ModelLighting.update's per-model matrix read + sample point math
//   collect    mesh-visuals phase 1 (query walk) + phase 3 (16-float matrix write/instance)
//
// Excludes: GPU upload, the script-runtime dispatch around onFrame, physics/KCC,
// networking, and voxel sampling itself (no Voxels here; `lighting` measures the
// per-model matrix read + offset transform, which is the part that scales with N).
//
// Rig shape is the engine's canonical 7 bones (character.ts): waist, body, head,
// arm_left, arm_right, leg_left, leg_right.

import { MeshTrait } from '../src/builtins/mesh';
import { ModelTrait } from '../src/builtins/model';
import {
    getVisualWorldMatrix, setInterpolation, setPosition, setQuaternion, TransformTrait,
} from '../src/builtins/transform';
import { Optional, Up } from '../src/core/scene/conditions';
import { addChild, addTrait, createNode, createSceneTree, type Node, query } from '../src/core/scene/scene-tree';
import { interpolate, snapshot } from '../src/render/transform/interpolation';

const MAX = Number(process.argv[2] ?? 1000);
const BONES = ['waist', 'body', 'head', 'arm_left', 'arm_right', 'leg_left', 'leg_right'] as const;
const PARENT_OF: Record<string, string | null> = {
    waist: null, leg_left: null, leg_right: null,
    body: 'waist', head: 'waist', arm_left: 'waist', arm_right: 'waist',
};
const INSTANCE_F32 = 32; // matches MODEL_INSTANCE_STRIDE_F32 in mesh-resources

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

console.log(`\ncharacters, ${BONES.length} bones + 1 root each. best-of; budget 16.67 ms/frame\n`);
console.log(
    `${'chars'.padStart(6)} ${'move'.padStart(8)} ${'locomo'.padStart(8)} ${'interp'.padStart(8)} ${'lightng'.padStart(8)} ${'collect'.padStart(8)} ${'frame'.padStart(9)}  chars@16.67ms`,
);

for (const count of [125, 250, 500, MAX].filter((n, i, a) => n <= MAX && a.indexOf(n) === i)) {
    const sceneTree = createSceneTree();
    const q = query(sceneTree, [MeshTrait, TransformTrait, Optional(Up(ModelTrait))]);
    const roots: any[] = [];
    const models: any[] = [];
    const swing: any[] = [];
    const allBones: any[] = [];

    for (let i = 0; i < count; i++) {
        const rootNode = createNode({ name: `char${i}` });
        addChild(sceneTree.root, rootNode);
        addTrait(rootNode, TransformTrait);
        const model = addTrait(rootNode, ModelTrait);
        const byName = new Map<string, Node>();
        for (const name of BONES) {
            const n = createNode({ name });
            addChild(PARENT_OF[name] === null ? rootNode : byName.get(PARENT_OF[name]!)!, n);
            byName.set(name, n);
            addTrait(n, TransformTrait);
            const mesh = addTrait(n, MeshTrait) as any;
            mesh.meshId = { modelId: 'probe', meshName: name };
            const t = n.traits[(TransformTrait as any)._slot];
            allBones.push(t);
            // locomotion drives the four swinging limbs
            if (name === 'arm_left' || name === 'arm_right' || name === 'leg_left' || name === 'leg_right') swing.push(t);
        }
        setInterpolation(rootNode, true);
        const rt = rootNode.traits[(TransformTrait as any)._slot];
        roots.push(rt);
        models.push([model, rt]);
    }

    const instArr = new Float32Array(count * BONES.length * INSTANCE_F32);
    const buckets = new Map<number, number[]>();
    let tick = 0;

    const move = () => {
        tick++;
        for (let i = 0; i < roots.length; i++) setPosition(roots[i], [i * 0.01, tick * 0.001, 0]);
    };
    const locomotion = () => {
        const s = Math.sin(tick * 0.1) * 0.3;
        for (let i = 0; i < swing.length; i++) setQuaternion(swing[i], [s, 0, 0, 1 - s * s * 0.5]);
    };
    const interp = () => {
        snapshot(sceneTree);
        interpolate(sceneTree, 'nobody' as any, 0.5, 1 / 60);
    };
    // ModelLighting.update's per-model work, minus sampleVoxelLight (needs a Voxels)
    let lightAcc = 0;
    const lighting = () => {
        for (let i = 0; i < models.length; i++) {
            const [model, transform] = models[i]!;
            const m = getVisualWorldMatrix(transform);
            const o = model.lightOffset;
            lightAcc += m[0] * o[0] + m[4] * o[1] + m[8] * o[2] + m[12];
        }
    };
    // mesh-visuals phase 1 (query walk) + phase 3 (per-instance matrix write + bucket)
    const collect = () => {
        for (const arr of buckets.values()) arr.length = 0;
        let slot = 0;
        for (const [meshTrait, transform] of q.matches) {
            const m = getVisualWorldMatrix(transform as any);
            const base = slot * INSTANCE_F32;
            instArr[base + 0] = m[0]!; instArr[base + 1] = m[1]!; instArr[base + 2] = m[2]!; instArr[base + 3] = m[3]!;
            instArr[base + 4] = m[4]!; instArr[base + 5] = m[5]!; instArr[base + 6] = m[6]!; instArr[base + 7] = m[7]!;
            instArr[base + 8] = m[8]!; instArr[base + 9] = m[9]!; instArr[base + 10] = m[10]!; instArr[base + 11] = m[11]!;
            instArr[base + 12] = m[12]!; instArr[base + 13] = m[13]!; instArr[base + 14] = m[14]!; instArr[base + 15] = m[15]!;
            const key = (meshTrait as any).meshId === null ? -1 : 0;
            let b = buckets.get(key);
            if (b === undefined) { b = []; buckets.set(key, b); }
            b.push(slot);
            slot++;
        }
    };
    const frame = () => { move(); locomotion(); interp(); lighting(); collect(); };

    const f = best(frame, 40);
    const row = [
        best(() => { move(); }, 40),
        best(() => { locomotion(); }, 40),
        best(() => { move(); interp(); }, 40),
        best(() => { lighting(); }, 40),
        best(() => { collect(); }, 40),
    ];
    console.log(
        `${String(count).padStart(6)} ${row.map((v) => `${v.toFixed(3)}ms`.padStart(8)).join(' ')} ${`${f.toFixed(3)}ms`.padStart(9)}  ${Math.floor((16.67 / f) * count)}`,
    );
    if (lightAcc === 12345.6789) console.log('');
}
console.log();
