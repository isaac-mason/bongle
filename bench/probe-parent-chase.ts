// Does deriving the parent transform cost more at scale than storing it?
//
//   ./node_modules/.bin/tsx bench/probe-parent-chase.ts
//
// `probe-transform-layout.ts` shows the compose math is flat in N (~47 ns/node at both 512
// and 128k). But `probe-rig-frame.ts` shows the world phase going 82 -> 271 ns/node over
// that range. So the machinery around the math is what scales, and the biggest piece is how
// the parent is found.
//
//   stored    transform.parent is a direct reference (what `_parent` was before this
//             session deleted it): one load.
//   derived   transform -> _node -> node.parent -> parent._traits[slot] -> transform
//             (what `parentTransform` does now): four dependent loads across three
//             object graphs, each allocated separately.
//
// `probe-world-read.ts` measured derived at 1.07-1.09x on the real 1088-transform scene,
// where everything is cache-resident. The question is whether that holds at rig counts.

const SLOT = 7;
const STRIDE = 8; // rig-shaped: 1 root per 8

type Node_ = { parent: Node_ | null; traits: Array<Xf | undefined> };
type Xf = { node: Node_; parent: Xf | null; q: number[]; p: number[]; s: number[]; wm: number[] };

function build(n: number): Xf[] {
    const out: Xf[] = [];
    for (let i = 0; i < n; i++) {
        const node: Node_ = { parent: null, traits: [] };
        const xf: Xf = {
            node,
            parent: null,
            q: [0, 0, 0, 1],
            s: [1, 1, 1],
            p: [0, 0, 0],
            wm: [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
        };
        node.traits[SLOT] = xf;
        out.push(xf);
    }
    // wire the rig shape: every 8th is a root, the rest hang off it
    for (let i = 0; i < n; i++) {
        if (i % STRIDE === 0) continue;
        const root = out[i - (i % STRIDE)]!;
        out[i]!.node.parent = root.node;
        out[i]!.parent = root;
    }
    return out;
}

/** the walk `parentTransform` does: up the node chain to the nearest bearer. */
function derivedParent(t: Xf): Xf | null {
    for (let cur = t.node.parent; cur !== null; cur = cur.parent) {
        const found = cur.traits[SLOT];
        if (found !== undefined) return found;
    }
    return null;
}

function compose(t: Xf, parent: Xf | null): void {
    const q = t.q, p = t.p, s = t.s, o = t.wm;
    const x = q[0]!, y = q[1]!, z = q[2]!, w = q[3]!;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = s[0]!, sy = s[1]!, sz = s[2]!;
    const m0 = (1 - (yy + zz)) * sx, m1 = (xy + wz) * sx, m2 = (xz - wy) * sx;
    const m4 = (xy - wz) * sy, m5 = (1 - (xx + zz)) * sy, m6 = (yz + wx) * sy;
    const m8 = (xz + wy) * sz, m9 = (yz - wx) * sz, m10 = (1 - (xx + yy)) * sz;
    const px = p[0]!, py = p[1]!, pz = p[2]!;
    if (parent === null) {
        o[0] = m0; o[1] = m1; o[2] = m2; o[3] = 0;
        o[4] = m4; o[5] = m5; o[6] = m6; o[7] = 0;
        o[8] = m8; o[9] = m9; o[10] = m10; o[11] = 0;
        o[12] = px; o[13] = py; o[14] = pz; o[15] = 1;
        return;
    }
    const a = parent.wm;
    const a0 = a[0]!, a1 = a[1]!, a2 = a[2]!;
    const a4 = a[4]!, a5 = a[5]!, a6 = a[6]!;
    const a8 = a[8]!, a9 = a[9]!, a10 = a[10]!;
    o[0] = a0*m0 + a4*m1 + a8*m2;  o[1] = a1*m0 + a5*m1 + a9*m2;  o[2] = a2*m0 + a6*m1 + a10*m2;  o[3] = 0;
    o[4] = a0*m4 + a4*m5 + a8*m6;  o[5] = a1*m4 + a5*m5 + a9*m6;  o[6] = a2*m4 + a6*m5 + a10*m6;  o[7] = 0;
    o[8] = a0*m8 + a4*m9 + a8*m10; o[9] = a1*m8 + a5*m9 + a9*m10; o[10] = a2*m8 + a6*m9 + a10*m10; o[11] = 0;
    o[12] = a0*px + a4*py + a8*pz + a[12]!;
    o[13] = a1*px + a5*py + a9*pz + a[13]!;
    o[14] = a2*px + a6*py + a10*pz + a[14]!;
    o[15] = 1;
}

function best(fn: () => void, reps: number): number {
    for (let i = 0; i < 20; i++) fn();
    let b = Infinity;
    for (let r = 0; r < reps; r++) {
        const t0 = process.hrtime.bigint();
        fn();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms < b) b = ms;
    }
    return b;
}

console.log(`\ncompose over N transforms, rig-shaped. best-of\n`);
console.log(`${'N'.padStart(8)} ${'stored'.padStart(9)} ${'derived'.padStart(9)}   ratio  ${'ns/node stored'.padStart(15)} ${'derived'.padStart(9)}`);
for (const n of [512, 2048, 8192, 32000, 128000]) {
    const set = build(n);
    const stored = best(() => {
        for (let i = 0; i < set.length; i++) compose(set[i]!, set[i]!.parent);
    }, 100);
    const derived = best(() => {
        for (let i = 0; i < set.length; i++) compose(set[i]!, derivedParent(set[i]!));
    }, 100);
    console.log(
        `${String(n).padStart(8)} ${stored.toFixed(3).padStart(9)} ${derived.toFixed(3).padStart(9)}   ${(derived / stored).toFixed(2)}x  ${((stored / n) * 1e6).toFixed(0).padStart(15)} ${((derived / n) * 1e6).toFixed(0).padStart(9)}`,
    );
}
