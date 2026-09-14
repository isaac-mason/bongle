// Working set per character: how much heap does one 7-bone rig hold, and in how
// many separate objects? `probe-character-frame` goes superlinear past ~500
// characters, which points at cache rather than algorithm; this sizes the set.
//
//   ./node_modules/.bin/tsx --expose-gc bench/probe-character-heap.ts [chars]

import { MeshTrait } from '../src/builtins/mesh';
import { setInterpolation, TransformTrait } from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree, type Node } from '../src/core/scene/scene-tree';

const COUNT = Number(process.argv[2] ?? 1000);
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

type Layer = 'node' | 'transform' | 'mesh' | 'full';

function build(count: number, interp: boolean, layer: Layer = 'full') {
    const sceneTree = createSceneTree();
    for (let i = 0; i < count; i++) {
        const rootNode = createNode({ name: `char${i}` });
        addChild(sceneTree.root, rootNode);
        if (layer !== 'node') addTrait(rootNode, TransformTrait);
        const byName = new Map<string, Node>();
        for (const name of BONES) {
            const n = createNode({ name });
            addChild(PARENT_OF[name] === null ? rootNode : byName.get(PARENT_OF[name]!)!, n);
            byName.set(name, n);
            if (layer !== 'node') addTrait(n, TransformTrait);
            if (layer === 'mesh' || layer === 'full') {
                (addTrait(n, MeshTrait) as any).meshId = { modelId: 'probe', meshName: name };
            }
        }
        if (interp && layer === 'full') setInterpolation(rootNode, true);
    }
    return sceneTree;
}

function measure(count: number, interp: boolean, layer: Layer = 'full'): number {
    globalThis.gc!();
    globalThis.gc!();
    const before = process.memoryUsage().heapUsed;
    const tree = build(count, interp, layer);
    globalThis.gc!();
    globalThis.gc!();
    const after = process.memoryUsage().heapUsed;
    if ((tree as any).__never) console.log('');
    return after - before;
}

// discard the first build: it settles lazily-created shapes and inflates the delta
measure(COUNT, true);

console.log(`\nworking set, ${BONES.length} bones + 1 root per character (${BONES.length + 1} nodes)\n`);
const nodes = COUNT * (BONES.length + 1);
let prev = 0;
for (const [label, layer] of [
    ['bare Node', 'node'],
    ['+ TransformTrait', 'transform'],
    ['+ MeshTrait', 'mesh'],
    ['+ interp', 'full'],
] as Array<[string, Layer]>) {
    const bytes = measure(COUNT, true, layer);
    console.log(
        `${label.padEnd(20)} ${(bytes / 1e6).toFixed(2).padStart(7)} MB  ` +
            `${(bytes / nodes).toFixed(0).padStart(5)} B/node  (+${((bytes - prev) / nodes).toFixed(0).padStart(4)} B/node)`,
    );
    prev = bytes;
}
console.log('\nApple Silicon P-core L2 is 4 MB; the shared L2/SLC is larger but shared.\n');
