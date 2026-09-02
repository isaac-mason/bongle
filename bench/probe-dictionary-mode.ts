// what pushes a dynamically-built trait instance into dictionary mode?
// run: node --allow-natives-syntax --import tsx bench/probe-dictionary-mode.ts

const hasFastProperties = new Function('a', 'return %HasFastProperties(a);') as (a: object) => boolean;

function buildDynamic(fieldCount: number): Record<string, unknown> {
    const out: Record<string, unknown> = { _node: null, _def: null };
    for (let i = 0; i < fieldCount; i++) out[`f${i}`] = i;
    return out;
}

console.log('dynamic property stores:');
for (const n of [4, 8, 12, 16, 18, 20, 24, 30, 40]) {
    const o = buildDynamic(n);
    console.log(`  ${String(n + 2).padStart(3)} props  fast=${hasFastProperties(o)}`);
}

console.log('\nsame counts, but spread through a literal afterwards:');
for (const n of [16, 24, 40]) {
    const o = { ...buildDynamic(n) };
    console.log(`  ${String(n + 2).padStart(3)} props  fast=${hasFastProperties(o)}`);
}

console.log('\nsame counts via Object.assign onto a fresh object:');
for (const n of [16, 24, 40]) {
    const o = Object.assign({}, buildDynamic(n));
    console.log(`  ${String(n + 2).padStart(3)} props  fast=${hasFastProperties(o)}`);
}

console.log('\npre-sized with a null-valued literal then overwritten:');
for (const n of [16, 24, 40]) {
    const template: Record<string, unknown> = { _node: null, _def: null };
    for (let i = 0; i < n; i++) template[`f${i}`] = null;
    const o = { ...template };
    for (let i = 0; i < n; i++) o[`f${i}`] = i;
    console.log(`  ${String(n + 2).padStart(3)} props  fast=${hasFastProperties(o)}`);
}
