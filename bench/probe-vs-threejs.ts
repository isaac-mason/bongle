// Our transform compose against three.js's, same machine, same math problem.
//
//   ./node_modules/.bin/tsx bench/probe-vs-threejs.ts
//
// Reads three.js straight out of `llm/three` (sparse clone of src/core + src/math), so this
// is their real Matrix4/Vector3/Quaternion, not a reimplementation.
//
// The two designs differ on three axes, and they picked opposite sides on two of them:
//
//                    three.js                        us
//   local TRS        Vector3 {x,y,z} scalar fields   plain arrays [x,y,z]
//   world matrix     plain array of 16               plain array of 16
//   compose          updateMatrix() builds a local   fused: quat expands straight into the
//                    matrix, then multiplyMatrices   parent multiply, affine shortcut so
//                    does a full 4x4 (64 mults)      only 12 cells and 36 mults
//   traversal        eager top-down sweep            lazy pull with dirty bits
//
// Measured here: the per-node compose only (rig-shaped chain, 1 root per 8), so the
// traversal difference is out of scope.
//
// The math and the storage differences are separated deliberately, because the three.js
// comparison alone cannot tell them apart. `ours-scalar` runs OUR fused math with three's
// storage shape ({x,y,z} fields instead of packed double arrays), so the gap between
// `ours` and `ours-scalar` is the storage question on its own.

// @ts-expect-error - reading the sparse clone directly, no types
import { Matrix4 } from '../../llm/three/src/math/Matrix4.js';
// @ts-expect-error
import { Quaternion } from '../../llm/three/src/math/Quaternion.js';
// @ts-expect-error
import { Vector3 } from '../../llm/three/src/math/Vector3.js';

const STRIDE = 8;

type Ours = { p: number[]; q: number[]; s: number[]; wm: number[] };

function makeOurs(n: number): Ours[] {
    const out: Ours[] = [];
    for (let i = 0; i < n; i++) {
        out.push({
            p: [i * 0.01, 1, 0],
            q: [0.1, 0.2, 0.3, 0.927],
            s: [1, 1, 1],
            wm: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
        });
    }
    return out;
}

/** our math, three's storage shape: scalar fields rather than packed double arrays. */
type Scalar = {
    px: number; py: number; pz: number;
    qx: number; qy: number; qz: number; qw: number;
    sx: number; sy: number; sz: number;
    wm: number[];
};

function makeScalar(n: number): Scalar[] {
    const out: Scalar[] = [];
    for (let i = 0; i < n; i++) {
        out.push({
            px: i * 0.01, py: 1, pz: 0,
            qx: 0.1, qy: 0.2, qz: 0.3, qw: 0.927,
            sx: 1, sy: 1, sz: 1,
            wm: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
        });
    }
    return out;
}

function composeScalar(t: Scalar, parent: Scalar | null): void {
    const qx = t.qx, qy = t.qy, qz = t.qz, qw = t.qw;
    const sx = t.sx, sy = t.sy, sz = t.sz;
    const px = t.px, py = t.py, pz = t.pz;
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const xx = qx * x2, xy = qx * y2, xz = qx * z2;
    const yy = qy * y2, yz = qy * z2, zz = qz * z2;
    const wx = qw * x2, wy = qw * y2, wz = qw * z2;
    const l0 = (1 - (yy + zz)) * sx, l1 = (xy + wz) * sx, l2 = (xz - wy) * sx;
    const l4 = (xy - wz) * sy, l5 = (1 - (xx + zz)) * sy, l6 = (yz + wx) * sy;
    const l8 = (xz + wy) * sz, l9 = (yz - wx) * sz, l10 = (1 - (xx + yy)) * sz;
    const wm = t.wm;
    if (parent === null) {
        wm[0] = l0; wm[1] = l1; wm[2] = l2; wm[3] = 0;
        wm[4] = l4; wm[5] = l5; wm[6] = l6; wm[7] = 0;
        wm[8] = l8; wm[9] = l9; wm[10] = l10; wm[11] = 0;
        wm[12] = px; wm[13] = py; wm[14] = pz; wm[15] = 1;
        return;
    }
    const pm = parent.wm;
    const p00 = pm[0]!, p01 = pm[1]!, p02 = pm[2]!;
    const p10 = pm[4]!, p11 = pm[5]!, p12 = pm[6]!;
    const p20 = pm[8]!, p21 = pm[9]!, p22 = pm[10]!;
    const p30 = pm[12]!, p31 = pm[13]!, p32 = pm[14]!;
    wm[0] = p00*l0 + p10*l1 + p20*l2;  wm[1] = p01*l0 + p11*l1 + p21*l2;  wm[2] = p02*l0 + p12*l1 + p22*l2;  wm[3] = 0;
    wm[4] = p00*l4 + p10*l5 + p20*l6;  wm[5] = p01*l4 + p11*l5 + p21*l6;  wm[6] = p02*l4 + p12*l5 + p22*l6;  wm[7] = 0;
    wm[8] = p00*l8 + p10*l9 + p20*l10; wm[9] = p01*l8 + p11*l9 + p21*l10; wm[10] = p02*l8 + p12*l9 + p22*l10; wm[11] = 0;
    wm[12] = p00*px + p10*py + p20*pz + p30;
    wm[13] = p01*px + p11*py + p21*pz + p31;
    wm[14] = p02*px + p12*py + p22*pz + p32;
    wm[15] = 1;
}

type Three = { position: any; quaternion: any; scale: any; matrix: any; matrixWorld: any };

function makeThree(n: number): Three[] {
    const out: Three[] = [];
    for (let i = 0; i < n; i++) {
        out.push({
            position: new Vector3(i * 0.01, 1, 0),
            quaternion: new Quaternion(0.1, 0.2, 0.3, 0.927),
            scale: new Vector3(1, 1, 1),
            matrix: new Matrix4(),
            matrixWorld: new Matrix4(),
        });
    }
    return out;
}

/** our fused affine compose, lifted verbatim from transform.ts's composeWorldMatrix. */
function composeOurs(t: Ours, parent: Ours | null): void {
    const q = t.q, p = t.p, s = t.s;
    const qx = q[0]!, qy = q[1]!, qz = q[2]!, qw = q[3]!;
    const sx = s[0]!, sy = s[1]!, sz = s[2]!;
    const px = p[0]!, py = p[1]!, pz = p[2]!;
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const xx = qx * x2, xy = qx * y2, xz = qx * z2;
    const yy = qy * y2, yz = qy * z2, zz = qz * z2;
    const wx = qw * x2, wy = qw * y2, wz = qw * z2;
    const l0 = (1 - (yy + zz)) * sx, l1 = (xy + wz) * sx, l2 = (xz - wy) * sx;
    const l4 = (xy - wz) * sy, l5 = (1 - (xx + zz)) * sy, l6 = (yz + wx) * sy;
    const l8 = (xz + wy) * sz, l9 = (yz - wx) * sz, l10 = (1 - (xx + yy)) * sz;
    const wm = t.wm;
    if (parent === null) {
        wm[0] = l0; wm[1] = l1; wm[2] = l2; wm[3] = 0;
        wm[4] = l4; wm[5] = l5; wm[6] = l6; wm[7] = 0;
        wm[8] = l8; wm[9] = l9; wm[10] = l10; wm[11] = 0;
        wm[12] = px; wm[13] = py; wm[14] = pz; wm[15] = 1;
        return;
    }
    const pm = parent.wm;
    const p00 = pm[0]!, p01 = pm[1]!, p02 = pm[2]!;
    const p10 = pm[4]!, p11 = pm[5]!, p12 = pm[6]!;
    const p20 = pm[8]!, p21 = pm[9]!, p22 = pm[10]!;
    const p30 = pm[12]!, p31 = pm[13]!, p32 = pm[14]!;
    wm[0] = p00 * l0 + p10 * l1 + p20 * l2;
    wm[1] = p01 * l0 + p11 * l1 + p21 * l2;
    wm[2] = p02 * l0 + p12 * l1 + p22 * l2;
    wm[3] = 0;
    wm[4] = p00 * l4 + p10 * l5 + p20 * l6;
    wm[5] = p01 * l4 + p11 * l5 + p21 * l6;
    wm[6] = p02 * l4 + p12 * l5 + p22 * l6;
    wm[7] = 0;
    wm[8] = p00 * l8 + p10 * l9 + p20 * l10;
    wm[9] = p01 * l8 + p11 * l9 + p21 * l10;
    wm[10] = p02 * l8 + p12 * l9 + p22 * l10;
    wm[11] = 0;
    wm[12] = p00 * px + p10 * py + p20 * pz + p30;
    wm[13] = p01 * px + p11 * py + p21 * pz + p31;
    wm[14] = p02 * px + p12 * py + p22 * pz + p32;
    wm[15] = 1;
}

/** what three.js's Object3D.updateMatrixWorld does per node. */
function composeThree(t: Three, parent: Three | null): void {
    t.matrix.compose(t.position, t.quaternion, t.scale);
    if (parent === null) t.matrixWorld.copy(t.matrix);
    else t.matrixWorld.multiplyMatrices(parent.matrixWorld, t.matrix);
}

function best(fn: () => void, reps: number): number {
    for (let i = 0; i < 25; i++) fn();
    let b = Infinity;
    for (let r = 0; r < reps; r++) {
        const t0 = process.hrtime.bigint();
        fn();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms < b) b = ms;
    }
    return b;
}

console.log(`\nper-node compose, rig-shaped (1 root per 8). best-of\n`);
console.log(
    `${'N'.padStart(8)} ${'three.js'.padStart(9)} ${'ours'.padStart(9)} ${'ours-scalar'.padStart(12)}   ${'vs three'.padStart(9)} ${'scalar vs array'.padStart(16)}`,
);
for (const n of [512, 2048, 8192, 32000, 128000]) {
    const a = makeThree(n);
    const b = makeOurs(n);
    const c = makeScalar(n);
    const ta = best(() => {
        for (let i = 0; i < a.length; i++) composeThree(a[i]!, i % STRIDE === 0 ? null : a[i - (i % STRIDE)]!);
    }, 80);
    const tb = best(() => {
        for (let i = 0; i < b.length; i++) composeOurs(b[i]!, i % STRIDE === 0 ? null : b[i - (i % STRIDE)]!);
    }, 80);
    const tc = best(() => {
        for (let i = 0; i < c.length; i++) composeScalar(c[i]!, i % STRIDE === 0 ? null : c[i - (i % STRIDE)]!);
    }, 80);
    console.log(
        `${String(n).padStart(8)} ${ta.toFixed(3).padStart(9)} ${tb.toFixed(3).padStart(9)} ${tc.toFixed(3).padStart(12)}   ${(ta / tb).toFixed(2).padStart(8)}x ${(tb / tc).toFixed(2).padStart(15)}x`,
    );
}
