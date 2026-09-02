// how sparse is the per-node `_traits` walk that runDiffDetection does every tick?
//   ./node_modules/.bin/tsx bench/probe-trait-density.ts
import { registry } from '../src/core/registry';
import { getSyncCodecs } from '../src/core/scene/packcat-bridge';
import { createWorld } from './discovery-world';

const world = createWorld({ clients: 8, props: 2000, spread: 160 });
const room = [...world.server.rooms.rooms.values()][0]!;

let nodes = 0;
let slotsWalked = 0;
let traitsFound = 0;
let syncableFound = 0;
let maxLen = 0;
const lenHist = new Map<number, number>();

for (const node of room.scene.nodes) {
    nodes++;
    const t = node._traits;
    slotsWalked += t.length;
    maxLen = Math.max(maxLen, t.length);
    lenHist.set(t.length, (lenHist.get(t.length) ?? 0) + 1);
    for (let s = 0; s < t.length; s++) {
        const inst = t[s];
        if (inst === undefined) continue;
        traitsFound++;
        const def = registry.slotToTrait[s];
        if (def && getSyncCodecs(def)) syncableFound++;
    }
}

console.log(`registered trait types: ${registry.traits.byId.size}   highest slot in use: ${maxLen - 1}`);
console.log(`nodes                 : ${nodes}`);
console.log(`slots walked per tick : ${slotsWalked}   (${(slotsWalked / nodes).toFixed(1)} per node)`);
console.log(`traits actually found : ${traitsFound}   (${((traitsFound / slotsWalked) * 100).toFixed(1)}% hit rate)`);
console.log(`of those, syncable    : ${syncableFound}   (${((syncableFound / slotsWalked) * 100).toFixed(1)}% of slots walked)`);
console.log(`\n_traits.length distribution:`);
for (const [len, count] of [...lenHist].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  length ${String(len).padStart(3)}: ${count} nodes`);
}
