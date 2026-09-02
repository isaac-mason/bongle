// map vs sparse vs dense layouts for `node._traits`.
// run: node_modules/.bin/tsx bench/probe-trait-storage.ts

/** the engine's builtins occupy 0-21; games extend from there. */
const SLOT_COUNT = 22;
const NODE_COUNT = 20000;
/** `transform`, which the global slot counter really does hand out first. */
const TRANSFORM_SLOT = 0;
/** `shadow-caster`, a trait most nodes do NOT carry — the miss case. */
const RARE_SLOT = 20;

type Instance = { slot: number; a: number; b: number; c: number };

function makeInstance(slot: number): Instance {
    return { slot, a: slot, b: 0, c: 0 };
}

function slotsFor(i: number): number[] {
    const slots = new Set<number>([TRANSFORM_SLOT]);
    const extra = 1 + (i % 4); // 2-5 traits per node
    for (let k = 0; k < extra; k++) slots.add(1 + ((i * 7 + k * 5) % (SLOT_COUNT - 2)));
    return [...slots].sort((a, b) => a - b);
}

/** the other fields a Node carries, so object size and shape are realistic. */
type NodeBase = {
    id: number;
    name: string | undefined;
    parent: unknown;
    children: unknown[];
    scene: unknown;
    owner: unknown;
    persist: boolean;
    realm: string;
};

function nodeBase(i: number): NodeBase {
    return {
        id: i,
        name: undefined,
        parent: null,
        children: [],
        scene: null,
        owner: null,
        persist: true,
        realm: 'inherit',
    };
}

type MapNode = NodeBase & { traits: Map<number, Instance> };
type SparseNode = NodeBase & { traits: Array<Instance | undefined> };
type DenseNode = NodeBase & { slots: number[]; values: Instance[] };
type BitsetNode = NodeBase & { traits: Array<Instance | undefined>; bitset: Int32Array };

const bitsetNodes: BitsetNode[] = [];
const mapNodes: MapNode[] = [];
const sparseNodes: SparseNode[] = [];
const denseNodes: DenseNode[] = [];

let widest = 0;
for (let i = 0; i < NODE_COUNT; i++) {
    const slots = slotsFor(i);
    if (slots[slots.length - 1]! + 1 > widest) widest = slots[slots.length - 1]! + 1;

    const map = new Map<number, Instance>();
    for (const s of slots) map.set(s, makeInstance(s));
    mapNodes.push({ ...nodeBase(i), traits: map });

    const sparse: Array<Instance | undefined> = [];
    for (const s of slots) sparse[s] = makeInstance(s);
    sparseNodes.push({ ...nodeBase(i), traits: sparse });

    const dslots: number[] = [];
    const dvalues: Instance[] = [];
    for (const s of slots) {
        dslots.push(s);
        dvalues.push(makeInstance(s));
    }
    denseNodes.push({ ...nodeBase(i), slots: dslots, values: dvalues });

    const bsparse: Array<Instance | undefined> = [];
    const bitset = new Int32Array(Math.ceil(SLOT_COUNT / 32));
    for (const s of slots) {
        bsparse[s] = makeInstance(s);
        bitset[s >> 5]! |= 1 << (s & 31);
    }
    bitsetNodes.push({ ...nodeBase(i), traits: bsparse, bitset });
}
console.log(`${NODE_COUNT} nodes, 2-5 traits each, widest sparse array ${widest} elements`);

let keepAlive = 0;

function measure(label: string, fn: () => number, iters = 400): number {
    let sink = 0;
    for (let i = 0; i < 50; i++) sink += fn();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) sink += fn();
    const t1 = process.hrtime.bigint();
    console.log(`${label.padEnd(46)} ${(Number(t1 - t0) / iters / NODE_COUNT).toFixed(2)} ns / node`);
    return sink;
}

console.log('\n── getTrait, trait present (transform, slot 0) ──────────────');

keepAlive += measure('map      _traits.get(slot)', () => {
    let acc = 0;
    for (let i = 0; i < NODE_COUNT; i++) {
        const t = mapNodes[i]!.traits.get(TRANSFORM_SLOT);
        if (t !== undefined) acc += t.a;
    }
    return acc;
});

keepAlive += measure('sparse   _traits[slot]', () => {
    let acc = 0;
    for (let i = 0; i < NODE_COUNT; i++) {
        const t = sparseNodes[i]!.traits[TRANSFORM_SLOT];
        if (t !== undefined) acc += t.a;
    }
    return acc;
});

keepAlive += measure('dense    linear scan of slots[]', () => {
    let acc = 0;
    for (let i = 0; i < NODE_COUNT; i++) {
        const node = denseNodes[i]!;
        const slots = node.slots;
        for (let k = 0; k < slots.length; k++) {
            if (slots[k] === TRANSFORM_SLOT) {
                acc += node.values[k]!.a;
                break;
            }
        }
    }
    return acc;
});

console.log('\n── getTrait, trait absent (shadow-caster, slot 20) ──────────');

keepAlive += measure('map      miss', () => {
    let acc = 0;
    for (let i = 0; i < NODE_COUNT; i++) if (mapNodes[i]!.traits.get(RARE_SLOT) !== undefined) acc++;
    return acc;
});

keepAlive += measure('sparse   miss', () => {
    let acc = 0;
    for (let i = 0; i < NODE_COUNT; i++) if (sparseNodes[i]!.traits[RARE_SLOT] !== undefined) acc++;
    return acc;
});

keepAlive += measure('dense    miss (scans the whole list)', () => {
    let acc = 0;
    for (let i = 0; i < NODE_COUNT; i++) {
        const slots = denseNodes[i]!.slots;
        for (let k = 0; k < slots.length; k++) {
            if (slots[k] === RARE_SLOT) {
                acc++;
                break;
            }
        }
    }
    return acc;
});

console.log("\n── iterate a node's traits (the AOI fan-out shape) ──────────");

keepAlive += measure('map      for (const [s, t] of traits)', () => {
    let acc = 0;
    for (let i = 0; i < NODE_COUNT; i++) {
        for (const [slot, instance] of mapNodes[i]!.traits) acc += slot + instance.a;
    }
    return acc;
});

keepAlive += measure('sparse   scan 0..length, skip holes', () => {
    let acc = 0;
    for (let i = 0; i < NODE_COUNT; i++) {
        const traits = sparseNodes[i]!.traits;
        for (let slot = 0; slot < traits.length; slot++) {
            const instance = traits[slot];
            if (instance !== undefined) acc += slot + instance.a;
        }
    }
    return acc;
});

keepAlive += measure('dense    for k in slots[]', () => {
    let acc = 0;
    for (let i = 0; i < NODE_COUNT; i++) {
        const node = denseNodes[i]!;
        const slots = node.slots;
        const values = node.values;
        for (let k = 0; k < slots.length; k++) acc += slots[k]! + values[k]!.a;
    }
    return acc;
});

keepAlive += measure('sparse   walk the bitset it already has', () => {
    let acc = 0;
    for (let i = 0; i < NODE_COUNT; i++) {
        const node = bitsetNodes[i]!;
        const bits = node.bitset;
        const traits = node.traits;
        for (let w = 0; w < bits.length; w++) {
            let word = bits[w]!;
            while (word !== 0) {
                const bit = word & -word;
                const slot = w * 32 + (31 - Math.clz32(bit));
                acc += slot + traits[slot]!.a;
                word ^= bit;
            }
        }
    }
    return acc;
});

console.log('\n── construction (the spawn path) ────────────────────────────');

const SAMPLE_SLOTS = slotsFor(3);

function buildMeasure(label: string, fn: () => unknown, iters = 200000): void {
    for (let i = 0; i < 20000; i++) fn();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn();
    const t1 = process.hrtime.bigint();
    console.log(`${label.padEnd(46)} ${(Number(t1 - t0) / iters).toFixed(1)} ns / node`);
}

buildMeasure(`map      new Map + ${SAMPLE_SLOTS.length} sets`, () => {
    const m = new Map<number, Instance>();
    for (const s of SAMPLE_SLOTS) m.set(s, makeInstance(s));
    return m;
});

buildMeasure(`sparse   [] + ${SAMPLE_SLOTS.length} indexed writes`, () => {
    const a: Array<Instance | undefined> = [];
    for (const s of SAMPLE_SLOTS) a[s] = makeInstance(s);
    return a;
});

buildMeasure(`dense    2 arrays + ${SAMPLE_SLOTS.length} pushes`, () => {
    const slots: number[] = [];
    const values: Instance[] = [];
    for (const s of SAMPLE_SLOTS) {
        slots.push(s);
        values.push(makeInstance(s));
    }
    return values;
});

if (keepAlive === -1) console.log('unreachable');
