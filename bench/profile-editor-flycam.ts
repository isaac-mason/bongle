// targeted repro for the live editor symptom: ONE client, at the (now unified,
// play-and-edit) MAX_STREAM_RADIUS ceiling of 24 chunks, moving at the
// fly-controller's DEFAULT speed (10 blocks/s — slower than anything else
// benched this session). isolates whether the reported 24ms spikes are a
// many-clients scaling problem or purely a single-client cost driven by a
// large streamed sphere.
//
//   ./node_modules/.bin/tsx bench/profile-editor-flycam.ts

import fs from 'node:fs';
import { Session } from 'node:inspector';
import path from 'node:path';
import { PlayerTrait } from '../src/builtins/player';
import { getTrait } from '../src/core/scene/scene-tree';
import { createWorld, moveBots } from './discovery-world';

const SPREAD = 512; // must comfortably exceed the edit-mode sphere radius (24*16=384 blocks)

console.log('building world: 1 client, edit-mode-sized world, generated terrain...');
const world = createWorld({ props: 500, clients: 1, terrain: 'generated', spread: SPREAD });

// createWorld always sets up play-mode rooms; force edit mode to match a real
// editor session. room.mode itself no longer gates the stream-radius ceiling
// (MAX_STREAM_RADIUS is now a single unified constant, not room.mode-branched),
// so this line is vestigial for THIS repro's purposes — the explicit viewRadius
// override just below is what actually drives the radius — but it's kept since
// other engine subsystems this script doesn't exercise may still read room.mode.
(world.server.room as { mode: string }).mode = 'edit';

// discovery-world.ts's bots always request viewRadius: 8 — the play floor. an
// earlier run of this script left that unchanged, so despite room.mode='edit'
// the effective radius was still clamped to MIN_STREAM_RADIUS(8), NOT the
// MAX_STREAM_RADIUS(24) ceiling — a real bug that made that run measure the
// wrong sphere size entirely. force the bot's requested radius up to the
// ceiling so this actually reproduces what a real editor session runs at.
{
    const bot = world.bots[0];
    const node = world.server.room.playerNodes.get(bot.playerId);
    const playerTrait = node && getTrait(node, PlayerTrait);
    if (!playerTrait) throw new Error('bot has no PlayerTrait — cannot set viewRadius');
    playerTrait.viewRadius = 24;
}

console.log('settling (join burst, now at edit-mode radius 24)...');
const settleTicks = world.settle(3000);
console.log(`settled after ${settleTicks} ticks`);

// discovery-world.ts's Locomotion enum doesn't have a slot for the fly
// controller's real default (10 blocks/s) — closest available is 'walk' (5
// blocks/s), which is SLOWER than the real default. if radius-24 costs a lot
// even at this conservative speed, that's a strong, non-speed-dependent signal.
console.log('warming up (100 ticks at walk speed — slower than the real fly-controller default)...');
for (let i = 0; i < 100; i++) {
    moveBots(world, i, 'walk');
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
await post('Profiler.setSamplingInterval', { interval: 20 }); // fine-grained; single client, low sample volume
await post('Profiler.start');

const TICKS = 2000;
console.log(`profiling ${TICKS} ticks (1 client, edit radius 24, walk speed = 5 blocks/s)...`);
for (let i = 0; i < TICKS; i++) {
    moveBots(world, 100 + i, 'walk');
    world.tick();
}

const { profile } = await post('Profiler.stop');
session.disconnect();

fs.mkdirSync('profiles', { recursive: true });
const file = path.join('profiles', 'editor-flycam.cpuprofile');
fs.writeFileSync(file, JSON.stringify(profile));
console.log(`wrote ${file}`);
