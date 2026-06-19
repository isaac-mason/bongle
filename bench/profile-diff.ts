// Captures a CPU profile of a tight runDiffDetection loop, isolated from vitest
// overhead, and writes profiles/diff-<scenario>.cpuprofile.
//
//   nvm use 24 && ./node_modules/.bin/tsx bench/profile-diff.ts [static|moving|mixed]
//   node bench/analyze-profile.mjs profiles/diff-static.cpuprofile
//
// uses the inspector Session directly (no --cpu-prof flag / tsx-loader friction),
// so the captured window is exactly the measured loop.

import { Session } from 'node:inspector';
import fs from 'node:fs';
import path from 'node:path';
import * as p from 'packcat';
import { addChild, addTrait, createNode, createSceneGraph } from '../src/core/scene/nodes';
import { syncRate } from '../src/core/scene/sync/sync-rate';
import { sync, trait } from '../src/core/scene/traits';
import { runDiffDetection } from '../src/server/discovery';

const Mover = trait('profile-mover', { pos: [0, 0, 0] as number[], rot: [0, 0, 0, 1] as number[] });
sync(Mover, 'pos', { schema: p.list(p.float32(), 3), pack: (t) => t.pos, unpack: (v, t) => { t.pos = v as number[]; }, rate: syncRate.distance(0.05) });
sync(Mover, 'rot', { schema: p.list(p.float32(), 4), pack: (t) => t.rot, unpack: (v, t) => { t.rot = v as number[]; }, rate: syncRate.angle(0.02) });

const scenario = process.argv[2] ?? 'static';
const N = 1000;
const ITER = 20000;

const sg = createSceneGraph();
const movers: Array<{ pos: number[]; rot: number[] }> = [];
for (let i = 0; i < N; i++) {
    const n = createNode();
    addChild(sg.root, n);
    const m = addTrait(n, Mover);
    m.pos = [0, 0, 0];
    m.rot = [0, 0, 0, 1];
    movers.push(m);
}
runDiffDetection(sg); // seed
for (let i = 0; i < 2000; i++) runDiffDetection(sg); // warmup

const session = new Session();
session.connect();
const post = (method: string, params?: object) =>
    new Promise<any>((res, rej) => {
        const cb = (err: unknown, r: unknown) => (err ? rej(err) : res(r));
        if (params) (session.post as any)(method, params, cb);
        else (session.post as any)(method, cb);
    });

await post('Profiler.enable');
await post('Profiler.setSamplingInterval', { interval: 100 }); // 100µs for fine attribution
await post('Profiler.start');

let tick = 0;
for (let i = 0; i < ITER; i++) {
    if (scenario === 'moving') {
        tick++;
        const d = tick * 0.1;
        for (const m of movers) m.pos[0] = d;
    } else if (scenario === 'mixed') {
        tick++;
        const d = tick * 0.1;
        for (let j = 0; j < movers.length; j += 5) movers[j].pos[0] = d;
    }
    runDiffDetection(sg);
}

const { profile } = await post('Profiler.stop');
session.disconnect();
fs.mkdirSync('profiles', { recursive: true });
const file = path.join('profiles', `diff-${scenario}.cpuprofile`);
fs.writeFileSync(file, JSON.stringify(profile));
console.log(`wrote ${file} (${ITER} iters · ${scenario} · ${N} nodes)`);
