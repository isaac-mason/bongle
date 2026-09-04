// How should the renderer collect what to draw?
//
//   ./node_modules/.bin/tsx bench/probe-render-collect.ts
//
// `mesh-visuals` touches the mesh set three times per frame:
//   phase 1  iterate `q.matches`, find-or-create MeshVisualState, stamp lastSeenFrame,
//            copy the `Optional(Up(ModelTrait))` value onto the state
//   phase 2  sweep aliveStates backwards, destroying any whose stamp is stale
//   phase 3  walk aliveStates, gate on visibility, write instance data
//
// Phase 2 exists only because nothing tells the renderer when a mesh LEAVES the query, so
// it re-derives it per frame by stamping survivors. Three shapes for phases 1+2:
//
//   query      what we do now: iterate matches (stamp) + sweep
//   walk       top-down tree walk carrying the model and visibility down, pruning whole
//              hidden subtrees; still needs the sweep
//   events     iterate matches with no stamp and no sweep, on the premise that
//              `onQueryExit` destroys the state when a mesh leaves
//
// Swept over hidden fraction, because that is where a walk's subtree pruning pays: the
// query arms must visit and reject each mesh of a hidden character individually.

import { MeshTrait } from '../src/builtins/mesh';
import { ModelTrait } from '../src/builtins/model';
import { TransformTrait } from '../src/builtins/transform';
import { Optional, Up } from '../src/core/scene/conditions';
import { addChild, addTrait, createNode, createSceneTree, type Node, query } from '../src/core/scene/scene-tree';

const BONES = ['waist', 'body', 'head', 'arm_left', 'arm_right', 'leg_left', 'leg_right'] as const;
const PARENT_OF: Record<string, string | null> = {
    waist: null, leg_left: null, leg_right: null,
    body: 'waist', head: 'waist', arm_left: 'waist', arm_right: 'waist',
};

/** stands in for MeshVisualState: the per-mesh renderer record, stored on the trait. */
type State = { slot: number; lastSeenFrame: number; model: unknown; meshIdRef: unknown };

const MESH_SLOT = MeshTrait._slot;
const MODEL_SLOT = ModelTrait._slot;

function build(characters: number, hiddenFraction: number) {
    const sceneTree = createSceneTree();
    const q = query(sceneTree, [MeshTrait, TransformTrait, Optional(Up(ModelTrait))]);
    const states: State[] = [];
    for (let i = 0; i < characters; i++) {
        const root = createNode({ name: `char${i}` });
        addChild(sceneTree.root, root);
        addTrait(root, TransformTrait);
        const model = addTrait(root, ModelTrait) as any;
        model.visible = i % 100 >= hiddenFraction * 100;

        const byName = new Map<string, Node>();
        for (const name of BONES) {
            const n = createNode({ name });
            const p = PARENT_OF[name];
            addChild(p === null ? root : byName.get(p)!, n);
            byName.set(name, n);
            addTrait(n, TransformTrait);
            const mesh = addTrait(n, MeshTrait) as any;
            mesh.meshId = { modelId: 'probe', meshName: name };
            const state: State = { slot: states.length, lastSeenFrame: 0, model: null, meshIdRef: mesh.meshId };
            mesh._state = state;
            states.push(state);
        }
    }
    return { sceneTree, q, states };
}

/** the per-mesh work all three arms must do, so only the reaching differs. */
function touch(state: State, meshId: unknown, model: unknown, frameId: number, stamp: boolean): void {
    if (stamp) state.lastSeenFrame = frameId;
    state.model = model;
    if (state.meshIdRef !== meshId) state.meshIdRef = meshId;
}

function sweep(states: State[], frameId: number): number {
    let stale = 0;
    for (let i = states.length - 1; i >= 0; i--) if (states[i]!.lastSeenFrame !== frameId) stale++;
    return stale;
}

/** phase 1 as written today: iterate the materialised tuples. */
function collectQuery(q: any, frameId: number, stamp: boolean): void {
    for (const [meshTrait, , model] of q.matches) {
        const state = meshTrait._state as State | null;
        if (state === null) continue;
        touch(state, meshTrait.meshId, model, frameId, stamp);
    }
}

/** top-down walk: the model rides down as a parameter, a hidden subtree is skipped whole. */
function collectWalk(node: Node, model: any, frameId: number): void {
    const own = node.traits[MODEL_SLOT] as any;
    if (own !== undefined) {
        if (!own.visible) return; // prune the entire character
        model = own;
    }
    const mesh = node.traits[MESH_SLOT] as any;
    if (mesh !== undefined) {
        const state = mesh._state as State | null;
        if (state !== null) touch(state, mesh.meshId, model, frameId, true);
    }
    const children = node.children;
    for (let i = 0; i < children.length; i++) collectWalk(children[i]!, model, frameId);
}

function best(fn: () => void, reps: number): number {
    for (let i = 0; i < 30; i++) fn();
    let b = Infinity;
    for (let r = 0; r < reps; r++) {
        const t0 = process.hrtime.bigint();
        fn();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms < b) b = ms;
    }
    return b;
}

console.log(`\nphases 1+2 per frame, ${BONES.length} meshes per character. best-of\n`);
console.log(
    `${'chars'.padStart(6)} ${'meshes'.padStart(7)} ${'hidden'.padStart(7)} ${'query'.padStart(8)} ${'walk'.padStart(8)} ${'events'.padStart(8)}   ${'walk vs query'.padStart(13)}`,
);
for (const characters of [100, 1000, 4000]) {
    for (const hidden of [0, 0.5]) {
        const { sceneTree, q, states } = build(characters, hidden);
        let frame = 0;
        const tQuery = best(() => {
            frame++;
            collectQuery(q, frame, true);
            sweep(states, frame);
        }, 150);
        const tWalk = best(() => {
            frame++;
            collectWalk(sceneTree.root, null, frame);
            sweep(states, frame);
        }, 150);
        const tEvents = best(() => {
            frame++;
            collectQuery(q, frame, false);
        }, 150);
        console.log(
            `${String(characters).padStart(6)} ${String(characters * BONES.length).padStart(7)} ${`${hidden * 100}%`.padStart(7)} ${tQuery.toFixed(3).padStart(8)} ${tWalk.toFixed(3).padStart(8)} ${tEvents.toFixed(3).padStart(8)}   ${(tQuery / tWalk).toFixed(2).padStart(12)}x`,
        );
    }
}
