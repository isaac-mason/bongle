// how many body fields each registered trait has, and which would have gone
// dictionary-mode under successive stores.
// run: node --allow-natives-syntax --import tsx bench/probe-trait-field-counts.ts

import '../src/builtins/aabb-body';
import '../src/builtins/animator';
import '../src/builtins/audio-listener';
import '../src/builtins/camera';
import '../src/builtins/canvas';
import '../src/builtins/character';
import '../src/builtins/character-controller';
import '../src/builtins/contacts';
import '../src/builtins/extruded-sprite';
import '../src/builtins/fly-controller';
import '../src/builtins/html';
import '../src/builtins/mesh';
import '../src/builtins/orbit-controller';
import '../src/builtins/player';
import '../src/builtins/player-controller';
import '../src/builtins/rigid-body';
import '../src/builtins/shadow-caster';
import '../src/builtins/sprite';
import '../src/builtins/transform';
import '../src/builtins/voxel-mesh';
import '../src/builtins/world';
import { registry } from '../src/core/registry';
import { buildTraitInstance } from '../src/core/scene/traits';

const hasFastProperties = new Function('a', 'return %HasFastProperties(a);') as (a: object) => boolean;

/** the pre-change construction: successive stores onto a two-field literal. */
function buildTheOldWay(body: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { _node: null, _def: null };
    for (const key of Object.keys(body)) out[key] = null;
    out._sync = null;
    return out;
}

const defs = [...registry.traits.byId.values()].sort((a, b) => Object.keys(b.body).length - Object.keys(a.body).length);
let wasSlow = 0;
for (const def of defs) {
    const fields = Object.keys(def.body).length;
    const oldFast = hasFastProperties(buildTheOldWay(def.body));
    const nowFast = hasFastProperties(buildTraitInstance(def));
    if (!oldFast) wasSlow++;
    console.log(
        `${def.id.padEnd(26)} ${String(fields).padStart(3)} fields   before: ${oldFast ? 'fast' : 'DICTIONARY'}   after: ${nowFast ? 'fast' : 'DICTIONARY'}`,
    );
}
console.log(`\n${wasSlow} of ${defs.length} traits were in dictionary mode.`);
