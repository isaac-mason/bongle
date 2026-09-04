// Are the engine's real trait instances in V8 fast mode, or dictionary mode?
//
//   ./node_modules/.bin/tsx --allow-natives-syntax bench/probe-trait-fastmode.ts
//
// `probe-fast-vs-dictionary` puts dictionary-mode access at 5.6x fast-mode and its
// retained size at 1656 B vs 320 B. `probe-character-heap` measures 2.5 KB per scene
// node, and the 1000-character trace has `refreshStates` costing ~1.1 us per match to
// write two fields. This asks the question those three imply: what mode are the
// instances the engine actually builds?

import { MeshTrait } from '../src/builtins/mesh';
import { ModelTrait } from '../src/builtins/model';
import { TransformTrait } from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree } from '../src/core/scene/scene-tree';

const hasFast = new Function('o', 'return %HasFastProperties(o)') as (o: object) => boolean;

const sceneTree = createSceneTree();
const rows: Array<[string, object]> = [];

const node = createNode({ name: 'probe' });
addChild(sceneTree.root, node);
rows.push(['Node', node]);
rows.push(['TransformTrait', addTrait(node, TransformTrait) as object]);
rows.push(['ModelTrait', addTrait(node, ModelTrait) as object]);
const mesh = addTrait(node, MeshTrait) as any;
mesh.meshId = { modelId: 'probe', meshName: 'body' };
rows.push(['MeshTrait', mesh]);

console.log('\nV8 property mode for engine objects (fast mode = inline slots, dictionary = hash)\n');
for (const [label, obj] of rows) {
    console.log(`  ${label.padEnd(16)} ${hasFast(obj) ? 'fast' : 'DICTIONARY'}`);
}

// and after the renderer attaches its per-instance state, the write refreshStates does
mesh._state = { meshIdRef: mesh.meshId, lastSeenFrame: 0, model: null };
console.log(`  ${'MeshTrait +_state'.padEnd(16)} ${hasFast(mesh) ? 'fast' : 'DICTIONARY'}`);
console.log();
