// Samples a full interpolated render frame for N remote NPC rigs, to size
// `markInterpolatedDescendantsDirty`'s share of it.
//
//   ./node_modules/.bin/tsx bench/profile-interp-frame.ts [rigs]
//   node bench/analyze-profile.mjs profiles/interp-frame-<rigs>.cpuprofile

import fs from 'node:fs';
import { Session } from 'node:inspector';
import path from 'node:path';
import { MeshTrait } from '../src/builtins/mesh';
import { getVisualWorldMatrix, setInterpolation, setPosition, TransformTrait } from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree, type Node } from '../src/core/scene/scene-tree';
import { concatenate, interpolate, snapshot } from '../src/render/transform/interpolation';

const RIGS = Number(process.argv[2] ?? 128);
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
const roots: any[] = [];
const bones: any[] = [];
for (let i = 0; i < RIGS; i++) {
    const rootNode = createNode({ name: `rig${i}` });
    addChild(sceneTree.root, rootNode);
    addTrait(rootNode, TransformTrait);
    const byName = new Map<string, Node>();
    for (const name of BONES) {
        const n = createNode({ name });
        addChild(PARENT_OF[name] === null ? rootNode : byName.get(PARENT_OF[name]!)!, n);
        byName.set(name, n);
        addTrait(n, TransformTrait);
        const mesh = addTrait(n, MeshTrait) as any;
        mesh.meshId = { modelId: 'profile', meshName: name };
        bones.push(n.traits[(TransformTrait as any)._slot]);
    }
    setInterpolation(rootNode, true);
    roots.push(rootNode.traits[(TransformTrait as any)._slot]);
}

let tick = 0;
function frame(): void {
    tick++;
    for (let i = 0; i < roots.length; i++) setPosition(roots[i], [i * 0.01, tick * 0.001, 0]);
    snapshot(sceneTree);
    interpolate(sceneTree, 'nobody' as any, 0.5, 1 / 60);
    concatenate(sceneTree);
    for (let i = 0; i < bones.length; i++) getVisualWorldMatrix(bones[i]);
}

for (let i = 0; i < 200; i++) frame();

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
const ITER = 2000;
for (let i = 0; i < ITER; i++) frame();
const { profile } = await post('Profiler.stop');
session.disconnect();

fs.mkdirSync('profiles', { recursive: true });
const file = path.join('profiles', `interp-frame-${RIGS}.cpuprofile`);
fs.writeFileSync(file, JSON.stringify(profile));
console.log(`wrote ${file} (${ITER} frames · ${RIGS} rigs · ${roots.length + bones.length} nodes)`);
