// how much does packing several renderables per dbvt leaf save the descent?
// run: node_modules/.bin/tsx bench/probe-dbvt-leafsize.ts

const ITEM_COUNT = 5000;

let seed = 0x9e3779b9;
const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
};

type Item = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number; data: number };

const items: Item[] = [];
let cx = 0;
let cy = 0;
let cz = 0;
for (let i = 0; i < ITEM_COUNT; i++) {
    if (i % 8 === 0) {
        cx = (random() - 0.5) * 400;
        cy = (random() - 0.5) * 100;
        cz = (random() - 0.5) * 400;
    }
    const x = cx + (random() - 0.5) * 8;
    const y = cy + (random() - 0.5) * 8;
    const z = cz + (random() - 0.5) * 8;
    items.push({ minX: x - 0.5, minY: y - 0.5, minZ: z - 0.5, maxX: x + 0.5, maxY: y + 0.5, maxZ: z + 0.5, data: i });
}

type Node = {
    left: number;
    right: number;
    items: Item[] | null;
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
};

/** median-split build over `itemsPerLeaf`, so both arms get an equally good tree. */
function build(itemsPerLeaf: number): Node[] {
    const nodes: Node[] = [];
    const make = (slice: Item[], depth: number): number => {
        const index = nodes.length;
        let minX = Infinity,
            minY = Infinity,
            minZ = Infinity;
        let maxX = -Infinity,
            maxY = -Infinity,
            maxZ = -Infinity;
        for (const it of slice) {
            if (it.minX < minX) minX = it.minX;
            if (it.minY < minY) minY = it.minY;
            if (it.minZ < minZ) minZ = it.minZ;
            if (it.maxX > maxX) maxX = it.maxX;
            if (it.maxY > maxY) maxY = it.maxY;
            if (it.maxZ > maxZ) maxZ = it.maxZ;
        }
        nodes.push({ left: -1, right: -1, items: null, minX, minY, minZ, maxX, maxY, maxZ });
        if (slice.length <= itemsPerLeaf) {
            nodes[index]!.items = slice;
            return index;
        }
        const axis = depth % 3;
        const key = (it: Item) => (axis === 0 ? it.minX : axis === 1 ? it.minY : it.minZ);
        slice.sort((a, b) => key(a) - key(b));
        const mid = slice.length >> 1;
        const l = make(slice.slice(0, mid), depth + 1);
        const r = make(slice.slice(mid), depth + 1);
        nodes[index]!.left = l;
        nodes[index]!.right = r;
        return index;
    };
    make(items.slice(), 0);
    return nodes;
}

const planes = new Float64Array(24);
for (let i = 0; i < 6; i++) {
    const nx = random() - 0.5;
    const ny = random() - 0.5;
    const nz = random() - 0.5;
    const len = Math.hypot(nx, ny, nz);
    planes[i * 4] = nx / len;
    planes[i * 4 + 1] = ny / len;
    planes[i * 4 + 2] = nz / len;
    planes[i * 4 + 3] = 150;
}

const stack = new Int32Array(8192);
const masks = new Uint8Array(8192);

function descend(nodes: Node[], counters: { visits: number; hits: number }): number {
    let acc = 0;
    let size = 0;
    stack[size] = 0;
    masks[size] = 0b111111;
    size++;
    while (size > 0) {
        size--;
        const node = nodes[stack[size]!]!;
        let mask = masks[size]!;
        counters.visits++;
        const minX = node.minX,
            minY = node.minY,
            minZ = node.minZ;
        const maxX = node.maxX,
            maxY = node.maxY,
            maxZ = node.maxZ;
        let outside = false;
        for (let i = 0; i < 6; i++) {
            const bit = 1 << i;
            if ((mask & bit) === 0) continue;
            const o = i * 4;
            const nx = planes[o]!,
                ny = planes[o + 1]!,
                nz = planes[o + 2]!,
                d = planes[o + 3]!;
            const px = nx >= 0 ? maxX : minX,
                py = ny >= 0 ? maxY : minY,
                pz = nz >= 0 ? maxZ : minZ;
            if (nx * px + ny * py + nz * pz + d < 0) {
                outside = true;
                break;
            }
            const qx = nx >= 0 ? minX : maxX,
                qy = ny >= 0 ? minY : maxY,
                qz = nz >= 0 ? minZ : maxZ;
            if (nx * qx + ny * qy + nz * qz + d >= 0) mask &= ~bit;
        }
        if (outside) continue;
        const leafItems = node.items;
        if (leafItems !== null) {
            for (let k = 0; k < leafItems.length; k++) {
                const it = leafItems[k]!;
                let itemOutside = false;
                for (let i = 0; i < 6; i++) {
                    const bit = 1 << i;
                    if ((mask & bit) === 0) continue;
                    const o = i * 4;
                    const nx = planes[o]!,
                        ny = planes[o + 1]!,
                        nz = planes[o + 2]!,
                        d = planes[o + 3]!;
                    const px = nx >= 0 ? it.maxX : it.minX;
                    const py = ny >= 0 ? it.maxY : it.minY;
                    const pz = nz >= 0 ? it.maxZ : it.minZ;
                    if (nx * px + ny * py + nz * pz + d < 0) {
                        itemOutside = true;
                        break;
                    }
                }
                if (!itemOutside) {
                    acc += it.data;
                    counters.hits++;
                }
            }
            continue;
        }
        stack[size] = node.left;
        masks[size] = mask;
        size++;
        stack[size] = node.right;
        masks[size] = mask;
        size++;
    }
    return acc;
}

for (const perLeaf of [1, 2, 4, 8]) {
    const nodes = build(perLeaf);
    const counters = { visits: 0, hits: 0 };
    let sink = 0;
    for (let i = 0; i < 200; i++) sink += descend(nodes, counters);
    counters.visits = 0;
    counters.hits = 0;
    const iters = 3000;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) sink += descend(nodes, counters);
    const t1 = process.hrtime.bigint();
    console.log(
        `${String(perLeaf).padStart(2)} items/leaf  ${String(nodes.length).padStart(5)} nodes  ` +
            `${(Number(t1 - t0) / 1e6 / iters).toFixed(4)} ms  ` +
            `visits/descent ${Math.round(counters.visits / iters)}  hits ${Math.round(counters.hits / iters)}  (${sink % 7})`,
    );
}
