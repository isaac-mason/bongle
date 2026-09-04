// Is godot's identity-local fast path worth having?
//
//   ./node_modules/.bin/tsx bench/probe-identity-compose.ts
//
// `Node3D::data.fti_is_identity_xform` lets the concatenation skip the matrix multiply
// and copy the parent global straight through:
//
//   global_transform_interpolated = fti_is_identity_xform ? parent_glob : parent_glob * local_interp;
//
// Godot flags it as unverified in its own source ("ToDo: Double check this is a win"),
// so this measures the ceiling before we build the flag maintenance it needs.
//
// The saving is only the 36 multiplies. Both paths still write 16 floats, so an identity
// node is not free, just cheaper. The cost is a bit test on every node plus keeping the
// flag current on every local write. This reports the compose-only delta at several
// identity fractions; multiply by the real fraction in a rig to get the frame ceiling.

const N = 20000;
const REPS = 200;

type Xf = { m: Float64Array; identity: boolean };

function makeNodes(identityFraction: number): Xf[] {
    const out: Xf[] = [];
    for (let i = 0; i < N; i++) {
        const m = new Float64Array(16);
        // affine, non-degenerate
        m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
        m[12] = i * 0.01; m[13] = 1.5; m[14] = -i * 0.02;
        out.push({ m, identity: i / N < identityFraction });
    }
    return out;
}

const parent = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1]);
const dst = new Float64Array(16);

/** the fused affine compose, same shape as composeInterpolatedWorldMatrix's nested branch */
function compose(pm: Float64Array, l: Float64Array, out: Float64Array): void {
    const p00 = pm[0]!, p01 = pm[1]!, p02 = pm[2]!;
    const p10 = pm[4]!, p11 = pm[5]!, p12 = pm[6]!;
    const p20 = pm[8]!, p21 = pm[9]!, p22 = pm[10]!;
    const p30 = pm[12]!, p31 = pm[13]!, p32 = pm[14]!;
    const l0 = l[0]!, l1 = l[1]!, l2 = l[2]!;
    const l4 = l[4]!, l5 = l[5]!, l6 = l[6]!;
    const l8 = l[8]!, l9 = l[9]!, l10 = l[10]!;
    const px = l[12]!, py = l[13]!, pz = l[14]!;
    out[0] = p00 * l0 + p10 * l1 + p20 * l2;
    out[1] = p01 * l0 + p11 * l1 + p21 * l2;
    out[2] = p02 * l0 + p12 * l1 + p22 * l2;
    out[3] = 0;
    out[4] = p00 * l4 + p10 * l5 + p20 * l6;
    out[5] = p01 * l4 + p11 * l5 + p21 * l6;
    out[6] = p02 * l4 + p12 * l5 + p22 * l6;
    out[7] = 0;
    out[8] = p00 * l8 + p10 * l9 + p20 * l10;
    out[9] = p01 * l8 + p11 * l9 + p21 * l10;
    out[10] = p02 * l8 + p12 * l9 + p22 * l10;
    out[11] = 0;
    out[12] = p00 * px + p10 * py + p20 * pz + p30;
    out[13] = p01 * px + p11 * py + p21 * pz + p31;
    out[14] = p02 * px + p12 * py + p22 * pz + p32;
    out[15] = 1;
}

/** local is identity rotation + unit scale, non-zero translation: the parent's 3x3 passes
 *  through and only the translation column needs composing. 9 multiplies, not 36. */
function composeTranslationOnly(pm: Float64Array, l: Float64Array, out: Float64Array): void {
    const p00 = pm[0]!, p01 = pm[1]!, p02 = pm[2]!;
    const p10 = pm[4]!, p11 = pm[5]!, p12 = pm[6]!;
    const p20 = pm[8]!, p21 = pm[9]!, p22 = pm[10]!;
    const px = l[12]!, py = l[13]!, pz = l[14]!;
    out[0] = p00; out[1] = p01; out[2] = p02; out[3] = 0;
    out[4] = p10; out[5] = p11; out[6] = p12; out[7] = 0;
    out[8] = p20; out[9] = p21; out[10] = p22; out[11] = 0;
    out[12] = p00 * px + p10 * py + p20 * pz + pm[12]!;
    out[13] = p01 * px + p11 * py + p21 * pz + pm[13]!;
    out[14] = p02 * px + p12 * py + p22 * pz + pm[14]!;
    out[15] = 1;
}

function copy16(pm: Float64Array, out: Float64Array): void {
    out[0] = pm[0]!; out[1] = pm[1]!; out[2] = pm[2]!; out[3] = pm[3]!;
    out[4] = pm[4]!; out[5] = pm[5]!; out[6] = pm[6]!; out[7] = pm[7]!;
    out[8] = pm[8]!; out[9] = pm[9]!; out[10] = pm[10]!; out[11] = pm[11]!;
    out[12] = pm[12]!; out[13] = pm[13]!; out[14] = pm[14]!; out[15] = pm[15]!;
}

function best(fn: () => void, reps: number): number {
    for (let i = 0; i < 20; i++) fn();
    let b = Infinity;
    for (let r = 0; r < reps; r++) {
        const t0 = process.hrtime.bigint();
        fn();
        const ns = Number(process.hrtime.bigint() - t0);
        if (ns < b) b = ns;
    }
    return b;
}

console.log(`\n${N} composes per pass. "skip" copies the parent matrix for identity locals.\n`);
console.log(`${'fast%'.padStart(6)} ${'always ns'.padStart(10)} ${'identity'.padStart(9)} ${'saving'.padStart(7)} ${'transOnly'.padStart(10)} ${'saving'.padStart(7)}`);

for (const frac of [0, 0.25, 0.5, 0.67, 1]) {
    const nodes = makeNodes(frac);
    const always = best(() => {
        for (let i = 0; i < nodes.length; i++) compose(parent, nodes[i]!.m, dst);
    }, REPS);
    const idSkip = best(() => {
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i]!;
            if (n.identity) copy16(parent, dst);
            else compose(parent, n.m, dst);
        }
    }, REPS);
    const tOnly = best(() => {
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i]!;
            if (n.identity) composeTranslationOnly(parent, n.m, dst);
            else compose(parent, n.m, dst);
        }
    }, REPS);
    const pct = (v: number) => (((always - v) / always) * 100).toFixed(1).padStart(6);
    console.log(
        `${(frac * 100).toFixed(0).padStart(6)} ${(always / N).toFixed(2).padStart(10)} ${(idSkip / N).toFixed(2).padStart(9)} ${pct(idSkip)}% ${(tOnly / N).toFixed(2).padStart(10)} ${pct(tOnly)}%`,
    );
}
console.log('\nReal avatars measure 0% identity, 100% translation-only at rest.');
console.log('At runtime the animated bones gain rotation; mesh nodes stay translation-only.\n');
