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

const AMBIENT_MINIMUM: [number, number, number] = [0.04, 0.04, 0.06];

const NIGHT_SKY_BRIGHTNESS = 0.05;
const DAY_SKY_BRIGHTNESS = 0.9;
const DISABLED_SKY_BRIGHTNESS = 1.0;

// corner index per vert packed 2 bits per slot, shifted out by vertInQuad * 2.
export const TRI_DECODE_DEFAULT = 0 | (1 << 2) | (2 << 4) | (0 << 6) | (2 << 8) | (3 << 10);
export const TRI_DECODE_FLIPPED = 1 | (2 << 2) | (3 << 4) | (1 << 6) | (3 << 8) | (0 << 10);

export type VoxelPass = 'opaque' | 'transparent' | 'translucent';

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

    // sky and block combine additively (clamped) so block light fills sky shadow.
    const skyContrib = vec3f(mul(lightSky, skyBrightness), mul(lightSky, skyBrightness), mul(lightSky, skyBrightness)).toVar(
        'skyContrib',
    );
    const blockLight = vec3f(lightR, lightG, lightB).toVar('blockLight');
    return min(add(blockLight, skyContrib), vec3f(f32(1.0), f32(1.0), f32(1.0))).toVar('voxelLight');
}

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
            // sign-not-zero: WGSL sign(0) is 0, which would collapse cardinal-face normals.
            const snzU = select(f32(-1.0), f32(1.0), u.greaterThanEqual(f32(0.0)));
            const snzV = select(f32(-1.0), f32(1.0), v.greaterThanEqual(f32(0.0)));
            // both folds must read the pre-fold nx/ny, hence the .toVar()s.
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

/** one u16 out of six packed u32s, low half first: half index corner*3 + axis. */
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

// returns vec3f(xDisp, zDisp, depthBias) for the given anim type; animType=0 is all zeros.
export const computeVertexAnimation = Fn(
    (worldPos, blockCenter, animType, elapsedTime) => {
        const xDisp = Var('xDisp', f32(0.0));
        const zDisp = Var('zDisp', f32(0.0));
        const depthBias = Var('depthBias', f32(0.0));
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
                // phase the whole block coherently so crossed-plant diagonals agree at shared corners.
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

/** vertInQuad (0..5) to corner index (0..3) via 2-bit LUT, picked by diagFlip. */
export function pickCornerIdx(diagFlip: Node<d.u32>, vertInQuad: Node<d.u32>) {
    const decode = select(u32(TRI_DECODE_FLIPPED), u32(TRI_DECODE_DEFAULT), diagFlip.equal(u32(0))).toVar('triDecode');
    return decode
        .shiftRight(mul(vertInQuad, u32(2)))
        .bitwiseAnd(u32(3))
        .toVar('cornerIdx');
}

/** flags word layout: texIndex(16) | animType(4) | facing(3) | emissive(1) | unshaded(1) | reserved(7). */
export function decodeQuadFlags(flags: Node<d.u32>) {
    const texIndex = flags.bitwiseAnd(u32(0xffff)).toF32().toVar('texIndex');
    const animType = flags.shiftRight(u32(16)).bitwiseAnd(u32(0xf)).toVar('animType');
    const emissive = flags.shiftRight(u32(23)).bitwiseAnd(u32(1)).toVar('emissive');
    const unshaded = flags.shiftRight(u32(24)).bitwiseAnd(u32(1)).toVar('unshaded');
    return { texIndex, animType, emissive, unshaded };
}

/** decodes the per-corner raw position, uv, and oct16 normal for `realQuadId`. */
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

/** mean of the quad's 4 corner positions, in chunk-local voxels. */
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

// inverse of the mesher's posEncode: voxels = half * POS_DECODE_SCALE - POS_DECODE_ORIGIN.
export const POS_DECODE_SCALE = 1 / 2048;
export const POS_DECODE_ORIGIN = 8;

// alpha cutoff for the translucent layer.
const TRANSLUCENT_ALPHA_MIN = 0.0001;

/** taps along the derivative ellipse's major axis. This is also the anisotropy cap: N taps
 *  can cover a footprint N times longer than it is wide before the LOD has to blur. */
const ANISO_TAPS = 4;

const round = (x: Node<d.vec2f>) => floor(x.add(vec2f(f32(0.5), f32(0.5))));

// frame resolution runs in the vertex stage: the current and next frame's rects, and the mix between them.
// atlas albedo at `vUv` for `texIndex`: frames resolved in the vertex stage, texel-snapped up close and anisotropically averaged under minification.
export function sampleVoxelAlbedo(
    textures: VoxelTextures,
    texIndex: Node<d.f32>,
    vUv: Node<d.vec2f>,
    elapsedTime: Node<d.f32>,
): Node<d.vec4f> {
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

    // vUv already carries the mesher's quarter-texel shrink that keeps a nearest tap inside its own tile.
    const pixelSize = textures.texelSize;
    const uvA = (vRectA.xy.add(vUv.mul(vRectA.zw)) as Node<d.vec2f>).toVar('uvA');
    const uvB = (vRectB.xy.add(vUv.mul(vRectB.zw)) as Node<d.vec2f>).toVar('uvB');

    // both frames' rects are the same size, so one derivative pair serves both.
    const du = dpdx(uvA).toVar('vmDu');
    const dv = dpdy(uvA).toVar('vmDv');
    const texelScreen = max(sqrt(du.mul(du).add(dv.mul(dv))), vec2f(f32(1e-8), f32(1e-8))).toVar('vmTexelScreen');

    const tex = texture(textures.atlas);

    // snaps toward the texel centre by the texel's screen size; the hardware picks the mip level.
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

    // Anisotropic averaging, done here rather than by the sampler: WebGPU only honours
    // maxAnisotropy with linear filters, and linear filtering an atlas with no gutters
    // bleeds across tiles. Nearest never leaves its own texel, so this stays bleed-free
    // and the atlas stays tight, the same trade MC's Stitcher makes.
    const duLen = max(length(du), f32(1e-8)).toVar('vmDuLen');
    const dvLen = max(length(dv), f32(1e-8)).toVar('vmDvLen');
    const minorLen = min(duLen, dvLen).toVar('vmMinorLen');
    const majorLen = max(duLen, dvLen).toVar('vmMajorLen');
    const minPixelSize = min(pixelSize.x, pixelSize.y).toVar('vmMinPixelSize');

    // the major axis as a uv-space vector; its length is already the footprint's long side.
    const majorAxis = select(dv, du, duLen.greaterThanEqual(dvLen)).toVar('vmMajorAxis');

    // LOD is the minor axis's level, raised only as far as ANISO_TAPS taps cannot cover the
    // major axis. Head-on the second term loses and this is the plain isotropic level; at a
    // grazing angle it holds the level ANISO_TAPS times sharper than an isotropic pick.
    const lodMinor = log2(minorLen.div(minPixelSize)).toVar('vmLodMinor');
    const lodCover = log2(majorLen.div(minPixelSize.mul(f32(ANISO_TAPS)))).toVar('vmLodCover');
    const lod = clamp(max(lodMinor, lodCover), f32(0), f32(ATLAS_MIP_LEVELS)).toVar('vmLod');

    // taps spread across the whole footprint, so each lands in a different texel once the
    // surface is minified. Sodium's rotated grid is fixed at a fraction of a level-0 texel,
    // which collapses to a single sample at exactly the distances that shimmer.
    const sampleAniso = (uv: Node<d.vec2f>, name: string): Node<d.vec4f> => {
        let sum: Node<d.vec4f> | null = null;
        for (let i = 0; i < ANISO_TAPS; i++) {
            const offset = (i + 0.5) / ANISO_TAPS - 0.5;
            const tapUv = uv.add(majorAxis.mul(f32(offset))).toVar(`${name}TapUv${i}`);
            const tap = tex.sample(tapUv).level(lod).toVar(`${name}Tap${i}`);
            sum = sum ? (sum.add(tap) as Node<d.vec4f>) : tap;
        }
        return sum!.mul(f32(1 / ANISO_TAPS)).toVar(`${name}Aniso`);
    };

    // hand over to the averaged taps across the same one-to-two texels per pixel window
    // Sodium uses, where minification starts to alias.
    const maxTexelSize = max(texelScreen.x, texelScreen.y).toVar('vmMaxTexelSize');
    const anisoBlend = smoothstep(minPixelSize, minPixelSize.mul(f32(2)), maxTexelSize).toVar('vmAnisoBlend');

    const sampleAtlas = (uv: Node<d.vec2f>, name: string): Node<d.vec4f> => {
        const nearest = sampleNearest(uv, name);
        const aniso = sampleAniso(uv, name);
        return (mix(nearest, aniso, anisoBlend) as Node<d.vec4f>).toVar(name);
    };

    const colorA = sampleAtlas(uvA, 'colorA');
    const colorB = sampleAtlas(uvB, 'colorB');
    return (mix(colorA, colorB, vMixFactor) as Node<d.vec4f>).toVar('texColor');
}

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
    const texColor = sampleVoxelAlbedo(textures, texIndex, vUv, elapsedTime);

    // sunShade and the ambient floor stay per-fragment since they depend on vNormal vs sun.
    const ndotl = max(dot(vNormal, sunDirection), f32(0.0)).toVar('ndotl');
    const sunShade = mix(sub(f32(1.0), sunIntensity), f32(1.0), ndotl).toVar('sunShade');

    const light = max(mul(vLight, sunShade), ambientMinimum).toVar('light');

    const rgb = mul(texColor.rgb, light).toVar('rgb');
    const fragColor = vec4(rgb, texColor.a).toVar('fragColor');

    // returned so per-instance traits can tint albedo before lighting; the chunk path ignores it.
    return { fragColor, texColor, light };
}

// drops fully transparent fragments so an invisible texel never writes blend or sort work.
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

export function makePassMaterial(opts: {
    name: string;
    pass: VoxelPass;
    clipPos: Node<d.vec4f>;
    fragColor: Node<d.vec4f>;
    texColor: Node<d.vec4f>;
    // per-instance screen-door fade for the cutout pass; default is a pure cutout.
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

// backend-neutral shading core: reads the quad, applies vertex animation and MVP, builds the pass Material.
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

    // diagFlip from the meta word (bit 16).
    const diagFlip = meta.shiftRight(u32(QUAD_META_DIAG_FLIP_BIT)).bitwiseAnd(u32(1)).toVar('diagFlip');

    const cornerIdx = pickCornerIdx(diagFlip, vertInQuad);
    const { u3, chunkLocalByte, uv, modelNormal: normal } = decodeQuadCorner(quads, realQuadId, cornerIdx);
    // inverse of mesher pos16's 255/16 scale: byte 0 -> 0, byte 255 -> 16.
    const chunkLocal = chunkLocalByte.mul(f32(POS_DECODE_SCALE)).sub(f32(POS_DECODE_ORIGIN)).toVar('chunkLocal');

    // per-corner AO: 4-bit quantized brightness, bits/30 + 0.5 maps 0..15 to [0.5, 1.0].
    const aoBits = meta
        .shiftRight(mul(cornerIdx, u32(4)))
        .bitwiseAnd(u32(0xf))
        .toVar('aoBits');
    const aoFactor = aoBits.toF32().div(f32(30.0)).add(f32(0.5)).toVar('aoFactor');

    // applied into the AO term, not sky/block light, so a torch under an overhang still lights the underside.
    const sideFactor = abs(normal.x).greaterThan(f32(0.5)).select(f32(0.6), f32(0.8)).toVar('sideFactor');
    const yPosFactor = normal.y.greaterThan(f32(0.5)).select(f32(1.0), sideFactor).toVar('yPosFactor');
    const faceFactor = normal.y.lessThan(f32(-0.5)).select(f32(0.5), yPosFactor).toVar('faceFactor');

    const blockLocalX = u3.shiftRight(u32(16)).bitwiseAnd(u32(0xf)).toF32().toVar('blockLocalX');
    const blockLocalY = u3.shiftRight(u32(20)).bitwiseAnd(u32(0xf)).toF32().toVar('blockLocalY');
    const blockLocalZ = u3.shiftRight(u32(24)).bitwiseAnd(u32(0xf)).toF32().toVar('blockLocalZ');
    const blockCenter = vec3f(
        add(add(sectionOrigin.x, blockLocalX), f32(0.5)),
        add(add(sectionOrigin.y, blockLocalY), f32(0.5)),
        add(add(sectionOrigin.z, blockLocalZ), f32(0.5)),
    ).toVar('blockCenter');

    const worldPosBase = add(sectionOrigin, chunkLocal).toVar('worldPosBase');
    const animResult = computeVertexAnimation(worldPosBase, blockCenter, animType, elapsedTime);
    const xDisp = animResult.x;
    const zDisp = animResult.y;
    const depthBias = animResult.z;

    const worldPos = vec3f(add(worldPosBase.x, xDisp), worldPosBase.y, add(worldPosBase.z, zDisp)).toVar('worldPos');
    const viewPos = mul(cameraViewMatrix, vec4f(worldPos, f32(1.0))).toVar('viewPos');
    const rawClipPos = mul(cameraProjectionMatrix, viewPos).toVar('rawClipPos');
    const clipPos = vec4f(rawClipPos.x, rawClipPos.y, add(rawClipPos.z, depthBias), rawClipPos.w).toVar('clipPos');

    const { sunDirection, sunIntensity, skyBrightness, ambientMinimum } = buildEnvSky(env);

    // reads only the four light-volume cells on this face's own side, so light can't leak across a corner diagonal.
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
    // unshaded quads keep AO but drop face shade, so a clump reads as one mass instead of lit cards.
    const shadeMul = unshaded.equal(u32(1)).select(f32(1.0), faceFactor).toVar('shadeMul');
    const aoMul = emissive.equal(u32(1)).select(f32(1.0), mul(aoFactor, shadeMul)).toVar('aoMul');
    const voxelLight = rawLight.mul(aoMul).toVar('voxelLightAo');

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

// WebGPU resolver: realQuadId = chunkInfo[visibleQuads[instanceIndex].slot].arenaBase + localIdx.
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

// WebGL resolver: realQuadId = instanceIndex; section origin comes from chunkInfo[quadSlot[realQuadId]].
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
