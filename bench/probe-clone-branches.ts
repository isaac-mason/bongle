// Which cloneTraitValue branches do real trait bodies actually reach?
//   ./node_modules/.bin/tsx bench/probe-clone-branches.ts
import '../src/builtins/transform';
import '../src/builtins/mesh';
import '../src/builtins/model';
import '../src/builtins/character';
import '../src/builtins/character-controller';
import '../src/builtins/player-node';
import { registry } from '../src/core/registry';

let total = 0;
const buckets = { factory: 0, primitive: 0, arrayOfPrimitives: 0, plainObject: 0, typedArray: 0, other: 0 };
const notInlinable: string[] = [];

for (const [id, def] of registry.traits.byId) {
    for (const key of Object.keys(def.body)) {
        const v = def.body[key];
        total++;
        if (typeof v === 'function') { buckets.factory++; continue; }
        if (v === null || typeof v !== 'object') { buckets.primitive++; continue; }
        if (Array.isArray(v)) {
            if (v.every((i) => i === null || typeof i !== 'object')) { buckets.arrayOfPrimitives++; continue; }
            buckets.other++; notInlinable.push(`${id}.${key} (array of objects)`); continue;
        }
        if (ArrayBuffer.isView(v)) { buckets.typedArray++; notInlinable.push(`${id}.${key} (typed array)`); continue; }
        const proto = Object.getPrototypeOf(v);
        if (proto === Object.prototype || proto === null) {
            buckets.plainObject++; notInlinable.push(`${id}.${key} (plain object)`); continue;
        }
        buckets.other++; notInlinable.push(`${id}.${key} (${v.constructor?.name ?? 'exotic'})`);
    }
}

console.log(`\n${registry.traits.byId.size} traits, ${total} body fields\n`);
for (const [k, n] of Object.entries(buckets)) console.log(`  ${k.padEnd(20)} ${n}`);
console.log(`\nfields that reach cloneTraitValue at construction (not inlinable): ${notInlinable.length}`);
for (const f of notInlinable) console.log(`  ${f}`);
