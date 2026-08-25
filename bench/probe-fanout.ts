// probe: how many flushes does a freshly-joined client need before its AOI region
// stops expanding? the fan-out bench drains ONE flush and calls it steady state.
import * as Debug from '../src/core/debug';
import * as Resources from '../src/core/resources';
import { pack } from '../src/core/scene/pack';
import { addChild, addTrait, createNode } from '../src/core/scene/scene-tree';
import { dirty, rate } from '../src/core/scene/sync/sync-rate';
import { sync, trait } from '../src/core/scene/traits';
import { nodeZstd } from '../src/node/zstd';
import * as Discovery from '../src/server/discovery';
import * as Net from '../src/server/net';
import * as Rooms from '../src/server/rooms';
import { createTestServer } from '../tst/integration/server-integration-test';

const Mover = trait('probe-mover', { pos: [0, 0, 0] as number[] });
sync(Mover, 'pos', {
    schema: pack.position(),
    pack: (t) => t.pos,
    unpack: (v, t) => {
        t.pos = v as number[];
    },
    dirty: dirty.diff(),
    rate: rate.realtime(),
});

const N = 1000;
const M = 8;

const server = createTestServer({ mode: 'play' });
const discovery = Discovery.init(nodeZstd);
const resources = Resources.init({ loadBytes: async () => new Uint8Array() }, 'server');
const net = Net.init();

for (let i = 0; i < N; i++) {
    const n = createNode();
    addChild(server.room.scene.root, n);
    addTrait(n, Mover).pos = [0, 0, 0];
}

for (let c = 1; c <= M; c++) {
    Discovery.addClient(discovery, c);
    const player = Rooms.joinRoom(server.rooms, c, server.room.id, server.room.mode);
    Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
}

const metrics = Debug.createMetrics(false);
const anyDiscovery = discovery as unknown as {
    clients: Map<number, { voxelKnowledge: Map<number, { knownEmptyChunks: Set<string>; cursor: number }> }>;
};

const region = () => {
    const cs = anyDiscovery.clients.get(1)!;
    const vk = [...cs.voxelKnowledge.values()][0];
    return vk ? { empty: vk.knownEmptyChunks.size, cursor: vk.cursor } : { empty: -1, cursor: -1 };
};

let quiet = 0;
let flushes = 0;
while (quiet < 5 && flushes < 500) {
    const out = Discovery.flush(discovery, server.rooms, resources, metrics);
    flushes++;
    const chunkMsgs = out.filter(([, m]) => m.type.startsWith('voxel_')).length;
    if (chunkMsgs === 0) quiet++;
    else quiet = 0;
    if (flushes <= 3 || flushes % 5 === 0) {
        const r = region();
        console.log(`flush ${String(flushes).padStart(3)}  voxelMsgs=${chunkMsgs}  knownEmpty=${r.empty}  cursor=${r.cursor}`);
    }
}

const settled = flushes - 5;
const r = region();
console.log(`\nAOI region settles after ~${settled} flushes (final knownEmpty=${r.empty}, cursor=${r.cursor}).`);
console.log(
    `the bench drains 1 flush before benching, so it measures flush #2 of ~${settled} — mid-expansion, not steady state.`,
);
