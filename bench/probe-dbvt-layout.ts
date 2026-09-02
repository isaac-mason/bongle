// AoS (object + Box3 array per node) vs SoA (typed arrays) for the cull descent.
// run: node_modules/.bin/tsx bench/probe-dbvt-layout.ts

const NODE_COUNT = 10000;

type AosNode = { parent: number; left: number; right: number; height: number; data: number; aabb: number[] };

const aos: AosNode[] = [];
const bounds = new Float64Array(NODE_COUNT * 6);
const links = new Int32Array(NODE_COUNT * 4);

let seed = 12345;
const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
};

for (let i = 0; i < NODE_COUNT; i++) {
    const x = (random() - 0.5) * 400;
    const y = (random() - 0.5) * 100;
    const z = (random() - 0.5) * 400;
    const box = [x - 1, y - 1, z - 1, x + 1, y + 1, z + 1];
    const left = 2 * i + 1 < NODE_COUNT ? 2 * i + 1 : -1;
    const right = 2 * i + 2 < NODE_COUNT ? 2 * i + 2 : -1;
    aos.push({ parent: ((i - 1) / 2) | 0, left, right, height: 0, data: i, aabb: box });
    for (let k = 0; k < 6; k++) bounds[i * 6 + k] = box[k]!;
    links[i * 4] = ((i - 1) / 2) | 0;
    links[i * 4 + 1] = left;
    links[i * 4 + 2] = right;
    links[i * 4 + 3] = i;
}

const planes = new Float64Array(24);
for (let i = 0; i < 6; i++) {
    planes[i * 4] = random() - 0.5;
    planes[i * 4 + 1] = random() - 0.5;
    planes[i * 4 + 2] = random() - 0.5;
    planes[i * 4 + 3] = 260;
}

const stack = new Int32Array(4096);

function descendAos(): number {
    let hits = 0;
    let size = 0;
    stack[size++] = 0;
    while (size > 0) {
        const node = aos[stack[--size]!]!;
        const b = node.aabb;
        const minX = b[0]!,
            minY = b[1]!,
            minZ = b[2]!,
            maxX = b[3]!,
            maxY = b[4]!,
            maxZ = b[5]!;
        let outside = false;
        for (let i = 0; i < 6; i++) {
            const o = i * 4;
            const nx = planes[o]!,
                ny = planes[o + 1]!,
                nz = planes[o + 2]!;
            const px = nx >= 0 ? maxX : minX;
            const py = ny >= 0 ? maxY : minY;
            const pz = nz >= 0 ? maxZ : minZ;
            if (nx * px + ny * py + nz * pz + planes[o + 3]! < 0) {
                outside = true;
                break;
            }
        }
        if (outside) continue;
        if (node.left === -1) {
            hits += node.data;
            continue;
        }
        stack[size++] = node.left;
        if (node.right !== -1) stack[size++] = node.right;
    }
    return hits;
}

function descendSoa(): number {
    let hits = 0;
    let size = 0;
    stack[size++] = 0;
    while (size > 0) {
        const node = stack[--size]!;
        const b = node * 6;
        const minX = bounds[b]!,
            minY = bounds[b + 1]!,
            minZ = bounds[b + 2]!;
        const maxX = bounds[b + 3]!,
            maxY = bounds[b + 4]!,
            maxZ = bounds[b + 5]!;
        let outside = false;
        for (let i = 0; i < 6; i++) {
            const o = i * 4;
            const nx = planes[o]!,
                ny = planes[o + 1]!,
                nz = planes[o + 2]!;
            const px = nx >= 0 ? maxX : minX;
            const py = ny >= 0 ? maxY : minY;
            const pz = nz >= 0 ? maxZ : minZ;
            if (nx * px + ny * py + nz * pz + planes[o + 3]! < 0) {
                outside = true;
                break;
            }
        }
        if (outside) continue;
        const l = node * 4;
        if (links[l + 1] === -1) {
            hits += links[l + 3]!;
            continue;
        }
        stack[size++] = links[l + 1]!;
        if (links[l + 2] !== -1) stack[size++] = links[l + 2]!;
    }
    return hits;
}

function measure(label: string, fn: () => number, iters = 3000) {
    let sink = 0;
    for (let i = 0; i < 300; i++) sink += fn();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) sink += fn();
    const t1 = process.hrtime.bigint();
    console.log(`${label.padEnd(14)} ${(Number(t1 - t0) / 1e6 / iters).toFixed(4)} ms/descent  (checksum ${sink % 97})`);
}

function descendHoisted(): number {
    const p0x = planes[0]!,
        p0y = planes[1]!,
        p0z = planes[2]!,
        p0d = planes[3]!;
    const p1x = planes[4]!,
        p1y = planes[5]!,
        p1z = planes[6]!,
        p1d = planes[7]!;
    const p2x = planes[8]!,
        p2y = planes[9]!,
        p2z = planes[10]!,
        p2d = planes[11]!;
    const p3x = planes[12]!,
        p3y = planes[13]!,
        p3z = planes[14]!,
        p3d = planes[15]!;
    const p4x = planes[16]!,
        p4y = planes[17]!,
        p4z = planes[18]!,
        p4d = planes[19]!;
    const p5x = planes[20]!,
        p5y = planes[21]!,
        p5z = planes[22]!,
        p5d = planes[23]!;
    let hits = 0;
    let size = 0;
    stack[size++] = 0;
    while (size > 0) {
        const node = aos[stack[--size]!]!;
        const b = node.aabb;
        const minX = b[0]!,
            minY = b[1]!,
            minZ = b[2]!,
            maxX = b[3]!,
            maxY = b[4]!,
            maxZ = b[5]!;
        if (p0x * (p0x >= 0 ? maxX : minX) + p0y * (p0y >= 0 ? maxY : minY) + p0z * (p0z >= 0 ? maxZ : minZ) + p0d < 0) continue;
        if (p1x * (p1x >= 0 ? maxX : minX) + p1y * (p1y >= 0 ? maxY : minY) + p1z * (p1z >= 0 ? maxZ : minZ) + p1d < 0) continue;
        if (p2x * (p2x >= 0 ? maxX : minX) + p2y * (p2y >= 0 ? maxY : minY) + p2z * (p2z >= 0 ? maxZ : minZ) + p2d < 0) continue;
        if (p3x * (p3x >= 0 ? maxX : minX) + p3y * (p3y >= 0 ? maxY : minY) + p3z * (p3z >= 0 ? maxZ : minZ) + p3d < 0) continue;
        if (p4x * (p4x >= 0 ? maxX : minX) + p4y * (p4y >= 0 ? maxY : minY) + p4z * (p4z >= 0 ? maxZ : minZ) + p4d < 0) continue;
        if (p5x * (p5x >= 0 ? maxX : minX) + p5y * (p5y >= 0 ? maxY : minY) + p5z * (p5z >= 0 ? maxZ : minZ) + p5d < 0) continue;
        if (node.left === -1) {
            hits += node.data;
            continue;
        }
        stack[size++] = node.left;
        if (node.right !== -1) stack[size++] = node.right;
    }
    return hits;
}

for (let r = 0; r < 3; r++) {
    measure('AoS, plane array', descendAos);
    measure('SoA, plane array', descendSoa);
    measure('AoS, hoisted planes', descendHoisted);
}
