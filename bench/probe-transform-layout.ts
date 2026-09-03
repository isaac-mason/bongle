// Is the transform compose memory-bound on how its floats are laid out?
//
//   ./node_modules/.bin/tsx bench/probe-transform-layout.ts
//
// `probe-rig-frame.ts` shows world-matrix recompute going super-linear: 0.66 us/rig at 64
// rigs, 2.17 us/rig at 4000, with no change in walk depth. The suspect is layout, not
// algorithm. A TransformTrait allocates SEVEN separate Float32Arrays (position, quaternion,
// scale, worldPosition, worldQuaternion, worldScale, worldMatrix) holding 36 floats, i.e.
// 144 bytes of data spread over seven heap objects with their own headers and backing
// stores. `probe-transform-size.ts` puts the whole instance at ~1235 B.
//
// The engine's `Vec3`/`Quat`/`Mat4` are PLAIN arrays (`vec3.create()` returns `[0,0,0]`),
// not typed arrays, and the whole math API is monomorphic on PACKED_DOUBLE_ELEMENTS. So the
// question is not "typed vs plain" (mixing would deopt every math call site) but whether
// the SEPARATION into seven heap objects costs anything:
//
//   separate   seven plain arrays per transform (what we have)
//   packed     one plain array of 36 doubles per transform, accessed by offset
//
// If `packed` pulls away as N grows, locality is the lever and the question becomes what
// an offset-based layout would cost at the call sites. If they track, layout is not the
// problem and the super-linearity is something else.

const STRIDE = 36;
const P = 0, Q = 3, S = 7, WM = 10; // offsets within a 36-double record

type Sep = { position: number[]; quaternion: number[]; scale: number[]; worldMatrix: number[] };

function makeSeparate(n: number): Sep[] {
    const out: Sep[] = [];
    for (let i = 0; i < n; i++) {
        out.push({
            position: [0, 0, 0],
            quaternion: [0, 0, 0, 1],
            scale: [1, 1, 1],
            worldMatrix: [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
        });
    }
    return out;
}

/** one plain array of 36 doubles per transform; fields live at fixed offsets. */
function makePacked(n: number): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < n; i++) {
        const a = new Array<number>(STRIDE).fill(0);
        a[Q + 3] = 1;
        a[S] = a[S + 1] = a[S + 2] = 1;
        out.push(a);
    }
    return out;
}

function composeSep(t: Sep, parent: number[] | null): void {
    write(t.quaternion, 0, t.position, 0, t.scale, 0, t.worldMatrix, 0, parent, 0);
}

function composePacked(a: number[], parent: number[] | null, parentOff: number): void {
    write(a, Q, a, P, a, S, a, WM, parent, parentOff);
}

/** the affine compose transform.ts hand-inlines, parameterised by base offsets. */
function write(
    qa: number[], qo: number,
    pa: number[], po: number,
    sa: number[], so: number,
    oa: number[], oo: number,
    parent: number[] | null, wo: number,
): void {
    const x = qa[qo]!, y = qa[qo + 1]!, z = qa[qo + 2]!, w = qa[qo + 3]!;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = sa[so]!, sy = sa[so + 1]!, sz = sa[so + 2]!;
    const m0 = (1 - (yy + zz)) * sx, m1 = (xy + wz) * sx, m2 = (xz - wy) * sx;
    const m4 = (xy - wz) * sy, m5 = (1 - (xx + zz)) * sy, m6 = (yz + wx) * sy;
    const m8 = (xz + wy) * sz, m9 = (yz - wx) * sz, m10 = (1 - (xx + yy)) * sz;
    const px = pa[po]!, py = pa[po + 1]!, pz = pa[po + 2]!;
    if (parent === null) {
        oa[oo] = m0; oa[oo+1] = m1; oa[oo+2] = m2; oa[oo+3] = 0;
        oa[oo+4] = m4; oa[oo+5] = m5; oa[oo+6] = m6; oa[oo+7] = 0;
        oa[oo+8] = m8; oa[oo+9] = m9; oa[oo+10] = m10; oa[oo+11] = 0;
        oa[oo+12] = px; oa[oo+13] = py; oa[oo+14] = pz; oa[oo+15] = 1;
        return;
    }
    const a0 = parent[wo]!, a1 = parent[wo+1]!, a2 = parent[wo+2]!;
    const a4 = parent[wo+4]!, a5 = parent[wo+5]!, a6 = parent[wo+6]!;
    const a8 = parent[wo+8]!, a9 = parent[wo+9]!, a10 = parent[wo+10]!;
    const a12 = parent[wo+12]!, a13 = parent[wo+13]!, a14 = parent[wo+14]!;
    oa[oo] = a0*m0 + a4*m1 + a8*m2;
    oa[oo+1] = a1*m0 + a5*m1 + a9*m2;
    oa[oo+2] = a2*m0 + a6*m1 + a10*m2;
    oa[oo+3] = 0;
    oa[oo+4] = a0*m4 + a4*m5 + a8*m6;
    oa[oo+5] = a1*m4 + a5*m5 + a9*m6;
    oa[oo+6] = a2*m4 + a6*m5 + a10*m6;
    oa[oo+7] = 0;
    oa[oo+8] = a0*m8 + a4*m9 + a8*m10;
    oa[oo+9] = a1*m8 + a5*m9 + a9*m10;
    oa[oo+10] = a2*m8 + a6*m9 + a10*m10;
    oa[oo+11] = 0;
    oa[oo+12] = a0*px + a4*py + a8*pz + a12;
    oa[oo+13] = a1*px + a5*py + a9*pz + a13;
    oa[oo+14] = a2*px + a6*py + a10*pz + a14;
    oa[oo+15] = 1;
}

function composeAllSep(set: Sep[]): void {
    for (let i = 0; i < set.length; i++) {
        const isRoot = i % 8 === 0;
        composeSep(set[i]!, isRoot ? null : set[i - (i % 8)]!.worldMatrix);
    }
}

function composeAllPacked(set: number[][]): void {
    for (let i = 0; i < set.length; i++) {
        const isRoot = i % 8 === 0;
        composePacked(set[i]!, isRoot ? null : set[i - (i % 8)]!, WM);
    }
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

console.log(`\ncompose over N transforms, rig-shaped (1 root per 8), plain arrays. best-of\n`);
console.log(`${'N'.padStart(7)} ${'kB doubles'.padStart(11)} ${'separate'.padStart(9)} ${'packed'.padStart(9)}   ratio`);
for (const n of [512, 2048, 8192, 32000, 128000]) {
    const a = makeSeparate(n);
    const b = makePacked(n);
    const ta = best(() => composeAllSep(a), 100);
    const tb = best(() => composeAllPacked(b), 100);
    console.log(
        `${String(n).padStart(7)} ${((n * STRIDE * 8) / 1024).toFixed(0).padStart(11)} ${ta.toFixed(3).padStart(9)} ${tb.toFixed(3).padStart(9)}   ${(ta / tb).toFixed(2)}x`,
    );
}
