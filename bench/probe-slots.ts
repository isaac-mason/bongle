// what slot numbers the engine's traits get.
// run: node_modules/.bin/tsx bench/probe-slots.ts

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

const defs = [...registry.traits.byId.values()].sort((a, b) => a.slot - b.slot);
console.log('registered traits:', defs.length, ' max slot:', defs[defs.length - 1]?.slot);
for (const d of defs) console.log(String(d.slot).padStart(3), d.id);
