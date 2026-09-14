// ── voxel material ──────────────────────────────────────────────────
//
// unified quad-pull material for the chunk renderer. one factory with
// three pass variants:
//
//   opaque, backface culled, depth write, no discard
//   transparent, backface culled, depth write, alpha-cutout discard
//   translucent, no cull, no depth write, alpha blending, drawn in the
//                  back-to-front order the global stable radix sort produces
//
// all three share the same VS that pulls per-quad headers from the
// shared `quads` storage buffer, per-corner lighting from the parallel
// `light` stream, and chunk origin / arena base from a per-pass
// `chunkInfo[slot]` (small 16B side-table). per-instance lookup is via
// `visibleQuads[instanceIndex] = {slot, localIdx}`; realQuadId is
// computed as `chunkInfo[slot].arenaBase + localIdx`.
//
// quad header layout (9 u32 / 36 B, matches chunk-mesher.ts):
//   u32[0]   x0 | y0<<8 | z0<<16 | x1<<24
//   u32[1]   y1 | z1<<8 | x2<<16 | y2<<24
//   u32[2]   z2 | x3<<8 | y3<<16 | z3<<24
//   u32[3]   oct16 normal (low 16 bits) | source-block local: x(4b)<<16 |
//            y(4b)<<20 | z(4b)<<24 | stackOffset(4b)<<28 (v2 reserved)
//   u32[4]   uvPacked for corner 0  (u16 u | u16 v << 16)
//   u32[5]   uvPacked for corner 1
//   u32[6]   uvPacked for corner 2
//   u32[7]   uvPacked for corner 3
//   u32[8]   flags: texIndex(16) | animType(4) | facing(3) | emissive(1) | unshaded(1) | reserved(7)
//            (bit 23 was diagFlip; now lives in the meta word bit 16,
//            Sodium hierarchical compare, see chunk-mesher.applyDiagFlipBit)
//   u32[9]   meta:  aoPacked(16) | reserved(16)
//            aoPacked = ao0Bits | (ao1Bits<<4) | (ao2Bits<<8) | (ao3Bits<<12),
//            each aoNBits ∈ [0..15] encoding brightness via round((b-0.5)*30);
//            VS recovers brightness as bits/30 + 0.5 (range [0.5, 1.0]).
//
// per-corner positions are u8 at 1/16-voxel precision in chunk-local
// space; the section's `origin` (world-space) adds the chunk offset.
//
// lighting model, per-corner packed u32 encodes 4 channels:
//   R | (G<<8) | (B<<16) | (sky<<24). each channel is a raw 4-bit value
//   (0..15) in the low nibble of its byte; the shader divides by 15 and
//   applies the brightness curve `(-0.5*x + 1.5)*x*x` (minetest-style,
//   formerly CPU-side LIGHT_LUT). sky-brightness derives from the per-room
//   `EnvConfig` storage buffer, bound by name `'env'`.
//   AO lives in the top byte of `flags` as a 2-bit raw level per corner;
//   the shader maps it through AO_FACTORS (0.5/0.7/0.85/1.0) and
//   multiplies smooth-light by that factor. AO and per-corner light are
//   both baked by meshChunk in a single pass.

import {
    abs,
    add,
    cameraProjectionMatrix,
    cameraViewMatrix,
    clamp,
    cos,
    Discard,
    d,
    dot,
    dpdx,
    dpdy,
    equal,
    Fn,
    f32,
    floor,
    fract,
    If,
    i32,
    index,
    instanceIndex,
    length,
    log2,
    Material,
    max,
    min,
    mix,
    mul,
    type Node,
    select,
    sin,
    smoothstep,
    sqrt,
    storage,
    sub,
    texture,
    u32,
    Var,
    varying,
    vec2f,
    vec3f,
    vec4,
    vec4f,
    vertexIndex,
} from 'gpucat';
import { FLAGS_OFFSET, META_OFFSET, QUAD_META_DIAG_FLIP_BIT, QUAD_STRIDE_U32S } from '../../core/voxels/chunk-mesher';
import { ditherDiscard } from '../dsl/dither';
import type { EnvironmentResources } from '../environment/environment';
import { applyFog, fogDistance } from '../environment/fog';
import { ChunkInfo, VisibleQuad } from './voxel-arena';
import { bindLightVolume, brightnessCurve, combineVoxelLight, lightAtFaceCorner } from './voxel-light-sample';
import { ATLAS_MIP_LEVELS, type VoxelTextures } from './voxel-textures';

// ── env constants ───────────────────────────────────────────────────

const AMBIENT_MINIMUM: [number, number, number] = [0.04, 0.04, 0.06];

const NIGHT_SKY_BRIGHTNESS = 0.05;
const DAY_SKY_BRIGHTNESS = 0.9;
const DISABLED_SKY_BRIGHTNESS = 1.0;

// ── triangulation LUTs ──────────────────────────────────────────────
//
// 6 verts per quad; corner index per vert depends on diagFlip.
//   default: {0,1,2, 0,2,3}  packed 2b/slot → 3620
//   flipped: {1,2,3, 1,3,0}  packed 2b/slot →  889
//
// shifted out by `vertInQuad * 2` to extract the corner index in [0,3].
export const TRI_DECODE_DEFAULT = 0 | (1 << 2) | (2 << 4) | (0 << 6) | (2 << 8) | (3 << 10);
export const TRI_DECODE_FLIPPED = 1 | (2 << 2) | (3 << 4) | (1 << 6) | (3 << 8) | (0 << 10);

export type VoxelPass = 'opaque' | 'transparent' | 'translucent';

// ── shared shader sub-graphs ────────────────────────────────────────

export function buildEnvSky(env: EnvironmentResources) {
    const cfg = env.cfgNode;

    const TAU = f32(Math.PI * 2);
    const sunAngle = mul(sub(env.timeNode.time, f32(0.25)), TAU).toVar('sunAngle');
    const sunDirection = vec3f(cos(sunAngle), sin(sunAngle), f32(0)).toVar('sunDirection');

    const sunY = sunDirection.y;
    const dayCurve = smoothstep(f32(-0.1), f32(0.15), sunY).toVar('dayCurve');
    const skyBrightnessActive = mix(f32(NIGHT_SKY_BRIGHTNESS), f32(DAY_SKY_BRIGHTNESS), dayCurve).toVar('skyBrightnessActive');
    const enabledMask = cfg.enabled.toF32().toVar('enabledMask');
    const skyBrightness = mix(f32(DISABLED_SKY_BRIGHTNESS), skyBrightnessActive, enabledMask).toVar('skyBrightness');

    const sunIntensity = cfg.sunIntensity;
    const ambientMinimum = vec3f(f32(AMBIENT_MINIMUM[0]), f32(AMBIENT_MINIMUM[1]), f32(AMBIENT_MINIMUM[2])).toVar(
        'ambientMinimum',
    );

    return { sunDirection, sunIntensity, skyBrightness, ambientMinimum };
}

export function unpackVoxelLight(lightNode: Node<d.u32>, skyBrightness: Node<d.f32>) {
    const lightR = brightnessCurve(lightNode.bitwiseAnd(u32(0xf)).toF32().div(f32(15.0))).toVar('lightR');
    const lightG = brightnessCurve(lightNode.shiftRight(u32(8)).bitwiseAnd(u32(0xf)).toF32().div(f32(15.0))).toVar('lightG');
    const lightB = brightnessCurve(lightNode.shiftRight(u32(16)).bitwiseAnd(u32(0xf)).toF32().div(f32(15.0))).toVar('lightB');
    const lightSky = brightnessCurve(lightNode.shiftRight(u32(24)).bitwiseAnd(u32(0xf)).toF32().div(f32(15.0))).toVar('lightSky');

    // Sodium parity: combine sky and block additively (clamped), matching
    // MC's lightmap behavior. `max(block, sky)` lets a dark sky-shadow corner
    // (from smooth-light averaging across cells where one neighbour is
    // sky-occluded) override a bright block-light corner, manifests as a
    // dark halo extending from opaque blocks even when a torch is adjacent.
    // Additive lets both channels contribute, so block light fills sky shadow.
    const skyContrib = vec3f(mul(lightSky, skyBrightness), mul(lightSky, skyBrightness), mul(lightSky, skyBrightness)).toVar(
        'skyContrib',
    );
    const blockLight = vec3f(lightR, lightG, lightB).toVar('blockLight');
    return min(add(blockLight, skyContrib), vec3f(f32(1.0), f32(1.0), f32(1.0))).toVar('voxelLight');
}

// ── oct16 normal decode ─────────────────────────────────────────────

export const decodeOct16 = Fn(
    (packed) => {
        const u = packed.bitwiseAnd(u32(0xff)).toF32().div(f32(255.0)).mul(f32(2.0)).sub(f32(1.0)).toVar('octU');
        const v = packed
            .shiftRight(u32(8))
            .bitwiseAnd(u32(0xff))
            .toF32()
            .div(f32(255.0))
            .mul(f32(2.0))
            .sub(f32(1.0))
            .toVar('octV');
        const nx = Var('octNx', u);
        const ny = Var('octNy', v);
        const nz = Var('octNz', sub(sub(f32(1.0), abs(u)), abs(v)));
        If(nz.lessThan(f32(0.0)), () => {
            // gotcha 1: sign-not-zero (`x >= 0 ? 1 : -1`), matching encodeOct16 —
            // WGSL sign(0) is 0, which collapses cardinal-face normals to garbage.
            const snzU = select(f32(-1.0), f32(1.0), u.greaterThanEqual(f32(0.0)));
            const snzV = select(f32(-1.0), f32(1.0), v.greaterThanEqual(f32(0.0)));
            // gotcha 2: both folds read the PRE-fold nx/ny — the .toVar()s force
            // that; inlined, ty would read the already-folded nx.
            const tx = mul(sub(f32(1.0), abs(ny)), snzU).toVar('octTx');
            const ty = mul(sub(f32(1.0), abs(nx)), snzV).toVar('octTy');
            nx.assign(tx);
            ny.assign(ty);
        });
        const lenInv = f32(1.0)
            .div(max(f32(1e-6), sqrt(add(add(mul(nx, nx), mul(ny, ny)), mul(nz, nz)))))
            .toVar('lenInv');
        return vec3f(mul(nx, lenInv), mul(ny, lenInv), mul(nz, lenInv));
    },
    { name: 'decodeOct16', params: [{ name: 'packed', type: d.u32 }] },
);

// ── byte-from-u32-triple reader ─────────────────────────────────────
//
// 12 bytes laid out as bytes[0..11] across (u0, u1, u2). picks byte
// `byteIdx` (0..11) and returns it as u32.

/** one u16 out of six packed u32s, low half first: half index `corner*3 + axis`.
 *  The position counterpart to `readByte`, which the u8 layout used before
 *  positions widened to carry overhang past the chunk. */
export const readHalf = Fn(
    (w0, w1, w2, w3, w4, w5, halfIdx) => {
        const which = halfIdx.shiftRight(u32(1)).toVar('halfWhich');
        const bit = halfIdx.bitwiseAnd(u32(1)).mul(u32(16)).toVar('halfBit');
        const pack = select(
            select(select(w5, w4, which.equal(u32(4))), select(w3, w2, which.equal(u32(2))), which.lessThan(u32(4))),
            select(w1, w0, which.equal(u32(0))),
            which.lessThan(u32(2)),
        ).toVar('halfPack');
        return pack.shiftRight(bit).bitwiseAnd(u32(0xffff));
    },
    {
        name: 'readHalf',
        params: [
            { name: 'w0', type: d.u32 },
            { name: 'w1', type: d.u32 },
            { name: 'w2', type: d.u32 },
            { name: 'w3', type: d.u32 },
            { name: 'w4', type: d.u32 },
            { name: 'w5', type: d.u32 },
            { name: 'halfIdx', type: d.u32 },
        ],
        return: d.u32,
    },
);

export const readByte = Fn(
    (u0, u1, u2, byteIdx) => {
        const which = byteIdx.shiftRight(u32(2)).toVar('byteWhich');
        const bit = byteIdx.bitwiseAnd(u32(3)).mul(u32(8)).toVar('byteBit');
        const pack = select(select(u2, u1, which.equal(u32(1))), u0, which.equal(u32(0))).toVar('bytePack');
        return pack.shiftRight(bit).bitwiseAnd(u32(0xff));
    },
    {
        name: 'readByte',
        params: [
            { name: 'u0', type: d.u32 },
            { name: 'u1', type: d.u32 },
            { name: 'u2', type: d.u32 },
            { name: 'byteIdx', type: d.u32 },
        ],
    },
);

// ── vertex animation ────────────────────────────────────────────────
//
// returns vec3f(xDisp, zDisp, depthBias). animType=0 → all zeros.
//
// `worldPos` is the per-corner world-space vertex position; `blockCenter`
// is the source block's world-space center (sectionOrigin + blockLocal +
// 0.5), shared across every corner of every quad in that block. Phasing
// off blockCenter (not per-corner worldPos) keeps animated geometry
// cohesive within a block, crossed-quad plants sway as one piece,
// liquid ripples don't tear at quad seams.

export const computeVertexAnimation = Fn(
    (worldPos, blockCenter, animType, elapsedTime) => {
        const xDisp = Var('xDisp', f32(0.0));
        const zDisp = Var('zDisp', f32(0.0));
        const depthBias = Var('depthBias', f32(0.0));
        // per-vertex phase, water and leaves want per-corner shimmer.
        const vertexPhase = add(worldPos.x, worldPos.z).toVar('vertexPhase');

        If(equal(animType, u32(1)), () => {
            const phase = add(vertexPhase, mul(elapsedTime, f32(2.5)));
            const amount = mul(sin(phase), f32(0.08));
            xDisp.assign(amount);
            zDisp.assign(amount);
            depthBias.assign(mul(f32(-0.002), abs(amount)));
        })
            .ElseIf(equal(animType, u32(2)), () => {
                const phase = add(vertexPhase, mul(elapsedTime, f32(3.2)));
                const amount = mul(sin(phase), f32(0.06));
                xDisp.assign(amount);
                zDisp.assign(amount);
            })
            .ElseIf(equal(animType, u32(3)), () => {
                // crossed-plant case: phase the whole block coherently so both
                // diagonals agree at their shared corners. tip-weight is 0 at
                // the block's base, 1 at its top, clamps tolerate sub-block
                // geometry that pokes outside [base, base+1].
                const blockPhase = add(blockCenter.x, blockCenter.z).toVar('blockPhase');
                const blockBaseY = sub(blockCenter.y, f32(0.5)).toVar('blockBaseY');
                const weight = max(f32(0.0), sub(worldPos.y, blockBaseY)).toVar('tipWeight');
                const phase = add(blockPhase, mul(elapsedTime, f32(2.0)));
                xDisp.assign(mul(mul(sin(phase), f32(0.12)), weight));
                zDisp.assign(mul(mul(cos(phase), f32(0.12)), weight));
            });

        return vec3f(xDisp, zDisp, depthBias);
    },
    {
        name: 'computeVertexAnimation',
        params: [
            { name: 'worldPos', type: d.vec3f },
            { name: 'blockCenter', type: d.vec3f },
            { name: 'animType', type: d.u32 },
            { name: 'elapsedTime', type: d.f32 },
        ],
    },
);

// ── shared quad-pull decoders ───────────────────────────────────────
//
// extracted from the chunk and baked-mesh vertex graphs, both pull from
// a `quads` storage buffer of 9 u32/quad with identical header layout,
// so the per-corner position/uv/normal decode and the flags decode are
// byte-for-byte the same. each returns a record of TSL `Node`s; the
// per-quad reads hoist into named locals via `toVar` so generated WGSL
// matches the previous inlined version.

/** vertInQuad (0..5) → corner index (0..3) via 2-bit LUT, picked by diagFlip.
 *  Caller pulls `diagFlip` from the quad's meta word, bit 16 (set by
 *  meshChunk's emitQuadLight* helpers, Sodium hierarchical compare). */
export function pickCornerIdx(diagFlip: Node<d.u32>, vertInQuad: Node<d.u32>) {
    const decode = select(u32(TRI_DECODE_FLIPPED), u32(TRI_DECODE_DEFAULT), diagFlip.equal(u32(0))).toVar('triDecode');
    return decode
        .shiftRight(mul(vertInQuad, u32(2)))
        .bitwiseAnd(u32(3))
        .toVar('cornerIdx');
}

/** flags word (u32[8]) → { texIndex, animType, emissive }. layout:
 *  texIndex(16) | animType(4) | facing(3) | emissive(1) | unshaded(1) | reserved(7).
 *  bit 23 (formerly the diagFlip, now the meta word bit 16) is the
 *  emissive flag, self-lit quads skip directional face-shade + AO so
 *  they glow uniformly. */
export function decodeQuadFlags(flags: Node<d.u32>) {
    const texIndex = flags.bitwiseAnd(u32(0xffff)).toF32().toVar('texIndex');
    const animType = flags.shiftRight(u32(16)).bitwiseAnd(u32(0xf)).toVar('animType');
    const emissive = flags.shiftRight(u32(23)).bitwiseAnd(u32(1)).toVar('emissive');
    const unshaded = flags.shiftRight(u32(24)).bitwiseAnd(u32(1)).toVar('unshaded');
    return { texIndex, animType, emissive, unshaded };
}

/** read u0..u3, uv0..uv3 for `realQuadId`, decode the per-corner position
 *  raw u16s, uv, and oct16 normal. caller applies `POS_DECODE_SCALE` and
 *  `POS_DECODE_ORIGIN` to reach voxels (inverse of the mesher's `posEncode`).
 *  `u3` is returned so callers can read source-block bits 16..27 without
 *  re-fetching. */
export function decodeQuadCorner(quadBuf: Node<d.array<d.u32>>, realQuadId: Node<d.u32>, cornerIdx: Node<d.u32>) {
    const base = mul(realQuadId, u32(QUAD_STRIDE_U32S)).toVar('quadBase');
    const p0 = index(quadBuf, add(base, u32(0))).toVar('qdP0');
    const p1 = index(quadBuf, add(base, u32(1))).toVar('qdP1');
    const p2 = index(quadBuf, add(base, u32(2))).toVar('qdP2');
    const p3 = index(quadBuf, add(base, u32(3))).toVar('qdP3');
    const p4 = index(quadBuf, add(base, u32(4))).toVar('qdP4');
    const p5 = index(quadBuf, add(base, u32(5))).toVar('qdP5');
    const u3 = index(quadBuf, add(base, u32(6))).toVar('qd6');
    const uv0 = index(quadBuf, add(base, u32(7))).toVar('qdUv0');
    const uv1 = index(quadBuf, add(base, u32(8))).toVar('qdUv1');
    const uv2 = index(quadBuf, add(base, u32(9))).toVar('qdUv2');
    const uv3 = index(quadBuf, add(base, u32(10))).toVar('qdUv3');

    const halfBase = mul(cornerIdx, u32(3)).toVar('halfBase');
    const bx = readHalf(p0, p1, p2, p3, p4, p5, halfBase).toF32().toVar('bx');
    const by = readHalf(p0, p1, p2, p3, p4, p5, add(halfBase, u32(1)))
        .toF32()
        .toVar('by');
    const bz = readHalf(p0, p1, p2, p3, p4, p5, add(halfBase, u32(2)))
        .toF32()
        .toVar('bz');
    const chunkLocalByte = vec3f(bx, by, bz).toVar('chunkLocalHalf');

    const uvPacked = select(
        select(uv3, uv2, cornerIdx.equal(u32(2))),
        select(uv1, uv0, cornerIdx.equal(u32(0))),
        cornerIdx.lessThan(u32(2)),
    ).toVar('uvPacked');
    const uvU = uvPacked.bitwiseAnd(u32(0xffff)).toF32().div(f32(65535.0)).toVar('uvU');
    const uvV = uvPacked.shiftRight(u32(16)).bitwiseAnd(u32(0xffff)).toF32().div(f32(65535.0)).toVar('uvV');
    const uv = vec2f(uvU, uvV).toVar('uv');

    const modelNormal = decodeOct16(u3.bitwiseAnd(u32(0xffff))).toVar('modelNormal');

    return { u3, chunkLocalByte, uv, modelNormal };
}

/** mean of the quad's 4 corner positions, in chunk-local VOXELS. Reads only the 6
 *  position words. The translucent sort's within-cell distance refinement keys off
 *  it (cross-cell order is the owner-cell L1 term).
 *
 *  Returns voxels rather than raw units so callers need no scale of their own - the
 *  encoding's origin offset would otherwise have to be undone at every call site,
 *  and forgetting it shifts every centroid by 8 voxels. */
export function decodeQuadCentroid(quadBuf: Node<d.array<d.u32>>, realQuadId: Node<d.u32>) {
    const base = mul(realQuadId, u32(QUAD_STRIDE_U32S)).toVar('centroidBase');
    const p0 = index(quadBuf, add(base, u32(0))).toVar('cp0');
    const p1 = index(quadBuf, add(base, u32(1))).toVar('cp1');
    const p2 = index(quadBuf, add(base, u32(2))).toVar('cp2');
    const p3 = index(quadBuf, add(base, u32(3))).toVar('cp3');
    const p4 = index(quadBuf, add(base, u32(4))).toVar('cp4');
    const p5 = index(quadBuf, add(base, u32(5))).toVar('cp5');
    // 4 corners, 3 halves each: corner c at half 3c (x), 3c+1 (y), 3c+2 (z).
    const at = (i: number) => readHalf(p0, p1, p2, p3, p4, p5, u32(i)).toF32();
    const sx = add(add(at(0), at(3)), add(at(6), at(9)));
    const sy = add(add(at(1), at(4)), add(at(7), at(10)));
    const sz = add(add(at(2), at(5)), add(at(8), at(11)));
    return vec3f(sx, sy, sz)
        .mul(f32(0.25 * POS_DECODE_SCALE))
        .sub(vec3f(f32(POS_DECODE_ORIGIN)));
}

/** inverse of the mesher's `posEncode`: `voxels = half * POS_DECODE_SCALE -
 *  POS_DECODE_ORIGIN`. Kept here rather than imported as two constants so the pair
 *  is read together - applying one without the other silently shifts the world. */
export const POS_DECODE_SCALE = 1 / 2048;
export const POS_DECODE_ORIGIN = 8;

// ── atlas sampling: Sodium's `block_layer_opaque.fsh`, both paths ───
//
// The block atlas is one packed 2D texture sampled nearest-within-level. Two
// sampling paths, as in Sodium: `sampleRGSS` (default) chooses the mip level
// itself from the geometric mean of the UV derivatives and takes four
// rotated-grid taps at that level, blended against `sampleNearest` by how many
// texels a pixel covers; `sampleNearest` snaps the UV toward the texel centre by
// the texel's screen size and lets the hardware pick the level from the
// derivatives. Magnified surfaces stay hard pixel art on either path.

/** Sodium's `u_UseRGSS`, on by default (`SodiumConfigBuilder`). */
const USE_RGSS = true;

/** Sodium discards on the blended (averaged) alpha. The sharp-tap alternative
 *  is the one place this renderer used to diverge on purpose: averaged alpha
 *  near the threshold flips per neighbour and a solid block disintegrates. The
 *  bake's coverage-preserving mips are what keep averaged alpha away from the
 *  threshold at distance; this flag is the A/B against the disintegration case. */
const ALPHA_FROM_NEAREST_TAP = false;

/** Sodium's `TINY` cutoff for the translucent layer. */
const TRANSLUCENT_ALPHA_MIN = 0.0001;

/** RGSS tap offsets in texels (`sampleRGSS`). */
const RGSS_OFFSETS: [number, number][] = [
    [0.125, 0.375],
    [-0.125, -0.375],
    [0.375, -0.125],
    [-0.375, 0.125],
];

const round = (x: Node<d.vec2f>) => floor(x.add(vec2f(f32(0.5), f32(0.5))));

// ── shared fragment graph ───────────────────────────────────────────

/**
 * Frame resolution runs in the vertex stage (everything here is wrapped in a
 * flat varying): the rect of the current and next frame, and the mix between
 * them. `texIndex` is the quad's vertex-stage texture index; frame `f` of a
 * texture is rect `texIndex + f`.
 */
export function buildVoxelFragment(
    textures: VoxelTextures,
    texIndex: Node<d.f32>,
    vUv: Node<d.vec2f>,
    vLight: Node<d.vec3f>,
    vNormal: Node<d.vec3f>,
    sunDirection: Node<d.vec3f>,
    sunIntensity: Node<d.f32>,
    ambientMinimum: Node<d.vec3f>,
    elapsedTime: Node<d.f32>,
) {
    // texture animation, per vertex
    const entries = storage(textures.entriesBuffer, 'read');
    const baseIndex = i32(texIndex).toVar('baseIndex');
    const animInfo = entries.element(baseIndex).field('anim').toVar('animInfo');
    const frameCount = animInfo.x;
    const fps = animInfo.y;
    const doInterpolate = animInfo.z;

    const t = mul(elapsedTime, fps).toVar('animT');
    const frameF = floor(t).mod(frameCount).toVar('frameF');
    const nextFrameF = add(frameF, f32(1.0)).mod(frameCount).toVar('nextFrameF');
    const rectA = entries
        .element(i32(add(texIndex, frameF)))
        .field('rect')
        .toVar('rectA');
    const rectB = entries
        .element(i32(add(texIndex, nextFrameF)))
        .field('rect')
        .toVar('rectB');
    const mixFactor = mul(doInterpolate, fract(t)).toVar('mixFactor');

    const vRectA = varying(rectA, 'vRectA').setInterpolation('flat');
    const vRectB = varying(rectB, 'vRectB').setInterpolation('flat');
    const vMixFactor = varying(mixFactor, 'vMixFactor').setInterpolation('flat');

    // atlas-space UV. The quarter-texel shrink toward the quad's centre that
    // keeps a nearest tap inside its own tile is already in vUv (the mesher).
    const pixelSize = textures.texelSize;
    const uvA = (vRectA.xy.add(vUv.mul(vRectA.zw)) as Node<d.vec2f>).toVar('uvA');
    const uvB = (vRectB.xy.add(vUv.mul(vRectB.zw)) as Node<d.vec2f>).toVar('uvB');

    // derivatives of the atlas UV. Both frames' rects are the same size, so
    // one pair serves both.
    const du = dpdx(uvA).toVar('vmDu');
    const dv = dpdy(uvA).toVar('vmDv');
    const texelScreen = max(sqrt(du.mul(du).add(dv.mul(dv))), vec2f(f32(1e-8), f32(1e-8))).toVar('vmTexelScreen');

    const tex = texture(textures.atlas);

    // `sampleNearest`: snap toward the texel centre by the texel's screen size,
    // then let the hardware pick the level from the (unsnapped) derivatives.
    const sampleNearest = (uv: Node<d.vec2f>, name: string): Node<d.vec4f> => {
        const uvTexel = uv.div(pixelSize).toVar(`${name}Texel`);
        const texelCenter = round(uvTexel)
            .sub(vec2f(f32(0.5), f32(0.5)))
            .toVar(`${name}Center`);
        const rawOffset = uvTexel.sub(texelCenter);
        const snapped = clamp(
            rawOffset
                .sub(vec2f(f32(0.5), f32(0.5)))
                .mul(pixelSize)
                .div(texelScreen)
                .add(vec2f(f32(0.5), f32(0.5))),
            vec2f(f32(0), f32(0)),
            vec2f(f32(1), f32(1)),
        ).toVar(`${name}Offset`);
        const snappedUv = texelCenter.add(snapped).mul(pixelSize).toVar(`${name}Uv`);
        return tex.sample(snappedUv).grad(du, dv).toVar(`${name}Nearest`);
    };

    // `sampleRGSS`: explicit level from the geometric mean of the derivatives,
    // four rotated-grid taps at it, blended in between one and two texels per
    // pixel, which is exactly where minification starts to alias.
    const maxTexelSize = max(texelScreen.x, texelScreen.y).toVar('vmMaxTexelSize');
    const minPixelSize = min(pixelSize.x, pixelSize.y).toVar('vmMinPixelSize');
    const rgssBlend = smoothstep(minPixelSize, minPixelSize.mul(f32(2)), maxTexelSize).toVar('vmRgssBlend');
    const duLen = length(du).toVar('vmDuLen');
    const dvLen = length(dv).toVar('vmDvLen');
    const effectiveDerivative = sqrt(min(duLen, dvLen).mul(max(duLen, dvLen))).toVar('vmEffectiveDerivative');
    // Sodium leaves the top clamp to the hardware; ours is explicit because a
    // level past the chain reads as black with zero alpha.
    const mipLevel = clamp(log2(effectiveDerivative.div(minPixelSize)), f32(0), f32(ATLAS_MIP_LEVELS)).toVar('vmMipLevel');

    const sampleAtlas = (uv: Node<d.vec2f>, name: string): Node<d.vec4f> => {
        const nearest = sampleNearest(uv, name);
        if (!USE_RGSS) return nearest;
        let rgss: Node<d.vec4f> | null = null;
        for (const [ox, oy] of RGSS_OFFSETS) {
            const tap = tex.sample(uv.add(vec2f(f32(ox), f32(oy)).mul(pixelSize))).level(mipLevel);
            rgss = rgss ? rgss.add(tap) : tap;
        }
        const averaged = rgss!.mul(f32(0.25)).toVar(`${name}Rgss`);
        const blended = mix(nearest, averaged, rgssBlend) as Node<d.vec4f>;
        return (ALPHA_FROM_NEAREST_TAP ? vec4f(blended.rgb, nearest.a) : blended).toVar(name);
    };

    const colorA = sampleAtlas(uvA, 'colorA');
    const colorB = sampleAtlas(uvB, 'colorB');
    const texColor = (mix(colorA, colorB, vMixFactor) as Node<d.vec4f>).toVar('texColor');

    // lighting, per-face directional shade is folded into vLight
    // vertex-side (see vertex shader's aoMul). sunShade and ambient
    // floor stay per-fragment because they depend on vNormal vs sun.
    const ndotl = max(dot(vNormal, sunDirection), f32(0.0)).toVar('ndotl');
    const sunShade = mix(sub(f32(1.0), sunIntensity), f32(1.0), ndotl).toVar('sunShade');

    const light = max(mul(vLight, sunShade), ambientMinimum).toVar('light');

    const rgb = mul(texColor.rgb, light).toVar('rgb');
    const fragColor = vec4(rgb, texColor.a).toVar('fragColor');

    // `light` is returned so per-instance traits (voxel meshes) can tint the
    // albedo before lighting and floor in glow; the chunk path ignores it.
    return { fragColor, texColor, light };
}

/** the translucent pass drops fully transparent fragments (Sodium's `TINY`),
 *  so an invisible texel never writes blend or sort work. */
const translucentDiscard = Fn(
    (c, a) => {
        If(a.lessThan(f32(TRANSLUCENT_ALPHA_MIN)), () => {
            Discard();
        });
        return c;
    },
    {
        name: 'translucentDiscard',
        return: d.vec4f,
        params: [
            { name: 'color', type: d.vec4f },
            { name: 'alpha', type: d.f32 },
        ],
    },
);

// ── pass-specific Material wiring ───────────────────────────────────

export function makePassMaterial(opts: {
    name: string;
    pass: VoxelPass;
    clipPos: Node<d.vec4f>;
    fragColor: Node<d.vec4f>;
    texColor: Node<d.vec4f>;
    // per-instance screen-door fade for the cutout pass, default is a pure
    // cutout (the chunk path); voxel meshes pass their dither knob.
    dither?: Node<d.f32>;
}): Material {
    const { name, pass, clipPos, fragColor, texColor, dither } = opts;

    if (pass === 'opaque') {
        return new Material({
            name,
            vertex: clipPos,
            fragment: fragColor,
            cullMode: 'back',
            depthTest: true,
            depthWrite: true,
        });
    }

    if (pass === 'transparent') {
        const fragment = ditherDiscard(fragColor, texColor.a, dither ?? f32(0));
        return new Material({
            name,
            vertex: clipPos,
            fragment: fragment,
            cullMode: 'back',
            depthTest: true,
            depthWrite: true,
        });
    }

    // translucent
    return new Material({
        name,
        vertex: clipPos,
        fragment: translucentDiscard(fragColor, texColor.a),
        transparent: true,
        cullMode: 'none',
        depthTest: true,
        depthWrite: false,
    });
}

// ── quad material: shared shading core + two per-instance resolvers ──
//
// `buildQuadShading` is the backend-neutral shading core: given a resolved
// `realQuadId` (absolute arena quad index) + `sectionOrigin`, it reads the quad
// header/corner/uv/light/AO from `quads[realQuadId]`, applies vertex animation +
// standard MVP, and builds the pass Material. The two front-ends resolve
// `(realQuadId, sectionOrigin)` from their per-instance source and delegate:
//   - `createGpuQuadMaterial` (WebGPU): `visibleQuads[instanceIndex] → {slot,
//     localIdx}`; `realQuadId = chunkInfo[slot].arenaBase + localIdx`. Per-pass
//     draw is `geometry.indirect` (vertexCount=6, instanceCount=visibleQuadCount).
//   - `createCpuQuadMaterial` (WebGL): `mesh.draws` makes `instanceIndex` the
//     absolute quad id, so `realQuadId = instanceIndex`; `sectionOrigin =
//     chunkInfo[quadSlot[instanceIndex]].origin`.
// each instance is one quad (6 verts, 2 tris); all reads are read-only `storage()`
// so the CPU variant auto-lowers on WebGL2.
//
// per-name storage bindings (set on the per-pass chunk geometry):
//   'quads'        shared quadArena.quads (interleaved header+light, stride=14 u32)
//   'visibleQuads' (WebGPU) this pass's GPU-built per-quad table
//   'quadSlot'     (WebGL) per-quad → section-slot table (cpu-frame projection)
//   'chunkInfo'    per-room ChunkInfo side-table (slot → {origin, arenaBase})
//   'env'          per-room EnvConfig

function buildQuadShading(opts: {
    quads: Node<d.array<d.u32>>;
    realQuadId: Node<d.u32>;
    sectionOrigin: Node<d.vec3f>;
    textures: VoxelTextures;
    pass: VoxelPass;
    elapsedTime: Node<d.f32>;
    env: EnvironmentResources;
}): Material {
    const { quads, realQuadId, sectionOrigin, textures, pass, elapsedTime, env } = opts;

    // vertexIndex is 0..5 directly (6 verts per instance).
    const vertInQuad = vertexIndex.toVar('vertInQuad');

    const headerBase = mul(realQuadId, u32(QUAD_STRIDE_U32S)).toVar('quadHeaderBase');
    const flags = index(quads, add(headerBase, u32(FLAGS_OFFSET))).toVar('qdFlags');
    const meta = index(quads, add(headerBase, u32(META_OFFSET))).toVar('qdMeta');

    const { texIndex, animType, emissive, unshaded } = decodeQuadFlags(flags);

    // diagFlip from the meta word (bit 16). Was corner-0 of the per-corner
    // light slot, back when the mesher baked light into the quad stream.
    const diagFlip = meta.shiftRight(u32(QUAD_META_DIAG_FLIP_BIT)).bitwiseAnd(u32(1)).toVar('diagFlip');

    const cornerIdx = pickCornerIdx(diagFlip, vertInQuad);
    const { u3, chunkLocalByte, uv, modelNormal: normal } = decodeQuadCorner(quads, realQuadId, cornerIdx);
    // inverse of mesher pos16's 255/16 scale: byte 0 → 0, byte 255 → 16.
    const chunkLocal = chunkLocalByte.mul(f32(POS_DECODE_SCALE)).sub(f32(POS_DECODE_ORIGIN)).toVar('chunkLocal');

    // ── per-corner AO: 4-bit quantized brightness from meta low 16 bits.
    //    bits → brightness via `bits/30 + 0.5`, mapping 0..15 → [0.5, 1.0].
    //    full-block AO bakes through AO_BRIGHTNESS_TABLE (softened from
    //    vanilla MC); partial-face quads keep sub-level precision via
    //    bilinear blend.
    const aoBits = meta
        .shiftRight(mul(cornerIdx, u32(4)))
        .bitwiseAnd(u32(0xf))
        .toVar('aoBits');
    const aoFactor = aoBits.toF32().div(f32(30.0)).add(f32(0.5)).toVar('aoFactor');

    // ── per-face directional shade (vanilla MC parity): top=1.0,
    //    bottom=0.5, X(E/W)=0.6, Z(N/S)=0.8. Sodium applies face-shade
    //    into the AO term, NOT into sky/block light, so a torch under
    //    an overhang still illuminates the underside fully. Compute
    //    from `normal` (per-vertex) so irregular quads get a smooth
    //    n²-weighted blend across axes via vertex interpolation.
    const sideFactor = abs(normal.x).greaterThan(f32(0.5)).select(f32(0.6), f32(0.8)).toVar('sideFactor');
    const yPosFactor = normal.y.greaterThan(f32(0.5)).select(f32(1.0), sideFactor).toVar('yPosFactor');
    const faceFactor = normal.y.lessThan(f32(-0.5)).select(f32(0.5), yPosFactor).toVar('faceFactor');

    // ── source-block center (shared by every corner of every quad in
    //    the block; phasing anim off this instead of per-corner worldPos
    //    keeps crossed plant quads + multi-quad liquid surfaces cohesive)
    const blockLocalX = u3.shiftRight(u32(16)).bitwiseAnd(u32(0xf)).toF32().toVar('blockLocalX');
    const blockLocalY = u3.shiftRight(u32(20)).bitwiseAnd(u32(0xf)).toF32().toVar('blockLocalY');
    const blockLocalZ = u3.shiftRight(u32(24)).bitwiseAnd(u32(0xf)).toF32().toVar('blockLocalZ');
    const blockCenter = vec3f(
        add(add(sectionOrigin.x, blockLocalX), f32(0.5)),
        add(add(sectionOrigin.y, blockLocalY), f32(0.5)),
        add(add(sectionOrigin.z, blockLocalZ), f32(0.5)),
    ).toVar('blockCenter');

    // ── vertex animation ─────────────────────────────────────────────
    const worldPosBase = add(sectionOrigin, chunkLocal).toVar('worldPosBase');
    const animResult = computeVertexAnimation(worldPosBase, blockCenter, animType, elapsedTime);
    const xDisp = animResult.x;
    const zDisp = animResult.y;
    const depthBias = animResult.z;

    const worldPos = vec3f(add(worldPosBase.x, xDisp), worldPosBase.y, add(worldPosBase.z, zDisp)).toVar('worldPos');
    const viewPos = mul(cameraViewMatrix, vec4f(worldPos, f32(1.0))).toVar('viewPos');
    const rawClipPos = mul(cameraProjectionMatrix, viewPos).toVar('rawClipPos');
    const clipPos = vec4f(rawClipPos.x, rawClipPos.y, add(rawClipPos.z, depthBias), rawClipPos.w).toVar('clipPos');

    // ── env-derived sky/sun ─────────────────────────────────────────
    const { sunDirection, sunIntensity, skyBrightness, ambientMinimum } = buildEnvSky(env);

    // Sodium-parity AO: apply aoFactor uniformly regardless of corner
    // brightness. Vanilla MC behavior, AO darkens corners by the same
    // proportion in lit and unlit scenes. Emissive quads (torch, glowstone)
    // opt out of both AO and directional face-shade so a self-lit block
    // glows uniformly instead of dimming its E/W/N/S faces to 0.6/0.8.
    // Corner light comes from the GPU light volume, not the quad stream, and is
    // ANCHORED: it reads only the four cells on this face's own side, which is
    // the mesher's centre/edgeA/edgeB/diagonal tap. A shared pre-blended corner
    // value cannot work here, because a corner joins cells light cannot travel
    // between (a sealed pocket and a lit shaft meeting only at a diagonal) and
    // one number cannot be both.
    const cornerChannels = lightAtFaceCorner(
        bindLightVolume(env),
        sectionOrigin.x.add(blockLocalX),
        sectionOrigin.y.add(blockLocalY),
        sectionOrigin.z.add(blockLocalZ),
        floor(normal.x.add(f32(0.5))).toI32(),
        floor(normal.y.add(f32(0.5))).toI32(),
        floor(normal.z.add(f32(0.5))).toI32(),
        worldPosBase.x,
        worldPosBase.y,
        worldPosBase.z,
    ).toVar('cornerChannels');
    const rawLight = combineVoxelLight(cornerChannels, skyBrightness).toVar('rawLight');
    // `shade: false` quads (foliage planes) keep AO but drop the face shade,
    // so a clump reads as one mass instead of lit cards.
    const shadeMul = unshaded.equal(u32(1)).select(f32(1.0), faceFactor).toVar('shadeMul');
    const aoMul = emissive.equal(u32(1)).select(f32(1.0), mul(aoFactor, shadeMul)).toVar('aoMul');
    const voxelLight = rawLight.mul(aoMul).toVar('voxelLightAo');

    // ── varyings ────────────────────────────────────────────────────
    const vUv = varying(uv, 'vUv');
    const vLight = varying(voxelLight, 'vLight');
    const vNormal = varying(normal, 'vNormal');

    const { fragColor, texColor } = buildVoxelFragment(
        textures,
        texIndex,
        vUv,
        vLight,
        vNormal,
        sunDirection,
        sunIntensity,
        ambientMinimum,
        elapsedTime,
    );

    const foggedColor = vec4(applyFog(env, fragColor.rgb, fogDistance(worldPos, 'vFogDist')), fragColor.a).toVar('foggedColor');

    return makePassMaterial({
        name: `voxel-quad-${pass}`,
        pass,
        clipPos,
        fragColor: foggedColor,
        texColor,
    });
}

/**
 * WebGPU resolver: the per-instance quad comes from the GPU-built `visibleQuads`
 * table (`{slot, localIdx}` for `instanceIndex`); `realQuadId = chunkInfo[slot].
 * arenaBase + localIdx`. Byte-identical to the pre-split unified material.
 */
export function createGpuQuadMaterial(opts: {
    textures: VoxelTextures;
    pass: VoxelPass;
    elapsedTime: Node<d.f32>;
    env: EnvironmentResources;
}): Material {
    const { textures, pass, elapsedTime, env } = opts;

    const quads = storage('quads', d.array(d.u32), 'read');
    const visibleQuads = storage('visibleQuads', d.array(VisibleQuad), 'read');
    const chunkInfo = storage('chunkInfo', d.array(ChunkInfo), 'read');

    const visEntry = visibleQuads.element(instanceIndex);
    const slot = visEntry.field('slot').toVar('slot');
    const localIdx = visEntry.field('localIdx').toVar('localIdx');
    const info = chunkInfo.element(slot);
    const sectionOrigin = info.field('origin').toVar('sectionOrigin');
    const arenaBase = info.field('arenaBase').toVar('arenaBase');
    const realQuadId = add(arenaBase, localIdx).toVar('realQuadId');

    return buildQuadShading({ quads, realQuadId, sectionOrigin, textures, pass, elapsedTime, env });
}

/**
 * WebGL resolver: `mesh.draws` makes `instanceIndex` the absolute arena quad id, so
 * `realQuadId = instanceIndex` (no `visibleQuads`, no `arenaBase` add). The section
 * origin comes from `chunkInfo[quadSlot[realQuadId]]` — `quadSlot` is a per-quad →
 * section-slot table the WebGL frame maintains. All read-only → auto-lowers.
 */
export function createCpuQuadMaterial(opts: {
    textures: VoxelTextures;
    pass: VoxelPass;
    elapsedTime: Node<d.f32>;
    env: EnvironmentResources;
}): Material {
    const { textures, pass, elapsedTime, env } = opts;

    const quads = storage('quads', d.array(d.u32), 'read');
    const quadSlot = storage('quadSlot', d.array(d.u32), 'read');
    const chunkInfo = storage('chunkInfo', d.array(ChunkInfo), 'read');

    const realQuadId = instanceIndex.toVar('realQuadId');
    const slot = index(quadSlot, realQuadId).toVar('slot');
    const sectionOrigin = chunkInfo.element(slot).field('origin').toVar('sectionOrigin');

    return buildQuadShading({ quads, realQuadId, sectionOrigin, textures, pass, elapsedTime, env });
}
