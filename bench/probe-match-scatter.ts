// Why does iterating 7000 query matches cost 8 ms in a real game and 0.3 ms in a probe?
//
//   ./node_modules/.bin/tsx --expose-gc bench/probe-match-scatter.ts [chars]
//
// `refreshStates` is 16.6% of the client thread in a 1000-character trace, doing nothing
// but stamping two fields per match. A synthetic probe running the same loop over the same
// count is ~27x faster. The loop is not the difference; the heap is.
//
// A bench builds every rig back-to-back, so the trait instances land contiguously and the
// walk is a linear scan. A real world creates and destroys nodes over its lifetime, so the
// same 7000 traits are scattered across a much larger heap and every match is a pointer
// chase into a cold line.
//
// Three arms, identical loop and identical object count:
//   packed    rigs built back-to-back (what every probe in this directory does)
//   scattered rigs interleaved with allocation that is then dropped, so survivors spread
//   churned   as scattered, plus half the rigs deleted and rebuilt, so match order no
//             longer follows allocation order
//
// The loop body is `refreshStates`'s fast path verbatim.

import { MeshTrait } from '../src/builtins/mesh';
import { ModelTrait } from '../src/builtins/model';
import { TransformTrait } from '../src/builtins/transform';
import { Optional, Up } from '../src/core/scene/conditions';
import { addChild, addTrait, createNode, createSceneTree, type Node, query, removeChild } from '../src/core/scene/scene-tree';

const CHARS = Number(process.argv[2] ?? 1000);
const BONES = ['waist', 'body', 'head', 'arm_left', 'arm_right', 'leg_left', 'leg_right'] as const;
const PARENT_OF: Record<string, string | null> = {
    waist: null, leg_left: null, leg_right: null,
    body: 'waist', head: 'waist', arm_left: 'waist', arm_right: 'waist',
};

type Mode = 'packed' | 'scattered' | 'churned';

// dropped between rigs so the survivors do not land contiguously
function litter(n: number): void {
    let sink: unknown = null;
    for (let i = 0; i < n; i++) sink = { a: i, b: [i, i + 1, i + 2], c: `litter${i}` };
    if (sink === undefined) console.log('');
}

function buildRig(sceneTree: ReturnType<typeof createSceneTree>, i: number): Node {
    const rootNode = createNode({ name: `char${i}` });
    addChild(sceneTree.root, rootNode);
    addTrait(rootNode, TransformTrait);
    addTrait(rootNode, ModelTrait);
    const byName = new Map<string, Node>();
    for (const name of BONES) {
        const n = createNode({ name });
        addChild(PARENT_OF[name] === null ? rootNode : byName.get(PARENT_OF[name]!)!, n);
        byName.set(name, n);
        addTrait(n, TransformTrait);
        (addTrait(n, MeshTrait) as any).meshId = { modelId: 'probe', meshName: name };
    }
    return rootNode;
}

function build(mode: Mode) {
    const sceneTree = createSceneTree();
    const q = query(sceneTree, [MeshTrait, TransformTrait, Optional(Up(ModelTrait))]);
    const roots: Node[] = [];
    for (let i = 0; i < CHARS; i++) {
        roots.push(buildRig(sceneTree, i));
        if (mode !== 'packed') litter(220);
    }
    if (mode === 'churned') {
        for (let i = 0; i < CHARS; i += 2) {
            removeChild(sceneTree.root, roots[i]!);
            litter(220);
        }
        globalThis.gc?.();
        for (let i = 0; i < CHARS; i += 2) {
            buildRig(sceneTree, i + CHARS);
            litter(220);
        }
    }
    globalThis.gc?.();
    return q;
}

// refreshStates' fast path, verbatim
function walk(q: any, frameId: number): number {
    let seen = 0;
    for (const [meshTrait, , model] of q.matches) {
        const state = meshTrait._state;
        const meshId = meshTrait.meshId;
        if (state !== null && state.meshIdRef === meshId && meshId !== null) {
            state.lastSeenFrame = frameId;
            state.model = model;
            continue;
        }
        seen++;
    }
    return seen;
}

function best(fn: () => void, reps: number): number {
    for (let i = 0; i < 20; i++) fn();
    let b = Infinity;
    for (let r = 0; r < reps; r++) {
        const t0 = process.hrtime.bigint();
        fn();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms < b) b = ms;
    }
    return b;
}

console.log(`\n${CHARS} characters x ${BONES.length} meshes. refreshStates' fast path only.\n`);
console.log(`${'layout'.padEnd(10)} ${'matches'.padStart(8)} ${'ms/frame'.padStart(9)} ${'ns/match'.padStart(9)}`);
for (const mode of ['packed', 'scattered', 'churned'] as Mode[]) {
    const q = build(mode);
    let frameId = 0;
    // seed _state so the fast path is the path taken, as it is in the trace
    for (const [meshTrait] of q.matches as any) {
        meshTrait._state = { meshIdRef: meshTrait.meshId, lastSeenFrame: 0, model: null };
    }
    const n = (q.matches as any).length;
    const ms = best(() => { walk(q, ++frameId); }, 40);
    console.log(`${mode.padEnd(10)} ${String(n).padStart(8)} ${ms.toFixed(3).padStart(9)} ${((ms * 1e6) / n).toFixed(0).padStart(9)}`);
}
console.log();
