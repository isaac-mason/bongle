// captures a real CPU profile of Discovery.flush's voxel phase under "heaps of
// movers" — many bots moving concurrently — so "what costs the most" is measured
// self-time by function, not inferred from reading the code.
//
//   ./node_modules/.bin/tsx bench/profile-voxels-movers.ts [clients] [motion]
//   node bench/analyze-profile.mjs profiles/voxels-movers-<clients>-<motion>.cpuprofile

import { Session } from 'node:inspector';
import fs from 'node:fs';
import path from 'node:path';
import { createWorld, moveBots, type Locomotion } from './discovery-world';

const CLIENTS = Number(process.argv[2] ?? 64);
const MOTION = (process.argv[3] ?? 'walk') as Locomotion;
const PROPS = 2000;
const SPREAD = 256; // wide enough that AOI genuinely culls, matches earlier egress runs
const TICKS = 1200; // 20s of sim time at 60Hz

console.log(`building world: ${PROPS} props, ${CLIENTS} clients, spread=${SPREAD}, generated terrain...`);
const world = createWorld({ props: PROPS, clients: CLIENTS, terrain: 'generated', spread: SPREAD });

console.log('settling (join burst)...');
const settleTicks = world.settle();
console.log(`settled after ${settleTicks} ticks`);

console.log(`warming up (200 ticks, motion=${MOTION})...`);
for (let i = 0; i < 200; i++) {
    moveBots(world, i, MOTION);
    world.tick();
}

const session = new Session();
session.connect();
const post = (method: string, params?: object) =>
    new Promise<any>((res, rej) => {
        const cb = (err: unknown, r: unknown) => (err ? rej(err) : res(r));
        if (params) (session.post as any)(method, params, cb);
        else (session.post as any)(method, cb);
    });

await post('Profiler.enable');
await post('Profiler.setSamplingInterval', { interval: 50 }); // 50us for fine attribution
await post('Profiler.start');

console.log(`profiling ${TICKS} ticks (heaps of movers: ${CLIENTS} clients, motion=${MOTION})...`);
for (let i = 0; i < TICKS; i++) {
    moveBots(world, 200 + i, MOTION);
    world.tick();
}

const { profile } = await post('Profiler.stop');
session.disconnect();

fs.mkdirSync('profiles', { recursive: true });
const file = path.join('profiles', `voxels-movers-${CLIENTS}-${MOTION}.cpuprofile`);
fs.writeFileSync(file, JSON.stringify(profile));
console.log(`wrote ${file} (${TICKS} ticks · ${CLIENTS} clients · motion=${MOTION})`);
