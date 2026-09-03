// Captures a CPU profile of the rig world-transform phase, to find where the gap between
// raw compose cost and engine cost actually goes.
//
//   ./node_modules/.bin/tsx bench/profile-rig-world.ts [rigs]
//   node bench/analyze-profile.mjs profiles/rig-world-<rigs>.cpuprofile
//
// `probe-transform-layout.ts` puts the affine compose at ~47 ns/node, flat in N.
// `probe-rig-frame.ts` puts the engine's world phase at ~271 ns/node at 4000 rigs. Five
// hypotheses for the difference (float packing, typed arrays, dropping the constant affine
// stores, restoring a stored `_parent`, a top-down sweep) all measured null or marginal, so
// this stops guessing and samples it.
//
// Same fixture and same per-frame shape as `probe-rig-frame`: move each rig root, then read
// every bone's world matrix.

import fs from 'node:fs';
import { Session } from 'node:inspector';
import path from 'node:path';
import { MeshTrait } from '../src/builtins/mesh';
import { ModelTrait } from '../src/builtins/model';
import { getWorldMatrix, setPosition, TransformTrait } from '../src/builtins/transform';
import { Optional, Up } from '../src/core/scene/conditions';
import { addChild, addTrait, createNode, createSceneTree, type Node, query } from '../src/core/scene/scene-tree';

const RIGS = Number(process.argv[2] ?? 4000);
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

const sceneTree = createSceneTree();
query(sceneTree, [MeshTrait, TransformTrait, Optional(Up(ModelTrait))]);

const roots: any[] = [];
const bones: any[] = [];
for (let i = 0; i < RIGS; i++) {
    const rootNode = createNode({ name: `rig${i}` });
    addChild(sceneTree.root, rootNode);
    addTrait(rootNode, TransformTrait);
    addTrait(rootNode, ModelTrait);
    roots.push(rootNode._traits[TransformTrait._slot]);

    const byName = new Map<string, Node>();
    for (const name of BONES) {
        const n = createNode({ name });
        const parentName = PARENT_OF[name];
        addChild(parentName === null ? rootNode : byName.get(parentName)!, n);
        byName.set(name, n);
        addTrait(n, TransformTrait);
        const mesh = addTrait(n, MeshTrait) as any;
        mesh.meshId = { modelId: 'profile', meshName: name };
        bones.push(n._traits[TransformTrait._slot]);
    }
}

let tick = 0;
function frame(): void {
    tick++;
    for (let i = 0; i < roots.length; i++) setPosition(roots[i], [i * 0.01, tick * 0.001, 0]);
    for (let i = 0; i < bones.length; i++) getWorldMatrix(bones[i]);
}

for (let i = 0; i < 200; i++) frame(); // warmup

const session = new Session();
session.connect();
const post = (method: string, params?: object) =>
    new Promise<any>((res, rej) => {
        const cb = (err: unknown, r: unknown) => (err ? rej(err) : res(r));
        if (params) (session.post as any)(method, params, cb);
        else (session.post as any)(method, cb);
    });

await post('Profiler.enable');
await post('Profiler.setSamplingInterval', { interval: 100 });
await post('Profiler.start');
const ITER = 400;
for (let i = 0; i < ITER; i++) frame();
const { profile } = await post('Profiler.stop');
session.disconnect();

fs.mkdirSync('profiles', { recursive: true });
const file = path.join('profiles', `rig-world-${RIGS}.cpuprofile`);
fs.writeFileSync(file, JSON.stringify(profile));
console.log(`wrote ${file} (${ITER} frames · ${RIGS} rigs · ${roots.length + bones.length} nodes)`);
