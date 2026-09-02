// ways to build a 25-field trait instance, and what each costs to make, read and hold.
// run: node --allow-natives-syntax --expose-gc --import tsx bench/probe-instance-shape.ts

const hasFastProperties = new Function('a', 'return %HasFastProperties(a);') as (a: object) => boolean;

const KEYS = Array.from({ length: 22 }, (_, i) => `f${i}`);
const COUNT = 20000;

/** today: 25 dynamic stores onto a 2-field literal. */
function buildDynamic(): Record<string, unknown> {
    const out: Record<string, unknown> = { _node: null, _def: null };
    for (const k of KEYS) out[k] = 0;
    out.position = [0, 0, 0];
    out._dirty = 31;
    out._version = 0;
    return out;
}

/** one fast-mode template per def, cloned per instance. */
const slowTemplate = buildDynamic();
const fastTemplate = { ...slowTemplate };
function buildFromTemplate(): Record<string, unknown> {
    const out = { ...fastTemplate };
    out.position = [0, 0, 0];
    out._dirty = 31;
    out._version = 0;
    return out;
}

/** the sub-object split: nothing over the threshold. */
function buildSplit(): Record<string, unknown> {
    return {
        _node: null,
        _def: null,
        local: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        world: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], matrix: new Array(16).fill(0) },
        flags: { _dirty: 31, _version: 0, _interpolated: 0, interpolate: 0, teleport: 0, lastTeleport: 0 },
    };
}

console.log('dynamic  fast?', hasFastProperties(buildDynamic()));
console.log('template fast?', hasFastProperties(buildFromTemplate()));
console.log('split    fast?', hasFastProperties(buildSplit()));

function timed(label: string, fn: () => unknown, iters = 200000): void {
    let sink = 0;
    for (let i = 0; i < 5000; i++) sink += fn() === null ? 1 : 0;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) sink += fn() === null ? 1 : 0;
    const t1 = process.hrtime.bigint();
    console.log(`${label.padEnd(34)} ${(Number(t1 - t0) / iters).toFixed(0)} ns  (${sink})`);
}

console.log('\n── creation ──');
timed('dynamic (today, dictionary)', buildDynamic);
timed('clone a fast template', buildFromTemplate);
timed('sub-object split', buildSplit);

const dynamic = Array.from({ length: COUNT }, buildDynamic);
const template = Array.from({ length: COUNT }, buildFromTemplate);
const split = Array.from({ length: COUNT }, buildSplit);

function timedLoop(label: string, read: (i: number) => number, iters = 2000): void {
    let sink = 0;
    const run = () => {
        let acc = 0;
        for (let i = 0; i < COUNT; i++) acc += read(i);
        return acc;
    };
    for (let i = 0; i < 200; i++) sink += run();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) sink += run();
    const t1 = process.hrtime.bigint();
    console.log(`${label.padEnd(34)} ${(Number(t1 - t0) / iters / COUNT).toFixed(2)} ns / instance  (${sink % 7})`);
}

console.log('\n── read _dirty + _version + position[0] ──');
timedLoop('dynamic (dictionary)', (i) => {
    const t = dynamic[i]!;
    return (t._dirty as number) + (t._version as number) + (t.position as number[])[0]!;
});
timedLoop('template clone (fast)', (i) => {
    const t = template[i]!;
    return (t._dirty as number) + (t._version as number) + (t.position as number[])[0]!;
});
timedLoop('sub-object split (fast)', (i) => {
    const t = split[i]! as { flags: Record<string, number>; local: { position: number[] } };
    return t.flags._dirty! + t.flags._version! + t.local.position[0]!;
});

function retained(label: string, fn: () => unknown, count = 200000): void {
    const keep: unknown[] = new Array(count);
    for (let i = 0; i < 2000; i++) fn();
    global.gc?.();
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < count; i++) keep[i] = fn();
    global.gc?.();
    const after = process.memoryUsage().heapUsed;
    console.log(`${label.padEnd(34)} ${((after - before) / count).toFixed(0)} B  (${keep.length > 0 ? '' : ''})`);
}

console.log('\n── retained size ──');
retained('dynamic (dictionary)', buildDynamic);
retained('template clone (fast)', buildFromTemplate);
retained('sub-object split (fast)', buildSplit);
