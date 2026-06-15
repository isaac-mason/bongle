// ── voxel material ──────────────────────────────────────────────────
//
// unified quad-pull material for the chunk renderer. one factory with
// three pass variants:
//
//   opaque       — backface culled, depth write, no discard
//   transparent  — backface culled, depth write, alpha-cutout discard
//   translucent  — no cull, no depth write, alpha blending, draws via
//                  quadOrder permutation
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
//   u32[8]   flags: texIndex(16) | animType(4) | facing(3) | reserved(9)
//            (bit 23 was diagFlip; now lives in light[0] bit 29 — per-relight
//            Sodium hierarchical compare, see chunk-mesher.applyDiagFlipBit)
//   u32[9]   meta:  aoPacked(16) | reserved(16)
//            aoPacked = ao0Bits | (ao1Bits<<4) | (ao2Bits<<8) | (ao3Bits<<12),
//            each aoNBits ∈ [0..15] encoding brightness via round((b-0.5)*30);
//            VS recovers brightness as bits/30 + 0.5 (range [0.5, 1.0]).
//
// per-corner positions are u8 at 1/16-voxel precision in chunk-local
// space; the section's `origin` (world-space) adds the chunk offset.
//
// lighting model — per-corner packed u32 encodes 4 channels:
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
    type ArrayTexture,
    abs,
    add,
    arrayTexture,
    cameraProjectionMatrix,
    cameraViewMatrix,
    cos,
    Discard,
    d,
    dot,
    equal,
    Fn,
    f32,
    floor,
    fract,
    type GpuBuffer,
    If,
    i32,
    index,
    instanceIndex,
    Material,
    max,
    min,
    mix,
    mul,
    type Node,
    select,
    sign,
    sin,
    smoothstep,
    sqrt,
    renderGroup,
    storage,
    sub,
    u32,
    Uniform,
    UniformNode,
    Var,
    varying,
    vec2f,
    vec3f,
    vec4,
    vec4f,
    vertexIndex,
    uniform,
} from 'gpucat';
import { META_OFFSET, QUAD_LIGHT_OFFSET, QUAD_STRIDE_U32S } from '../../core/voxels/chunk-mesher';

/**
 * Voxel animation clock in seconds. gpucat no longer ticks time itself, so the
 * render loop drives this each frame (see client/renderer.ts); static offline
 * renders leave it at 0, freezing animation. renderGroup so it uploads once per
 * render rather than per draw.
 */
export const elapsedTime = uniform('elapsedTime', d.f32);
elapsedTime.value = 0;

import { EnvConfig } from '../environment';
import { ChunkInfo, VisibleQuad } from './voxel-resources';

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

export function buildEnvSky() {
    const cfg = storage('env', EnvConfig, 'read').fields();

    const TAU = f32(Math.PI * 2);
    const sunAngle = mul(sub(cfg.time, f32(0.25)), TAU).toVar('sunAngle');
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

// Sodium-aligned brightness curve: ship raw 4-bit values per channel, apply
// the polynomial (-0.5*x + 1.5)*x*x in the shader. Equivalent (within
// rounding) to the legacy CPU-side LIGHT_LUT but skips the table and lets
// `calculateCornerBrightness` average values in packed-byte parallel form.
function brightnessCurve(x: Node<d.f32>) {
    // f(x) = (-0.5 * x + 1.5) * x * x  on x ∈ [0, 1]
    return mul(mul(add(mul(f32(-0.5), x), f32(1.5)), x), x);
}

export function unpackVoxelLight(lightNode: Node<d.u32>, skyBrightness: Node<d.f32>) {
    const lightR = brightnessCurve(lightNode.bitwiseAnd(u32(0xf)).toF32().div(f32(15.0))).toVar('lightR');
    const lightG = brightnessCurve(lightNode.shiftRight(u32(8)).bitwiseAnd(u32(0xf)).toF32().div(f32(15.0))).toVar('lightG');
    const lightB = brightnessCurve(lightNode.shiftRight(u32(16)).bitwiseAnd(u32(0xf)).toF32().div(f32(15.0))).toVar('lightB');
    const lightSky = brightnessCurve(lightNode.shiftRight(u32(24)).bitwiseAnd(u32(0xf)).toF32().div(f32(15.0))).toVar('lightSky');

    // Sodium parity: combine sky and block additively (clamped), matching
    // MC's lightmap behavior. `max(block, sky)` lets a dark sky-shadow corner
    // (from smooth-light averaging across cells where one neighbour is
    // sky-occluded) override a bright block-light corner — manifests as a
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
            const tx = mul(sub(f32(1.0), abs(ny)), sign(u));
            const ty = mul(sub(f32(1.0), abs(nx)), sign(v));
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
// cohesive within a block — crossed-quad plants sway as one piece,
// liquid ripples don't tear at quad seams.

export const computeVertexAnimation = Fn(
    (worldPos, blockCenter, animType) => {
        const xDisp = Var('xDisp', f32(0.0));
        const zDisp = Var('zDisp', f32(0.0));
        const depthBias = Var('depthBias', f32(0.0));
        // per-vertex phase — water and leaves want per-corner shimmer.
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
                // the block's base, 1 at its top — clamps tolerate sub-block
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
        ],
    },
);

// ── shared quad-pull decoders ───────────────────────────────────────
//
// extracted from the chunk and baked-mesh vertex graphs — both pull from
// a `quads` storage buffer of 9 u32/quad with identical header layout,
// so the per-corner position/uv/normal decode and the flags decode are
// byte-for-byte the same. each returns a record of TSL `Node`s; the
// per-quad reads hoist into named locals via `toVar` so generated WGSL
// matches the previous inlined version.

/** vertInQuad (0..5) → corner index (0..3) via 2-bit LUT, picked by diagFlip.
 *  Caller pulls `diagFlip` from `light[realQuadId * 4 + 0]` bit 29 (set by
 *  meshChunk's emitQuadLight* helpers — Sodium hierarchical compare). */
export function pickCornerIdx(diagFlip: Node<d.u32>, vertInQuad: Node<d.u32>) {
    const decode = select(u32(TRI_DECODE_FLIPPED), u32(TRI_DECODE_DEFAULT), diagFlip.equal(u32(0))).toVar('triDecode');
    return decode
        .shiftRight(mul(vertInQuad, u32(2)))
        .bitwiseAnd(u32(3))
        .toVar('cornerIdx');
}

/** flags word (u32[8]) → { texIndex, animType }. layout:
 *  texIndex(16) | animType(4) | facing(3) | reserved(9).
 *  diagFlip used to live at bit 23; it's now in `light[0]` bit 29 and
 *  callers extract it directly from the light buffer. */
export function decodeQuadFlags(flags: Node<d.u32>) {
    const texIndex = flags.bitwiseAnd(u32(0xffff)).toF32().toVar('texIndex');
    const animType = flags.shiftRight(u32(16)).bitwiseAnd(u32(0xf)).toVar('animType');
    return { texIndex, animType };
}

/** read u0..u3, uv0..uv3 for `realQuadId`, decode the per-corner position
 *  bytes, uv, and oct16 normal. caller applies the 16/255 voxel-space
 *  scale (inverse of mesher pos16's 255/16 — byte 0 → 0, byte 255 → 16).
 *  `u3` is returned so callers can read source-block bits 16..27 without
 *  re-fetching. */
export function decodeQuadCorner(quadBuf: Node<d.array<d.u32>>, realQuadId: Node<d.u32>, cornerIdx: Node<d.u32>) {
    const base = mul(realQuadId, u32(QUAD_STRIDE_U32S)).toVar('quadBase');
    const u0 = index(quadBuf, add(base, u32(0))).toVar('qd0');
    const u1 = index(quadBuf, add(base, u32(1))).toVar('qd1');
    const u2 = index(quadBuf, add(base, u32(2))).toVar('qd2');
    const u3 = index(quadBuf, add(base, u32(3))).toVar('qd3');
    const uv0 = index(quadBuf, add(base, u32(4))).toVar('qdUv0');
    const uv1 = index(quadBuf, add(base, u32(5))).toVar('qdUv1');
    const uv2 = index(quadBuf, add(base, u32(6))).toVar('qdUv2');
    const uv3 = index(quadBuf, add(base, u32(7))).toVar('qdUv3');

    const byteBase = mul(cornerIdx, u32(3)).toVar('byteBase');
    const bx = readByte(u0, u1, u2, byteBase).toF32().toVar('bx');
    const by = readByte(u0, u1, u2, add(byteBase, u32(1)))
        .toF32()
        .toVar('by');
    const bz = readByte(u0, u1, u2, add(byteBase, u32(2)))
        .toF32()
        .toVar('bz');
    const chunkLocalByte = vec3f(bx, by, bz).toVar('chunkLocalByte');

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

// ── shared fragment graph ───────────────────────────────────────────

export function buildVoxelFragment(
    atlas: ArrayTexture,
    texAnimBuffer: GpuBuffer,
    vTexIndex: Node<d.f32>,
    vUv: Node<d.vec2f>,
    vLight: Node<d.vec3f>,
    vNormal: Node<d.vec3f>,
    sunDirection: Node<d.vec3f>,
    sunIntensity: Node<d.f32>,
    ambientMinimum: Node<d.vec3f>,
) {
    // texture animation
    const texAnimData = storage(texAnimBuffer, 'read');
    const baseLayer = i32(vTexIndex).toVar('baseLayer');
    const animInfo = texAnimData.element(baseLayer).toVar('animInfo');
    const frameCount = animInfo.x;
    const fps = animInfo.y;
    const doInterpolate = animInfo.z;

    const t = mul(elapsedTime, fps).toVar('animT');
    const frameF = floor(t).mod(frameCount).toVar('frameF');
    const nextFrameF = add(frameF, f32(1.0)).mod(frameCount).toVar('nextFrameF');

    const layerA = add(vTexIndex, frameF).toI32().toVar('layerA');
    const layerB = add(vTexIndex, nextFrameF).toI32().toVar('layerB');
    const interpFrac = fract(t).toVar('interpFrac');

    const colorA = arrayTexture(atlas, layerA).sample(vUv).toVar('colorA');
    const colorB = arrayTexture(atlas, layerB).sample(vUv).toVar('colorB');

    const mixFactor = mul(doInterpolate, interpFrac).toVar('mixFactor');
    const texColor = (mix(colorA, colorB, mixFactor) as Node<d.vec4f>).toVar('texColor');

    // lighting — per-face directional shade is folded into vLight
    // vertex-side (see vertex shader's aoMul). sunShade and ambient
    // floor stay per-fragment because they depend on vNormal vs sun.
    const ndotl = max(dot(vNormal, sunDirection), f32(0.0)).toVar('ndotl');
    const sunShade = mix(sub(f32(1.0), sunIntensity), f32(1.0), ndotl).toVar('sunShade');

    const light = max(mul(vLight, sunShade), ambientMinimum).toVar('light');

    const rgb = mul(texColor.rgb, light).toVar('rgb');
    const fragColor = vec4(rgb, texColor.a).toVar('fragColor');

    return { fragColor, texColor };
}

// ── pass-specific Material wiring ───────────────────────────────────

export function makePassMaterial(opts: {
    name: string;
    pass: VoxelPass;
    clipPos: Node<d.vec4f>;
    fragColor: Node<d.vec4f>;
    texColor: Node<d.vec4f>;
}): Material {
    const { name, pass, clipPos, fragColor, texColor } = opts;

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
        const alphaCutout = Fn(
            (color, alpha) => {
                If(alpha.lessThan(f32(0.5)), () => {
                    Discard();
                });
                return color;
            },
            {
                name: 'alphaCutout',
                params: [
                    { name: 'color', type: d.vec4f },
                    { name: 'alpha', type: d.f32 },
                ],
            },
        );
        const fragment = alphaCutout(fragColor, texColor.a);
        return new Material({
            name,
            vertex: clipPos,
            fragment,
            cullMode: 'back',
            depthTest: true,
            depthWrite: true,
        });
    }

    // translucent
    return new Material({
        name,
        vertex: clipPos,
        fragment: fragColor,
        transparent: true,
        cullMode: 'none',
        depthTest: true,
        depthWrite: false,
    });
}

// ── createQuadMaterial — unified VS for all 3 passes ────────────────
//
// VS reads `visibleQuads[instanceIndex]` → (slot, localIdx), looks up
// `chunkInfo[slot]` → (origin, arenaBase), computes the absolute
// `realQuadId = arenaBase + localIdx`, decodes per-corner position +
// uv + flags, and applies vertex animation + standard MVP.
//
// drawIndirect shape (per pass): vertexCount=6, instanceCount=visibleQuadCount.
// each instance is exactly one quad (6 verts, 2 tris).
//
// per-name storage bindings (must be set on the chunk geometry):
//   'quads'         — shared quadArena.quads (interleaved header+light, stride=14 u32)
//   'visibleQuads'  — this pass's GPU-built per-quad table
//   'chunkInfo'     — per-room ChunkInfo side-table (slot → {origin, arenaBase})
//   'env'           — per-room EnvConfig

export function createQuadMaterial(opts: { atlas: ArrayTexture; texAnimBuffer: GpuBuffer; pass: VoxelPass }): Material {
    const { atlas, texAnimBuffer, pass } = opts;

    // ── per-name storage bindings ───────────────────────────────────
    const quads = storage('quads', d.array(d.u32), 'read');
    const visibleQuads = storage('visibleQuads', d.array(VisibleQuad), 'read');
    const chunkInfo = storage('chunkInfo', d.array(ChunkInfo), 'read');

    // ── per-instance visible quad ───────────────────────────────────
    const visEntry = visibleQuads.element(instanceIndex);
    const slot = visEntry.field('slot').toVar('slot');
    const localIdx = visEntry.field('localIdx').toVar('localIdx');
    const info = chunkInfo.element(slot);
    const sectionOrigin = info.field('origin').toVar('sectionOrigin');
    const arenaBase = info.field('arenaBase').toVar('arenaBase');
    const realQuadId = add(arenaBase, localIdx).toVar('realQuadId');

    // vertexIndex is 0..5 directly (6 verts per instance).
    const vertInQuad = vertexIndex.toVar('vertInQuad');

    const headerBase = mul(realQuadId, u32(QUAD_STRIDE_U32S)).toVar('quadHeaderBase');
    const flags = index(quads, add(headerBase, u32(8))).toVar('qdFlags');
    const meta = index(quads, add(headerBase, u32(META_OFFSET))).toVar('qdMeta');

    const { texIndex, animType } = decodeQuadFlags(flags);

    // ── diagFlip from corner-0 of the per-corner light slot (bit 29) ─
    // meshChunk's emitQuadLight* helpers write the Sodium hierarchical-
    // compare decision there. needs to land before pickCornerIdx because
    // it selects which corner this vertex pulls from.
    const lightBase = add(headerBase, u32(QUAD_LIGHT_OFFSET)).toVar('lightBase');
    const corner0Light = index(quads, lightBase).toVar('corner0Light');
    const diagFlip = corner0Light.shiftRight(u32(29)).bitwiseAnd(u32(1)).toVar('diagFlip');

    const cornerIdx = pickCornerIdx(diagFlip, vertInQuad);
    const { u3, chunkLocalByte, uv, modelNormal: normal } = decodeQuadCorner(quads, realQuadId, cornerIdx);
    // inverse of mesher pos16's 255/16 scale: byte 0 → 0, byte 255 → 16.
    const chunkLocal = chunkLocalByte.mul(f32(16.0 / 255.0)).toVar('chunkLocal');

    // ── per-corner light from the trailing 4 u32 of this quad's slot ─
    const cornerLightOffset = add(lightBase, cornerIdx).toVar('cornerLightOffset');
    const cornerLight = index(quads, cornerLightOffset).toVar('cornerLight');

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
    const animResult = computeVertexAnimation(worldPosBase, blockCenter, animType);
    const xDisp = animResult.x;
    const zDisp = animResult.y;
    const depthBias = animResult.z;

    const worldPos = vec3f(add(worldPosBase.x, xDisp), worldPosBase.y, add(worldPosBase.z, zDisp)).toVar('worldPos');
    const viewPos = mul(cameraViewMatrix, vec4f(worldPos, f32(1.0))).toVar('viewPos');
    const rawClipPos = mul(cameraProjectionMatrix, viewPos).toVar('rawClipPos');
    const clipPos = vec4f(rawClipPos.x, rawClipPos.y, add(rawClipPos.z, depthBias), rawClipPos.w).toVar('clipPos');

    // ── env-derived sky/sun ─────────────────────────────────────────
    const { sunDirection, sunIntensity, skyBrightness, ambientMinimum } = buildEnvSky();

    // Sodium-parity AO: apply aoFactor uniformly regardless of corner
    // brightness. Vanilla MC behavior — AO darkens corners by the same
    // proportion in lit and unlit scenes.
    const rawLight = unpackVoxelLight(cornerLight, skyBrightness).toVar('rawLight');
    const aoMul = mul(aoFactor, faceFactor).toVar('aoMul');
    const voxelLight = rawLight.mul(aoMul).toVar('voxelLightAo');

    // ── varyings ────────────────────────────────────────────────────
    const vTexIndex = varying(texIndex, 'vTexIndex').setInterpolation('flat');
    const vUv = varying(uv, 'vUv');
    const vLight = varying(voxelLight, 'vLight');
    const vNormal = varying(normal, 'vNormal');

    const { fragColor, texColor } = buildVoxelFragment(
        atlas,
        texAnimBuffer,
        vTexIndex,
        vUv,
        vLight,
        vNormal,
        sunDirection,
        sunIntensity,
        ambientMinimum,
    );

    return makePassMaterial({
        name: `voxel-quad-${pass}`,
        pass,
        clipPos,
        fragColor,
        texColor,
    });
}
