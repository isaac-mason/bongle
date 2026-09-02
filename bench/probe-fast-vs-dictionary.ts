// dictionary-mode vs fast-mode trait instances: creation, access and size.
// run: node --allow-natives-syntax --expose-gc --import tsx bench/probe-fast-vs-dictionary.ts

const hasFastProperties = new Function('a', 'return %HasFastProperties(a);') as (a: object) => boolean;

const FIELDS = 25;
const COUNT = 20000;

function buildSlow(): Record<string, unknown> {
    const out: Record<string, unknown> = { _node: null, _def: null };
    for (let i = 0; i < FIELDS; i++) out[`f${i}`] = i;
    out.position = [0, 0, 0];
    out._dirty = 31;
    out._version = 0;
    return out;
}

function buildFast(): Record<string, unknown> {
    return { ...buildSlow() };
}

console.log('slow build fast-mode?', hasFastProperties(buildSlow()));
console.log('fast build fast-mode?', hasFastProperties(buildFast()));

function timed(label: string, fn: () => unknown, iters: number): void {
    let sink = 0;
    for (let i = 0; i < 5000; i++) sink += fn() === null ? 1 : 0;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) sink += fn() === null ? 1 : 0;
    const t1 = process.hrtime.bigint();
    console.log(`${label.padEnd(38)} ${(Number(t1 - t0) / iters).toFixed(0)} ns  (${sink})`);
}

console.log('\n── creation ──');
timed('build dynamic (dictionary)', buildSlow, 200000);
timed('build dynamic + spread (fast)', buildFast, 200000);

const slow = Array.from({ length: COUNT }, buildSlow);
const fast = Array.from({ length: COUNT }, buildFast);

function readLoop(list: Array<Record<string, unknown>>): number {
    let acc = 0;
    for (let i = 0; i < list.length; i++) {
        const t = list[i]!;
        acc += (t._dirty as number) + (t._version as number) + (t.position as number[])[0]!;
    }
    return acc;
}

function timedLoop(label: string, list: Array<Record<string, unknown>>, iters = 2000): void {
    let sink = 0;
    for (let i = 0; i < 200; i++) sink += readLoop(list);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) sink += readLoop(list);
    const t1 = process.hrtime.bigint();
    console.log(`${label.padEnd(38)} ${(Number(t1 - t0) / iters / list.length).toFixed(2)} ns / instance  (${sink % 7})`);
}

console.log('\n── field access, 3 fields x 20000 instances ──');
timedLoop('dictionary mode', slow);
timedLoop('fast mode', fast);
timedLoop('dictionary mode', slow);
timedLoop('fast mode', fast);

function retained(label: string, fn: () => unknown, count = 200000): void {
    const keep: unknown[] = new Array(count);
    for (let i = 0; i < 2000; i++) fn();
    global.gc?.();
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < count; i++) keep[i] = fn();
    global.gc?.();
    const after = process.memoryUsage().heapUsed;
    console.log(`${label.padEnd(38)} ${((after - before) / count).toFixed(0)} B  (${keep.length > 0 ? '' : ''})`);
}

console.log('\n── retained size ──');
retained('dictionary mode', buildSlow);
retained('fast mode', buildFast);
