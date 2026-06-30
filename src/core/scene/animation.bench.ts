// ── animation tick microbenchmarks ──────────────────────────────────
//
// run with: pnpm vitest bench src/core/scene/animation.bench.ts
//
// Goal: attribute tickAnimator's ~478ms-self / ~1.6s trace cost
// (Trace-20260526T120429.json) to its sub-loops and quantify which
// optimization hypotheses are real vs imaginary, *without* touching
// production code first.
//
// Each bench isolates one hot loop of tickAnimator with code that mirrors
// the production path (animation.ts). When a bench has an "A/B" pair,
// "_baseline" is the current code shape; the alt is a candidate variant.
//
// Hypotheses:
//   H1  sample+accumulate inner loop dominates the tick body
//        → bench: replace_sample_loop_baseline (current) vs
//                 replace_sample_loop_bucketed (channels pre-sorted by
//                 property, no switch dispatch)
//   H2  per-bone normalize loop (branchy, sqrt+divide) is expensive
//        → bench: normalize_loop_baseline vs normalize_loop_unconditional
//   H3  forward composeWorldMatrix sweep is the long pole at the end of
//        the tick
//        → bench: compose_sweep at varying bone counts
//   H4  subtreeDirty.fill(1, lo, hi) is cheap for any practical range
//        → bench: subtree_fill at sizes 1, 5, 30, 100, 300
//   H5  Map.values() iteration costs more than flat-array iteration
//        → bench: map_values_iter_baseline vs array_iter
//
// What you can read from the results:
//   - Adding the per-bench us-per-iter gives a floor on tickAnimator's
//     body. If that sum ≈ the trace, we know the loops account for it
//     and we can target the largest of them. If it's much less, there's
//     overhead elsewhere we haven't isolated.
//   - Each A/B delta is a direct $-figure win/loss for that refactor.

import { type Quat, quat, type Vec3, vec3 } from 'mathcat';
import { bench, describe } from 'vitest';
import { composeWorldMatrix, TransformTrait } from '../../builtins/transform';
import type { ClipChannel } from '../models/handle';
import { addChild, addTrait, createNode, createSceneGraph } from './nodes';

const LAYER_STRIDE = 13;

// ── fixtures ────────────────────────────────────────────────────────

/** parent-first DFS rig: humanoid-ish, spine + 4 limbs branching off. */
function buildRig(boneCount: number): {
    traits: TransformTrait[];
    subtreeEnd: Int32Array;
} {
    const sg = createSceneGraph();
    const traits: TransformTrait[] = [];
    const root = sg.root;

    const spineLen = Math.max(2, Math.floor(boneCount * 0.3));

    // spine chain
    let cursor = root;
    for (let i = 0; i < spineLen && traits.length < boneCount; i++) {
        const n = createNode({ name: `spine${i}` });
        addChild(cursor, n);
        const t = addTrait(n, TransformTrait, { position: vec3.fromValues(0, 0.1, 0) });
        traits.push(t);
        cursor = n;
    }

    // 4 limbs branching off spine bones, evenly spaced; fill remainder
    let limb = 0;
    while (traits.length < boneCount) {
        const l = limb % 4;
        const spineAnchor = traits[Math.min(traits.length - 1, Math.floor(spineLen * (l / 4)))]!._node;
        let limbCursor = spineAnchor;
        const limbBones = Math.min(8, boneCount - traits.length);
        for (let i = 0; i < limbBones; i++) {
            const n = createNode({ name: `limb${limb}_${i}` });
            addChild(limbCursor, n);
            const t = addTrait(n, TransformTrait, { position: vec3.fromValues(0.05, 0, 0) });
            traits.push(t);
            limbCursor = n;
        }
        limb++;
    }

    // build subtreeEnd via DFS over the constructed nodes
    const nameToIdx = new Map<string, number>();
    for (let i = 0; i < traits.length; i++) nameToIdx.set(traits[i]!._node.name!, i);
    const subtreeEnd = new Int32Array(traits.length);
    function dfs(node: ReturnType<typeof createNode>): number {
        const myName = node.name;
        const myIdx = myName ? nameToIdx.get(myName) : undefined;
        let end = myIdx !== undefined ? myIdx + 1 : 0;
        for (const child of node.children) {
            const childEnd = dfs(child);
            if (childEnd > end) end = childEnd;
        }
        if (myIdx !== undefined) subtreeEnd[myIdx] = end;
        return end;
    }
    dfs(root);

    return { traits, subtreeEnd };
}

/** build N channels with realistic 30-frame LINEAR keyframes, mix of T/R/S. */
function buildChannels(_boneCount: number, channelCount: number, frameCount = 30): ClipChannel[] {
    const channels: ClipChannel[] = [];
    const types: Array<'translation' | 'rotation' | 'scale'> = ['translation', 'rotation', 'scale'];
    for (let c = 0; c < channelCount; c++) {
        const property = types[c % 3]!;
        const stride = property === 'rotation' ? 4 : 3;
        const times = new Float32Array(frameCount);
        const values = new Float32Array(frameCount * stride);
        for (let f = 0; f < frameCount; f++) {
            times[f] = f * 0.0333;
            const o = f * stride;
            if (property === 'rotation') {
                values[o] = 0;
                values[o + 1] = Math.sin(f * 0.1);
                values[o + 2] = 0;
                values[o + 3] = Math.cos(f * 0.1);
            } else {
                values[o] = Math.sin(f * 0.1);
                values[o + 1] = Math.cos(f * 0.1);
                values[o + 2] = 0.5;
            }
        }
        channels.push({
            nodeName: `spine0`, // unused in microbench
            property,
            interpolation: 'LINEAR',
            times,
            values,
        });
    }
    return channels;
}

// ── mirrors of animation.ts hot helpers (kept verbatim) ─────────────

function findKeyLow(times: ArrayLike<number>, kc: number, time: number, last: number): number {
    const lo = last < 0 ? 0 : last >= kc - 1 ? kc - 2 : last;
    if (times[lo]! <= time && time < times[lo + 1]!) return lo;
    if (lo + 2 < kc) {
        if (time < times[lo + 2]! && times[lo + 1]! <= time) return lo + 1;
    }
    if (lo + 3 < kc) {
        if (time < times[lo + 3]! && times[lo + 2]! <= time) return lo + 2;
    }
    if (lo > 0 && times[lo - 1]! <= time && time < times[lo]!) return lo - 1;
    let l = 0;
    let h = kc - 1;
    while (h - l > 1) {
        const mid = (l + h) >> 1;
        if (times[mid]! <= time) l = mid;
        else h = mid;
    }
    return l;
}

const _scratchVec3: Vec3 = vec3.create();
const _scratchQuat: Quat = quat.create();

function sampleVec3(channel: ClipChannel, time: number, out: Vec3, lastIdx: number): number {
    const { times, values } = channel;
    const kc = times.length;
    if (kc === 1 || time <= times[0]!) {
        out[0] = values[0]!;
        out[1] = values[1]!;
        out[2] = values[2]!;
        return 0;
    }
    if (time >= times[kc - 1]!) {
        const o = (kc - 1) * 3;
        out[0] = values[o]!;
        out[1] = values[o + 1]!;
        out[2] = values[o + 2]!;
        return kc - 1;
    }
    const lo = findKeyLow(times, kc, time, lastIdx);
    const hi = lo + 1;
    const t0 = times[lo]!;
    const t1 = times[hi]!;
    const o0 = lo * 3;
    const o1 = hi * 3;
    const alpha = (time - t0) / (t1 - t0);
    const inv = 1 - alpha;
    out[0] = values[o0]! * inv + values[o1]! * alpha;
    out[1] = values[o0 + 1]! * inv + values[o1 + 1]! * alpha;
    out[2] = values[o0 + 2]! * inv + values[o1 + 2]! * alpha;
    return lo;
}

function sampleQuat(channel: ClipChannel, time: number, out: Quat, lastIdx: number): number {
    const { times, values } = channel;
    const kc = times.length;
    if (kc === 1 || time <= times[0]!) {
        out[0] = values[0]!;
        out[1] = values[1]!;
        out[2] = values[2]!;
        out[3] = values[3]!;
        return 0;
    }
    if (time >= times[kc - 1]!) {
        const o = (kc - 1) * 4;
        out[0] = values[o]!;
        out[1] = values[o + 1]!;
        out[2] = values[o + 2]!;
        out[3] = values[o + 3]!;
        return kc - 1;
    }
    const lo = findKeyLow(times, kc, time, lastIdx);
    const hi = lo + 1;
    const t0 = times[lo]!;
    const t1 = times[hi]!;
    const o0 = lo * 4;
    const o1 = hi * 4;
    const ax = values[o0]!,
        ay = values[o0 + 1]!,
        az = values[o0 + 2]!,
        aw = values[o0 + 3]!;
    let bx = values[o1]!,
        by = values[o1 + 1]!,
        bz = values[o1 + 2]!,
        bw = values[o1 + 3]!;
    if (ax * bx + ay * by + az * bz + aw * bw < 0) {
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
    }
    const alpha = (time - t0) / (t1 - t0);
    const inv = 1 - alpha;
    let rx = ax * inv + bx * alpha;
    let ry = ay * inv + by * alpha;
    let rz = az * inv + bz * alpha;
    let rw = aw * inv + bw * alpha;
    const len = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
    if (len > 0) {
        const il = 1 / len;
        rx *= il;
        ry *= il;
        rz *= il;
        rw *= il;
    }
    out[0] = rx;
    out[1] = ry;
    out[2] = rz;
    out[3] = rw;
    return lo;
}

// ── H1: replace-pass sample+accumulate loop ─────────────────────────
//
// Mirrors animation.ts:479-491 + accumulateSampleTA. Walks N channels,
// samples each, accumulates into layerAccum[bone*STRIDE + slot] with
// weighted contribution. This is the canonical hot path during sampling.

const RIG_BONES = 60; // mid-size humanoid
const CHANNELS_PER_ACTION = 180; // ~3 channels per bone × 60 bones
const TIME_SAMPLES = 100;

const channels = buildChannels(RIG_BONES, CHANNELS_PER_ACTION);
const boneIndices = new Int32Array(CHANNELS_PER_ACTION);
for (let c = 0; c < CHANNELS_PER_ACTION; c++) boneIndices[c] = c % RIG_BONES;
const lastKeyIdx = new Int32Array(CHANNELS_PER_ACTION);
const layerAccum = new Float32Array(RIG_BONES * LAYER_STRIDE);

// pre-bucketed channels (H1 variant)
const channelsT = channels.filter((c) => c.property === 'translation');
const channelsR = channels.filter((c) => c.property === 'rotation');
const channelsS = channels.filter((c) => c.property === 'scale');
const boneIndicesT = new Int32Array(channelsT.length);
const boneIndicesR = new Int32Array(channelsR.length);
const boneIndicesS = new Int32Array(channelsS.length);
for (let c = 0; c < channelsT.length; c++) boneIndicesT[c] = c % RIG_BONES;
for (let c = 0; c < channelsR.length; c++) boneIndicesR[c] = c % RIG_BONES;
for (let c = 0; c < channelsS.length; c++) boneIndicesS[c] = c % RIG_BONES;
const lastKeyIdxT = new Int32Array(channelsT.length);
const lastKeyIdxR = new Int32Array(channelsR.length);
const lastKeyIdxS = new Int32Array(channelsS.length);

describe('H1 — replace pass sample+accumulate (60-bone rig, 180 channels)', () => {
    bench('replace_sample_loop_baseline (switch dispatch)', () => {
        layerAccum.fill(0);
        const w = 0.7;
        for (let s = 0; s < TIME_SAMPLES; s++) {
            const time = s * 0.0333;
            for (let c = 0; c < channels.length; c++) {
                const bi = boneIndices[c]!;
                const ch = channels[c]!;
                const o = bi * LAYER_STRIDE;
                switch (ch.property) {
                    case 'translation': {
                        lastKeyIdx[c] = sampleVec3(ch, time, _scratchVec3, lastKeyIdx[c]!);
                        layerAccum[o] += _scratchVec3[0]! * w;
                        layerAccum[o + 1] += _scratchVec3[1]! * w;
                        layerAccum[o + 2] += _scratchVec3[2]! * w;
                        layerAccum[o + 3] += w;
                        break;
                    }
                    case 'rotation': {
                        lastKeyIdx[c] = sampleQuat(ch, time, _scratchQuat, lastKeyIdx[c]!);
                        const total = layerAccum[o + 8]!;
                        if (total > 0) {
                            const dot =
                                layerAccum[o + 4]! * _scratchQuat[0]! +
                                layerAccum[o + 5]! * _scratchQuat[1]! +
                                layerAccum[o + 6]! * _scratchQuat[2]! +
                                layerAccum[o + 7]! * _scratchQuat[3]!;
                            if (dot < 0) {
                                _scratchQuat[0] = -_scratchQuat[0];
                                _scratchQuat[1] = -_scratchQuat[1];
                                _scratchQuat[2] = -_scratchQuat[2];
                                _scratchQuat[3] = -_scratchQuat[3];
                            }
                        }
                        layerAccum[o + 4] += _scratchQuat[0]! * w;
                        layerAccum[o + 5] += _scratchQuat[1]! * w;
                        layerAccum[o + 6] += _scratchQuat[2]! * w;
                        layerAccum[o + 7] += _scratchQuat[3]! * w;
                        layerAccum[o + 8] += w;
                        break;
                    }
                    case 'scale': {
                        lastKeyIdx[c] = sampleVec3(ch, time, _scratchVec3, lastKeyIdx[c]!);
                        layerAccum[o + 9] += _scratchVec3[0]! * w;
                        layerAccum[o + 10] += _scratchVec3[1]! * w;
                        layerAccum[o + 11] += _scratchVec3[2]! * w;
                        layerAccum[o + 12] += w;
                        break;
                    }
                }
            }
        }
    });

    bench('replace_sample_loop_bucketed (no switch, 3 specialized loops)', () => {
        layerAccum.fill(0);
        const w = 0.7;
        for (let s = 0; s < TIME_SAMPLES; s++) {
            const time = s * 0.0333;
            // translation
            for (let c = 0; c < channelsT.length; c++) {
                const bi = boneIndicesT[c]!;
                const o = bi * LAYER_STRIDE;
                lastKeyIdxT[c] = sampleVec3(channelsT[c]!, time, _scratchVec3, lastKeyIdxT[c]!);
                layerAccum[o] += _scratchVec3[0]! * w;
                layerAccum[o + 1] += _scratchVec3[1]! * w;
                layerAccum[o + 2] += _scratchVec3[2]! * w;
                layerAccum[o + 3] += w;
            }
            // rotation
            for (let c = 0; c < channelsR.length; c++) {
                const bi = boneIndicesR[c]!;
                const o = bi * LAYER_STRIDE;
                lastKeyIdxR[c] = sampleQuat(channelsR[c]!, time, _scratchQuat, lastKeyIdxR[c]!);
                const total = layerAccum[o + 8]!;
                if (total > 0) {
                    const dot =
                        layerAccum[o + 4]! * _scratchQuat[0]! +
                        layerAccum[o + 5]! * _scratchQuat[1]! +
                        layerAccum[o + 6]! * _scratchQuat[2]! +
                        layerAccum[o + 7]! * _scratchQuat[3]!;
                    if (dot < 0) {
                        _scratchQuat[0] = -_scratchQuat[0];
                        _scratchQuat[1] = -_scratchQuat[1];
                        _scratchQuat[2] = -_scratchQuat[2];
                        _scratchQuat[3] = -_scratchQuat[3];
                    }
                }
                layerAccum[o + 4] += _scratchQuat[0]! * w;
                layerAccum[o + 5] += _scratchQuat[1]! * w;
                layerAccum[o + 6] += _scratchQuat[2]! * w;
                layerAccum[o + 7] += _scratchQuat[3]! * w;
                layerAccum[o + 8] += w;
            }
            // scale
            for (let c = 0; c < channelsS.length; c++) {
                const bi = boneIndicesS[c]!;
                const o = bi * LAYER_STRIDE;
                lastKeyIdxS[c] = sampleVec3(channelsS[c]!, time, _scratchVec3, lastKeyIdxS[c]!);
                layerAccum[o + 9] += _scratchVec3[0]! * w;
                layerAccum[o + 10] += _scratchVec3[1]! * w;
                layerAccum[o + 11] += _scratchVec3[2]! * w;
                layerAccum[o + 12] += w;
            }
        }
    });
});

// ── H2: per-bone normalize loop ─────────────────────────────────────
//
// Mirrors animation.ts:497-537. Reads layerAccum, normalizes weighted sums
// into bonePos/Quat/Scale on the trait. Three independent branches gated
// on (posW, quatTotal, scaleW); a sqrt + divide per active bone.

const normRig = buildRig(RIG_BONES);
const bonePosArr: Vec3[] = normRig.traits.map((t) => t.position);
const boneQuatArr: Quat[] = normRig.traits.map((t) => t.quaternion);
const boneScaleArr: Vec3[] = normRig.traits.map((t) => t.scale);
const NORMALIZE_ITERS = 1000;

// pre-fill layerAccum so all branches fire (worst case)
function seedAccum(): void {
    for (let bi = 0; bi < RIG_BONES; bi++) {
        const o = bi * LAYER_STRIDE;
        layerAccum[o] = 1.0;
        layerAccum[o + 1] = 2.0;
        layerAccum[o + 2] = 3.0;
        layerAccum[o + 3] = 1.0; // posW
        layerAccum[o + 4] = 0.0;
        layerAccum[o + 5] = 0.5;
        layerAccum[o + 6] = 0.0;
        layerAccum[o + 7] = 0.866;
        layerAccum[o + 8] = 1.0; // quatTotal
        layerAccum[o + 9] = 1.0;
        layerAccum[o + 10] = 1.0;
        layerAccum[o + 11] = 1.0;
        layerAccum[o + 12] = 1.0; // scaleW
    }
}

describe('H2 — per-bone normalize loop (60-bone rig, all 3 channels active)', () => {
    bench('normalize_loop_baseline', () => {
        seedAccum();
        for (let iter = 0; iter < NORMALIZE_ITERS; iter++) {
            for (let bi = 0; bi < RIG_BONES; bi++) {
                const lo = bi * LAYER_STRIDE;
                const posW = layerAccum[lo + 3]!;
                const quatTotal = layerAccum[lo + 8]!;
                const scaleW = layerAccum[lo + 12]!;
                if (posW === 0 && quatTotal === 0 && scaleW === 0) continue;

                if (posW > 0) {
                    const inv = 1 / posW;
                    const p = bonePosArr[bi]!;
                    p[0] = layerAccum[lo]! * inv;
                    p[1] = layerAccum[lo + 1]! * inv;
                    p[2] = layerAccum[lo + 2]! * inv;
                }
                if (quatTotal > 0) {
                    const qx = layerAccum[lo + 4]!;
                    const qy = layerAccum[lo + 5]!;
                    const qz = layerAccum[lo + 6]!;
                    const qw = layerAccum[lo + 7]!;
                    const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
                    if (len > 0) {
                        const il = 1 / len;
                        const q = boneQuatArr[bi]!;
                        q[0] = qx * il;
                        q[1] = qy * il;
                        q[2] = qz * il;
                        q[3] = qw * il;
                    }
                }
                if (scaleW > 0) {
                    const inv = 1 / scaleW;
                    const s = boneScaleArr[bi]!;
                    s[0] = layerAccum[lo + 9]! * inv;
                    s[1] = layerAccum[lo + 10]! * inv;
                    s[2] = layerAccum[lo + 11]! * inv;
                }
            }
        }
    });

    // assumes "all three active", measures the floor if branches all hit
    bench('normalize_loop_unconditional (drops the 3 branches)', () => {
        seedAccum();
        for (let iter = 0; iter < NORMALIZE_ITERS; iter++) {
            for (let bi = 0; bi < RIG_BONES; bi++) {
                const lo = bi * LAYER_STRIDE;
                const invP = 1 / layerAccum[lo + 3]!;
                const p = bonePosArr[bi]!;
                p[0] = layerAccum[lo]! * invP;
                p[1] = layerAccum[lo + 1]! * invP;
                p[2] = layerAccum[lo + 2]! * invP;

                const qx = layerAccum[lo + 4]!;
                const qy = layerAccum[lo + 5]!;
                const qz = layerAccum[lo + 6]!;
                const qw = layerAccum[lo + 7]!;
                const il = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
                const q = boneQuatArr[bi]!;
                q[0] = qx * il;
                q[1] = qy * il;
                q[2] = qz * il;
                q[3] = qw * il;

                const invS = 1 / layerAccum[lo + 12]!;
                const s = boneScaleArr[bi]!;
                s[0] = layerAccum[lo + 9]! * invS;
                s[1] = layerAccum[lo + 10]! * invS;
                s[2] = layerAccum[lo + 11]! * invS;
            }
        }
    });
});

// ── H3: forward composeWorldMatrix sweep ────────────────────────────
//
// Mirrors animation.ts:583-601. Walks boneOrder parent-first, calls
// composeWorldMatrix on each. This is what charges to composeWorldMatrix
// self (115ms in trace) and to tickAnimator self for the loop body.

describe('H3 — compose forward sweep', () => {
    for (const N of [20, 60, 120, 240]) {
        const rig = buildRig(N);
        // dirty every bone so the compose actually runs
        for (const t of rig.traits) (t as any)._dirty = 0xff;
        bench(`compose_sweep N=${N}`, () => {
            // mark dirty in-loop so each iter rebuilds from scratch
            for (const t of rig.traits) (t as any)._dirty = 0xff;
            for (let bi = 0; bi < rig.traits.length; bi++) {
                const t = rig.traits[bi]!;
                composeWorldMatrix(t);
            }
        });
    }
});

// ── H4: subtreeDirty.fill range scaling ─────────────────────────────
//
// Mirrors animation.ts:506,781,829,843, subtreeDirty.fill(1, lo, hi) for
// the bone-and-descendants cascade. Question: is .fill() cheap for the
// small ranges typical of leaf bones, or does the function-call overhead
// dominate?

const FILL_BUF = new Uint8Array(1024);
const FILL_ITERS = 100_000;

describe('H4 — subtreeDirty.fill scaling', () => {
    for (const range of [1, 5, 30, 100, 300]) {
        bench(`subtree_fill range=${range}`, () => {
            for (let i = 0; i < FILL_ITERS; i++) {
                FILL_BUF.fill(1, 0, range);
            }
        });
    }

    // baseline: scalar loop, for comparison at very small ranges
    bench('subtree_fill_scalar range=5', () => {
        for (let i = 0; i < FILL_ITERS; i++) {
            for (let k = 0; k < 5; k++) FILL_BUF[k] = 1;
        }
    });
});

// ── H5: Map.values vs flat array iteration ──────────────────────────
//
// tickAnimator iterates `state.actions.values()` up to 3× per tick
// (crossfade pass, replace pass, additive pass). Each pass is a tight
// outer loop. Question: does Map's iterator add overhead worth tackling?

type FakeAction = { weight: number; layer: number; enabled: boolean; counter: number };
const ACTION_COUNT = 6;
const MAP_ITERS = 100_000;

const actionsMap = new Map<symbol, FakeAction>();
const actionsArr: FakeAction[] = [];
for (let i = 0; i < ACTION_COUNT; i++) {
    const a: FakeAction = { weight: 0.5, layer: i % 2, enabled: true, counter: 0 };
    actionsMap.set(Symbol(), a);
    actionsArr.push(a);
}

describe('H5 — actions iteration', () => {
    bench('map_values_iter_baseline', () => {
        for (let i = 0; i < MAP_ITERS; i++) {
            for (const a of actionsMap.values()) {
                if (!a.enabled) continue;
                a.counter += 1;
            }
        }
    });

    bench('array_iter', () => {
        for (let i = 0; i < MAP_ITERS; i++) {
            for (let k = 0; k < actionsArr.length; k++) {
                const a = actionsArr[k]!;
                if (!a.enabled) continue;
                a.counter += 1;
            }
        }
    });
});

// ── coverage check ─────────────────────────────────────────────────
// keep these references live so esbuild doesn't tree-shake the fixtures.
void normRig.subtreeEnd;
