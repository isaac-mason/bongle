// CPU profile of the bare attach/detach path, with no declared resolutions in play.
//
//   ./node_modules/.bin/tsx bench/profile-attach.ts
//   node bench/analyze-profile.mjs profiles/attach.cpuprofile

import fs from 'node:fs';
import { Session } from 'node:inspector';
import path from 'node:path';
import { registry } from '../src/core/registry';
import { addChild, addTrait, createNode, createSceneTree, type Node, removeChild } from '../src/core/scene/scene-tree';
import { trait } from '../src/core/scene/traits';

const Mesh = trait('profattach/mesh', { id: 0 });
const NODES = 1200;

function build(): Node {
    const root = createNode({ name: 'sub' });
    addTrait(root, Mesh);
    let made = 1;
    let frontier: Node[] = [root];
    while (made < NODES) {
        const next: Node[] = [];
        for (const parent of frontier) {
            for (let b = 0; b < 4 && made < NODES; b++) {
                const n = createNode({ name: `n${made++}` });
                addTrait(n, Mesh);
                addChild(parent, n);
                next.push(n);
            }
        }
        if (next.length === 0) break;
        frontier = next;
    }
    return root;
}

const sceneTree = createSceneTree();
const sub = build();

const cycle = () => {
    addChild(sceneTree.root, sub);
    removeChild(sceneTree.root, sub);
};
for (let i = 0; i < 200; i++) cycle();

const session = new Session();
session.connect();
session.post('Profiler.enable', () => {
    session.post('Profiler.start', () => {
        for (let i = 0; i < 1500; i++) cycle();
        session.post('Profiler.stop', (err, { profile }) => {
            if (err) throw err;
            const dir = path.join(process.cwd(), 'profiles');
            fs.mkdirSync(dir, { recursive: true });
            const out = path.join(dir, 'attach.cpuprofile');
            fs.writeFileSync(out, JSON.stringify(profile));
            console.log(`wrote ${out}`);
        });
    });
});
