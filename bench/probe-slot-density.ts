// Does runDiffDetection's cost depend on WHERE a game's traits land in slot order?
//
//   ./node_modules/.bin/tsx bench/probe-slot-density.ts
//
// `_traits.length` is the highest slot ON THAT NODE plus one, and slots come from a
// global `slotCounter++` in trait registration order. Engine builtins register first
// (TransformTrait lands at slot 0), so a game's own traits get high slots. A node
// carrying transform + one user trait therefore walks up to that user trait's slot
// every tick to find two traits. This measures whether that actually costs anything.

import { registry } from '../src/core/registry';
import { pack } from '../src/core/scene/pack';
import { addChild, addTrait, createNode, createSceneTree } from '../src/core/scene/scene-tree';
import { dirty } from '../src/core/scene/sync/sync-rate';
import { sync, trait } from '../src/core/scene/traits';
import { runDiffDetection } from '../src/server/discovery';

const NODES = 2000;

/** a game trait with one synced number field, like a score or health. */
function makeGameTrait(id: string) {
    const T = trait(id, { value: 0 });
    sync(T, 'value', {
        schema: pack.object({ v: pack.float32() }),
        pack: (t: any) => ({ v: t.value }),
        unpack: (p: any, t: any) => {
            t.value = p.v;
        },
        dirty: dirty.diff(),
    });
    return T;
}

/** register `count` filler traits so the next real trait lands at a high slot. */
function pad(count: number, tag: string) {
    for (let i = 0; i < count; i++) trait(`pad-${tag}/${i}`, { n: 0 });
}

function measure(label: string, HotTrait: any) {
    const sceneTree = createSceneTree();
    for (let i = 0; i < NODES; i++) {
        const n = createNode({ name: `n${i}` });
        addTrait(n, HotTrait);
        addChild(sceneTree.root, n);
    }

    let slotsWalked = 0;
    let found = 0;
    for (const n of sceneTree.nodes) {
        slotsWalked += n._traits.length;
        for (let s = 0; s < n._traits.length; s++) if (n._traits[s] !== undefined) found++;
    }

    for (let i = 0; i < 200; i++) runDiffDetection(sceneTree);
    let best = Infinity;
    for (let r = 0; r < 200; r++) {
        const t0 = process.hrtime.bigint();
        runDiffDetection(sceneTree);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms < best) best = ms;
    }

    console.log(
        `${label.padEnd(30)} slot ${String(HotTrait._slot).padStart(4)}   ` +
            `${(slotsWalked / sceneTree.nodes.size).toFixed(1).padStart(6)} slots/node   ` +
            `${((found / slotsWalked) * 100).toFixed(1).padStart(5)}% hit   ` +
            `${best.toFixed(3).padStart(7)} ms/tick`,
    );
}

console.log(`registered trait types at start: ${registry.traits.byId.size}\n`);
console.log(`${'config'.padEnd(30)} ${'slot'.padStart(8)}   ${'density'.padStart(13)}   ${'hit'.padStart(5)}   diff cost`);

measure('game trait registered early', makeGameTrait('slotdens/early'));
pad(30, 'a');
measure('after 30 other traits', makeGameTrait('slotdens/mid'));
pad(70, 'b');
measure('after 100 other traits', makeGameTrait('slotdens/late'));
pad(150, 'c');
measure('after 250 other traits', makeGameTrait('slotdens/verylate'));
