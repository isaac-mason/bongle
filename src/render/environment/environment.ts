/**
 * environment, sky, sun, moon, stars, clouds.
 *
 * the GPU side is engine-global: three `frameGroup` UBOs (`envTime`, `envConfig`,
 * `envSky`) live on `EnvironmentResources`, wrapped once as shared nodes
 * (`timeNode`/`cfgNode`/`skyNode`) that every env-aware material captures
 * value-based (no per-geometry binding). the CPU side is per-room: each
 * `Environment` holds its own `_config` / `_sky` shadow that `setEnvironment`
 * mutates without touching GPU state, plus a `time`. only the active room's
 * `updateForCamera` flush points the shared UBOs at its shadow each frame, and
 * `flushActive` does the same on room activation.
 *
 *   `envTime`, per-frame values (`time` time-of-day [0,1), `wallTime` monotonic
 *              seconds); split into their own tiny UBO so only these re-pack each
 *              frame. `envConfig`, rarely-changing knobs (sun/star/cloud config +
 *              master `enabled`). `envSky`, 4-stop sky LUT (12 vec3).
 *
 * values are handed to the UBOs as objects / nested arrays; gpucat packs each per
 * backend at bind ('wgsl-uniform' on WebGPU, 'std140' on WebGL), so this file
 * carries no layout — the same code drives both backends.
 *
 * the sky sphere material paints only the cheap, full-screen part (LUT gradient +
 * horizon sun-wash); sun/moon/stars are instanced billboards. voxel + model + cloud
 * materials capture the same `timeNode`/`cfgNode`, so one env write animates the
 * whole active room's sky + world.
 */

import * as gpu from 'gpucat';
import type { Vec3 } from 'mathcat';
import {
    buildConfigObject,
    buildSkyValue,
    type Environment,
    type ResolvedEnvironment,
    SKY_STOPS,
} from '../../client/environment';
import { srgbBytesToLinear } from '../../core/color';
import type { TimeResources } from '../time';
import type * as CloudResources from './clouds/cloud-resources';
import * as CloudVisuals from './clouds/cloud-visuals';

/* ── types ────────────────────────────────────────────────────────── */

/**
 * engine-global env GPU handles + the shared shader nodes every env-aware
 * material captures. The env binding is value-based now (materials capture
 * `cfgNode`/`skyNode` directly), not name-based per-geometry; `envConfig`/`envSky`
 * are `frameGroup` UBOs (one std140 uniform bound once per frame, works on both
 * backends). Inferred from `createEnvironmentResources` to avoid hand-writing
 * gpucat's generic node/uniform types.
 */
export type EnvironmentResources = ReturnType<typeof createEnvironmentResources>;

/**
 * Active-room environment RENDER state — owned by the renderer (built + torn down
 * as it reconciles its active-room slot). The engine-global `EnvironmentResources`
 * + `CloudResources` it draws with are NOT stored here; the renderer threads them
 * into the flush (it owns them).
 */
export type EnvVisuals = {
    /** per-room sky sphere (added to room.scene). */
    skyMesh: gpu.Mesh;
    /** per-room sun + moon billboard pair (2 instances). */
    sunMoonMesh: gpu.Mesh;
    /** per-room star-field billboards (`STAR_COUNT` instances). */
    starMesh: gpu.Mesh;
    /** per-room scene anchor for the engine-global cloud system (Mesh + Scene;
     *  heavy state lives on `CloudResources`). The CPU cull runs in
     *  `updateForCamera` and writes the *shared* compacted instance buffer;
     *  safe because only the active room renders per frame. */
    clouds: CloudVisuals.CloudVisuals;
};

/* ── GPU struct layout ────────────────────────────────────────────── */

// `enabled` (in EnvConfig) is a u32 mask read by sky + voxel materials.
// 0 = sky mesh effectively transparent, voxel skyBrightness pinned to 1.0.

/** per-frame env values (change every frame) — split from the rarely-changing
 *  config so only these two floats re-pack each frame (frameGroup UBO). */
export const EnvTime = gpu.struct('EnvTime', {
    time: gpu.d.f32,
    wallTime: gpu.d.f32,
});

/** rarely-changing env config (updated only on `setEnvironment`/`setTime`). */
export const EnvConfig = gpu.struct('EnvConfig', {
    enabled: gpu.d.u32,
    sunEnabled: gpu.d.u32,
    sunIntensity: gpu.d.f32,
    moonEnabled: gpu.d.u32,
    starsEnabled: gpu.d.u32,
    starsDensity: gpu.d.f32,
    cloudsEnabled: gpu.d.u32,
    cloudsDensity: gpu.d.f32,
    cloudsWindX: gpu.d.f32,
    cloudsWindY: gpu.d.f32,
    cloudsAltitude: gpu.d.f32,
    cloudsThickness: gpu.d.f32,
});

const SKY_VEC3_PER_STOP = 3; // zenith, horizon, nadir
const SKY_VEC3_COUNT = SKY_STOPS * SKY_VEC3_PER_STOP;

/* ── hardcoded constants ──────────────────────────────────────────── */

// authored as sRGB and decoded to linear so voxel textures (which the
// atlas decodes on sample) and these billboard tints agree on what e.g.
// "orange" is. see luanti `skyparams.h` for the source values.
const SUN_COLOR: Vec3 = srgbBytesToLinear(255, 255, 255);
const MOON_COLOR: Vec3 = srgbBytesToLinear(229, 229, 255); // ~#e5e5ff
const STAR_COLOR: Vec3 = srgbBytesToLinear(255, 255, 255);
const FOG_SUN_TINT: Vec3 = srgbBytesToLinear(244, 125, 29); // #f47d1d
// deeper red that the sun tint blends toward as the sun approaches the
// horizon. drives the dramatic flare at sunrise / sunset peak.
const SUNSET_DEEP_TINT: Vec3 = srgbBytesToLinear(255, 70, 30); // #ff461e

// sun + moon are camera-facing square billboards on the far sphere.
// HALF_SIZE is the angular half-extent (≈ chord on the unit sphere).
// EDGE_FEATHER is the smoothstep band that keeps the square edges crisp
// without MSAA aliasing.
const SUN_HALF_SIZE = 0.05;
const MOON_HALF_SIZE = 0.045;
const BODY_EDGE_FEATHER = 0.12;

// stars are camera-facing round-dot billboards on the far sphere, baked
// once. STAR_COUNT is the pool size; the live `starsDensity` config gates
// what fraction is visible (per-star `gate` vs density in the shader).
const STAR_COUNT = 2000;
const STAR_TWINKLE_SPEED = 2.2;
const STAR_MIN_SIZE = 0.0035;
const STAR_SIZE_SPREAD = 0.0035;
const STAR_DOT_RADIUS = 0.8;
const STAR_DOT_FEATHER = 0.35;

/* ── sky-body instance layouts (sun/moon + stars) ─────────────────── */

/** one per celestial body (2 instances: sun, moon). `kind` 0=sun, 1=moon
 *  selects direction/enable/fade in the shader; direction itself is
 *  derived from `EnvConfig.time`, so this buffer is baked once. */
export const SkyBodyInstance = gpu.struct('SkyBodyInstance', {
    color: gpu.d.vec3f,
    kind: gpu.d.f32,
    halfSize: gpu.d.f32,
});

/** one per star. all fields static; twinkle/night-fade/density read
 *  `EnvConfig` in the shader, so the buffer is baked once and never
 *  updated. `gate` is a uniform random in [0,1) compared against
 *  `starsDensity`; `phase` in [0,1) offsets the twinkle sine. */
export const StarInstance = gpu.struct('StarInstance', {
    dir: gpu.d.vec3f,
    size: gpu.d.f32,
    brightness: gpu.d.f32,
    phase: gpu.d.f32,
    gate: gpu.d.f32,
});

/* ── value builders ───────────────────────────────────────────────────
 * we hand the Uniforms structured VALUES (objects / nested arrays), not
 * pre-packed bytes; gpucat packs each per backend at bind ('wgsl-uniform' on
 * WebGPU, 'std140' on WebGL). so there's no layout to manage here.
 */

/* ── resources (engine-global) ────────────────────────────────────── */

/**
 * allocate the engine-global env buffers, seeded from `initial`. shape
 * and sizing are fixed once here, every per-room `Environment` flushes
 * into the same two buffers; only one room's state is live on the GPU
 * at a time (the active one).
 */
// node-wrapping helpers, also used to derive the node param types the material
// builders take (ReturnType keeps us off gpucat's raw generics).
function makeTimeNode(u: gpu.Uniform<typeof EnvTime>) {
    return gpu.fields(gpu.uniform(u));
}
function makeCfgNode(u: gpu.Uniform<typeof EnvConfig>) {
    return gpu.fields(gpu.uniform(u));
}
function makeSkyNode(u: gpu.Uniform<ReturnType<typeof skyArraySchema>>) {
    return gpu.uniform(u);
}
const skyArraySchema = () => gpu.d.sizedArray(gpu.d.vec3f, SKY_VEC3_COUNT);
type TimeNode = ReturnType<typeof makeTimeNode>;
type CfgNode = ReturnType<typeof makeCfgNode>;
type SkyNode = ReturnType<typeof makeSkyNode>;

export function createEnvironmentResources(initial: ResolvedEnvironment) {
    // frameGroup UBOs: shared uniforms bound once per frame. we set `.value` to
    // structured values (objects / nested arrays); gpucat packs each per backend
    // at bind ('wgsl-uniform' on WebGPU, 'std140' on WebGL). `time`/`wallTime` are
    // split into their own tiny UBO so only those re-pack every frame.
    const envTime = new gpu.Uniform(EnvTime, { time: 0.6, wallTime: 0 }, gpu.frameGroup);
    const envConfig = new gpu.Uniform(EnvConfig, buildConfigObject(initial), gpu.frameGroup);
    const envSky = new gpu.Uniform(skyArraySchema(), buildSkyValue(initial.sky.stops), gpu.frameGroup);

    // shared nodes captured (value-based) by every env-aware material.
    const timeNode = makeTimeNode(envTime);
    const cfgNode = makeCfgNode(envConfig);
    const skyNode = makeSkyNode(envSky);

    // engine-global, baked-once per-instance data for the sun/moon + star billboards
    // (static; identical every room). captured by the materials as instanced vertex
    // attributes (a raw Float32Array — no GpuBuffer, no per-frame update), so they
    // work on both backends.
    const skyBodyData = bakeSkyBodyInstances();
    const starData = bakeStarInstances();

    // env-owned materials, built once and stored here (no module-scope caches).
    const skyMaterial = buildSkyMaterial(timeNode, cfgNode, skyNode);
    const skyBodyMaterial = buildSkyBodyMaterial(timeNode, cfgNode, skyBodyData);
    const starMaterial = buildStarMaterial(timeNode, cfgNode, starData);

    return { envTime, envConfig, envSky, timeNode, cfgNode, skyNode, skyMaterial, skyBodyMaterial, starMaterial };
}

export function disposeResources(_res: EnvironmentResources): void {
    // frameGroup UBOs live for the engine lifetime (env is engine-global, never
    // rebuilt mid-session); the group owns the underlying buffer. nothing to free.
}

/* ── sky shader ───────────────────────────────────────────────────── */

const {
    f32,
    u32,
    vec2f,
    vec3f,
    vec4f,
    mix,
    mul,
    add,
    sub,
    dot,
    cos,
    sin,
    abs,
    pow,
    floor,
    sqrt,
    clamp,
    smoothstep,
    step,
    max,
    normalize,
    attribute,
    varying,
    cameraProjectionMatrix,
    cameraViewMatrix,
    d,
} = gpu;

/** far-plane billboard basis: expand a unit direction `dir` by the quad's
 *  local plane offset (`aPos` in [-0.5,0.5]) along the camera's world
 *  right/up, transform as a direction (w=0, camera-locked like the sky
 *  sphere), and pin z=w so the body sits on the far plane. `fullSize` is
 *  the full angular extent (2× the half-size). */
function billboardFarPlaneVertex(
    dir: gpu.Node<typeof gpu.d.vec3f>,
    aPos: gpu.Node<typeof gpu.d.vec3f>,
    fullSize: gpu.Node<typeof gpu.d.f32>,
): gpu.Node<typeof gpu.d.vec4f> {
    const view = cameraViewMatrix;
    const col0 = view.element(u32(0)).toVar('bbCol0');
    const col1 = view.element(u32(1)).toVar('bbCol1');
    const col2 = view.element(u32(2)).toVar('bbCol2');
    const right = vec3f(col0.x, col1.x, col2.x).toVar('bbRight');
    const up = vec3f(col0.y, col1.y, col2.y).toVar('bbUp');

    const offX = mul(aPos.x, fullSize).toVar('bbOffX');
    const offY = mul(aPos.y, fullSize).toVar('bbOffY');
    const cornerDir = add(dir, add(mul(right, offX), mul(up, offY))).toVar('bbCornerDir');
    const viewDir = mul(cameraViewMatrix, vec4f(cornerDir, f32(0))).toVar('bbViewDir');
    const clip = mul(cameraProjectionMatrix, vec4f(viewDir.xyz, f32(1))).toVar('bbClip');
    return vec4f(clip.x, clip.y, clip.w, clip.w);
}

/**
 * engine-global sky material. shader reads env via name-based storage,
 * each per-room mesh resolves the `env` + `envSky` buffer names through
 * its own geometry, so one compiled pipeline serves every room. lazy-
 * initialized on first `createSkyMesh` call (must run after the WebGPU
 * device is up, since gpu.Material constructs nodes that touch the
 * shader graph).
 */
function buildSkyMaterial(timeNode: TimeNode, cfgNode: CfgNode, skyNode: SkyNode): gpu.Material {
    const cfg = cfgNode;
    const skyArr = skyNode;
    const tNode = timeNode.time;

    // ── vertex ──
    // pin the sphere to the far plane (background trick), and compute every
    // uniform-only sky scalar here (per-vertex, ~1k verts) so the fragment
    // (millions of pixels) does none of it. sun/moon/stars are separate
    // billboards now — this shader only paints the gradient + horizon wash.
    const pos = attribute('position', d.vec3f);
    const viewPos = mul(cameraViewMatrix, vec4f(pos, f32(0))).toVar('viewPos');
    const clipPos = mul(cameraProjectionMatrix, vec4f(viewPos.xyz, f32(1))).toVar('clipPos');
    const vertex = vec4f(clipPos.x, clipPos.y, clipPos.w, clipPos.w).toVar('vertex');

    const dir = varying(normalize(pos), 'vDir');

    // LUT interp by time-of-day → current zenith/horizon/nadir colours.
    // depends only on `time`, so it's flat across the sphere.
    const scaled = mul(tNode, f32(4)).toVar('lutScaled');
    const segF = floor(scaled).toVar('lutSegF');
    const fracT = sub(scaled, segF).toVar('lutFracT');
    const segA = segF.toU32().mod(u32(SKY_STOPS)).toVar('lutSegA');
    const segB = add(segA, u32(1)).mod(u32(SKY_STOPS)).toVar('lutSegB');
    const aBase = mul(segA, u32(SKY_VEC3_PER_STOP)).toVar('lutABase');
    const bBase = mul(segB, u32(SKY_VEC3_PER_STOP)).toVar('lutBBase');
    const zenith = varying(mix(skyArr.element(aBase), skyArr.element(bBase), fracT), 'vZenith').setInterpolation('flat');
    const horizon = varying(
        mix(skyArr.element(add(aBase, u32(1))), skyArr.element(add(bBase, u32(1))), fracT),
        'vHorizon',
    ).setInterpolation('flat');
    const nadir = varying(
        mix(skyArr.element(add(aBase, u32(2))), skyArr.element(add(bBase, u32(2))), fracT),
        'vNadir',
    ).setInterpolation('flat');

    // sun direction (t=0.25 sunrise east, 0.5 noon up) + sunset atmospherics.
    const TAU = f32(Math.PI * 2);
    const sunAngle = mul(sub(tNode, f32(0.25)), TAU).toVar('sunAngle');
    const sunDir = vec3f(cos(sunAngle), sin(sunAngle), f32(0)).toVar('sunDir');
    const sunDirV = varying(sunDir, 'vSunDir').setInterpolation('flat');

    // sunset peaks when the sun sits right at the horizon; drives a redder,
    // stronger, wider horizon wash and a dimmer rest-of-sky.
    const sunsetNear = sub(f32(1), clamp(mul(abs(sunDir.y), f32(3.5)), f32(0), f32(1))).toVar('sunsetNear');
    const sunAboveGate = smoothstep(f32(-0.12), f32(0.08), sunDir.y).toVar('sunAboveGate');
    const sunsetFactor = mul(sunsetNear, sunAboveGate).toVar('sunsetFactor');

    // single-term wash: tight warm halo around the sun that widens at dusk.
    const glowPowV = varying(mix(f32(8), f32(5), sunsetFactor), 'vGlowPow').setInterpolation('flat');
    const glowStrengthV = varying(mix(f32(0.4), f32(0.95), sunsetFactor), 'vGlowStrength').setInterpolation('flat');
    const skyDimV = varying(sub(f32(1), mul(sunsetFactor, f32(0.35))), 'vSkyDim').setInterpolation('flat');
    const sunTintBase = vec3f(f32(FOG_SUN_TINT[0]), f32(FOG_SUN_TINT[1]), f32(FOG_SUN_TINT[2]));
    const sunTintDeep = vec3f(f32(SUNSET_DEEP_TINT[0]), f32(SUNSET_DEEP_TINT[1]), f32(SUNSET_DEEP_TINT[2]));
    const sunTintV = varying(mix(sunTintBase, sunTintDeep, sunsetFactor), 'vSunTint').setInterpolation('flat');
    const sunEnabledV = varying(cfg.sunEnabled.toF32(), 'vSunEnabled').setInterpolation('flat');
    const enabledMaskV = varying(cfg.enabled.toF32(), 'vEnabledMask').setInterpolation('flat');

    // ── fragment: vertical gradient + a single-term horizon sun-wash ──
    const y = dir.y;
    const above = step(f32(0), y).toVar('above');
    const tUp = smoothstep(f32(0), f32(1), clamp(abs(y), f32(0), f32(1))).toVar('tUp');
    const skyAbove = mix(horizon, zenith, tUp).toVar('skyAbove');
    const skyBelow = mix(horizon, nadir, tUp).toVar('skyBelow');
    const baseSky = mix(skyBelow, skyAbove, above).toVar('baseSky');

    const cdotSun = clamp(dot(dir, sunDirV), f32(0), f32(1)).toVar('cdotSun');
    const horizonBand = sub(f32(1), clamp(mul(abs(y), f32(2.5)), f32(0), f32(1))).toVar('horizonBand');
    const glow = clamp(mul(mul(mul(pow(cdotSun, glowPowV), glowStrengthV), horizonBand), sunEnabledV), f32(0), f32(1)).toVar(
        'sunGlow',
    );

    const tintedSky = mix(mul(baseSky, skyDimV), sunTintV, glow).toVar('tintedSky');
    const final = mul(tintedSky, enabledMaskV).toVar('finalRgb');
    const fragment = vec4f(final, f32(1)).toVar('fragment');

    return new gpu.Material({
        name: 'sky-environment',
        vertex,
        fragment,
        cullMode: 'front',
        depthTest: false,
        depthWrite: false,
    });
}

/* ── sun + moon (instanced billboards) ────────────────────────────── */

/**
 * engine-global sun/moon material: 2 camera-facing square billboards on
 * the far sphere. `kind` (0 sun, 1 moon) selects direction, enable and
 * day/night fade — all derived from `EnvConfig.time` in-shader, so the
 * instance buffer is static. lazy-cached like `getSkyMaterial`.
 */
function buildSkyBodyMaterial(timeNode: TimeNode, cfgNode: CfgNode, skyBodyData: Float32Array): gpu.Material {
    const cfg = cfgNode;
    // per-instance data via instanced vertex attributes (both backends; the data is
    // static, baked once). std430 field offsets: color vec3f@0, kind@12, halfSize@16.
    const stride = gpu.layoutStrideOf(SkyBodyInstance);
    const color = attribute(skyBodyData, d.vec3f, { instanced: true, stride, offset: 0 }).toVar('sbColor');
    const kind = attribute(skyBodyData, d.f32, { instanced: true, stride, offset: 12 }).toVar('sbKind'); // 0 sun, 1 moon
    const halfSize = attribute(skyBodyData, d.f32, { instanced: true, stride, offset: 16 }).toVar('sbHalf');

    // sun/moon directions from time; select by kind (0/1) via mix.
    const TAU = f32(Math.PI * 2);
    const sunAngle = mul(sub(timeNode.time, f32(0.25)), TAU).toVar('sbSunAngle');
    const sunDir = vec3f(cos(sunAngle), sin(sunAngle), f32(0)).toVar('sbSunDir');
    const dir = mix(sunDir, mul(sunDir, f32(-1)), kind).toVar('sbDir');

    // day/night fade: sun visible while up, moon while the sky is dark.
    const nightFactor = clamp(mul(sub(f32(0.3), sunDir.y), f32(2)), f32(0), f32(1)).toVar('sbNight');
    const aboveHorizon = smoothstep(f32(-0.05), f32(0.05), dir.y).toVar('sbAbove');
    const sunAlpha = aboveHorizon.toVar('sbSunAlpha');
    const moonAlpha = mul(aboveHorizon, nightFactor).toVar('sbMoonAlpha');
    const enabledF = mix(cfg.sunEnabled.toF32(), cfg.moonEnabled.toF32(), kind).toVar('sbEnabled');
    const alpha = mul(mul(mix(sunAlpha, moonAlpha, kind), enabledF), cfg.enabled.toF32()).toVar('sbAlpha');

    const aPos = attribute('position', d.vec3f);
    const vertex = billboardFarPlaneVertex(dir, aPos, mul(halfSize, f32(2)));

    const vColor = varying(color, 'sbColorV').setInterpolation('flat');
    const vAlpha = varying(alpha, 'sbAlphaV').setInterpolation('flat');
    const vUv = varying(attribute('uv', d.vec2f), 'sbUv');

    // feathered square: L∞ distance from centre in [-1,1] quad space.
    const c = sub(mul(vUv, f32(2)), vec2f(f32(1), f32(1))).toVar('sbC');
    const dSquare = max(abs(c.x), abs(c.y)).toVar('sbDSquare');
    const edge = sub(f32(1), smoothstep(sub(f32(1), f32(BODY_EDGE_FEATHER)), f32(1), dSquare)).toVar('sbEdge');
    const fragment = vec4f(vColor, mul(edge, vAlpha)).toVar('sbFragment');

    return new gpu.Material({
        name: 'sky-body',
        vertex,
        fragment,
        cullMode: 'none',
        // pinned to the far plane (depth 1.0); `less-equal` lets it draw
        // against the cleared sky while nearer terrain still occludes it.
        depthTest: true,
        depthCompare: 'less-equal',
        depthWrite: false,
        transparent: true,
    });
}

/** 2-instance sun/moon buffer, baked once (colour + angular size per body).
 *  direction/fade are derived in-shader from time. */
function bakeSkyBodyInstances(): Float32Array {
    const stride = gpu.layoutStrideOf(SkyBodyInstance) / 4;
    const out = new Float32Array(2 * stride);
    gpu.packTo(SkyBodyInstance, out, 0, { color: SUN_COLOR, kind: 0, halfSize: SUN_HALF_SIZE });
    gpu.packTo(SkyBodyInstance, out, gpu.layoutStrideOf(SkyBodyInstance), {
        color: MOON_COLOR,
        kind: 1,
        halfSize: MOON_HALF_SIZE,
    });
    return out;
}

function createSkyBodyMesh(res: EnvironmentResources): gpu.Mesh {
    // per-instance data is the engine-global static buffer captured by the material
    // as instanced attributes; the plane geometry + `count` are all the mesh needs.
    const geometry = gpu.createPlaneGeometry(1, 1);
    const mesh = new gpu.Mesh(geometry, res.skyBodyMaterial);
    mesh.name = 'sky-bodies';
    mesh.frustumCulled = false;
    mesh.count = 2;
    mesh.renderOrder = -998;
    return mesh;
}

/* ── stars (instanced billboards) ─────────────────────────────────── */

/**
 * engine-global star material: `STAR_COUNT` camera-facing round-dot
 * billboards on the far sphere. per-star data (dir/size/brightness/phase/
 * gate) is static; twinkle, night fade and the live density gate read
 * `EnvConfig` in-shader, and invisible stars collapse to zero size so
 * daytime costs no fragments. lazy-cached like the others.
 */
function buildStarMaterial(timeNode: TimeNode, cfgNode: CfgNode, starData: Float32Array): gpu.Material {
    const cfg = cfgNode;
    // per-instance data via instanced vertex attributes (static, baked once). std430
    // field offsets: dir vec3f@0, size@12, brightness@16, phase@20, gate@24.
    const stride = gpu.layoutStrideOf(StarInstance);
    const dir = attribute(starData, d.vec3f, { instanced: true, stride, offset: 0 }).toVar('stDir');
    const baseSize = attribute(starData, d.f32, { instanced: true, stride, offset: 12 }).toVar('stSize');
    const brightness = attribute(starData, d.f32, { instanced: true, stride, offset: 16 }).toVar('stBright');
    const phase = attribute(starData, d.f32, { instanced: true, stride, offset: 20 }).toVar('stPhase');
    const gate = attribute(starData, d.f32, { instanced: true, stride, offset: 24 }).toVar('stGate');

    const TAU = f32(Math.PI * 2);
    const sunAngle = mul(sub(timeNode.time, f32(0.25)), TAU).toVar('stSunAngle');
    const sunY = sin(sunAngle).toVar('stSunY');
    const nightFactor = clamp(mul(sub(f32(0.3), sunY), f32(2)), f32(0), f32(1)).toVar('stNight');
    const aboveHorizon = smoothstep(f32(0), f32(0.04), dir.y).toVar('stAbove');
    // live density: a star shows when its baked gate falls under the config.
    const densityVis = step(gate, cfg.starsDensity).toVar('stDensity');
    const starsOn = mul(cfg.starsEnabled.toF32(), cfg.enabled.toF32()).toVar('stOn');
    const vis = mul(mul(mul(nightFactor, aboveHorizon), densityVis), starsOn).toVar('stVis');

    const twinkle = add(
        f32(0.625),
        mul(f32(0.375), sin(add(mul(timeNode.wallTime, f32(STAR_TWINKLE_SPEED)), mul(phase, TAU)))),
    ).toVar('stTwinkle');
    const brightnessOut = mul(mul(brightness, twinkle), vis).toVar('stBrightOut');

    // collapse invisible stars to a degenerate quad → zero fragments.
    const effSize = mul(baseSize, step(f32(0.001), vis)).toVar('stEffSize');

    const aPos = attribute('position', d.vec3f);
    const vertex = billboardFarPlaneVertex(dir, aPos, mul(effSize, f32(2)));

    const vBright = varying(brightnessOut, 'stBrightV').setInterpolation('flat');
    const vUv = varying(attribute('uv', d.vec2f), 'stUv');

    // round dot: radial falloff from the quad centre.
    const c = sub(mul(vUv, f32(2)), vec2f(f32(1), f32(1))).toVar('stC');
    const r = sqrt(dot(c, c)).toVar('stR');
    const dot2 = sub(f32(1), smoothstep(sub(f32(STAR_DOT_RADIUS), f32(STAR_DOT_FEATHER)), f32(STAR_DOT_RADIUS), r)).toVar(
        'stDot',
    );
    const starColor = vec3f(f32(STAR_COLOR[0]), f32(STAR_COLOR[1]), f32(STAR_COLOR[2]));
    const fragment = vec4f(starColor, mul(dot2, vBright)).toVar('stFragment');

    return new gpu.Material({
        name: 'star-field',
        vertex,
        fragment,
        cullMode: 'none',
        // far-plane pinned; `less-equal` draws against the cleared sky and
        // lets terrain occlude stars near the horizon.
        depthTest: true,
        depthCompare: 'less-equal',
        depthWrite: false,
        transparent: true,
    });
}

/** deterministic hash in [0,1) from an integer index + salt. */
function starHash(i: number, salt: number): number {
    let h = (Math.imul(i + 1, 374761393) + Math.imul(salt, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** bake `STAR_COUNT` stars: Fibonacci-sphere directions for even spread,
 *  hashed size/brightness/phase/gate. baked once, identical every room. */
function bakeStarInstances(): Float32Array {
    const stride = gpu.layoutStrideOf(StarInstance);
    const out = new Float32Array((STAR_COUNT * stride) / 4);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < STAR_COUNT; i++) {
        const yUp = 1 - ((i + 0.5) / STAR_COUNT) * 2; // [-1, 1]
        const radius = Math.sqrt(Math.max(0, 1 - yUp * yUp));
        const theta = i * golden;
        gpu.packTo(StarInstance, out, i * stride, {
            dir: [Math.cos(theta) * radius, yUp, Math.sin(theta) * radius],
            size: STAR_MIN_SIZE + starHash(i, 11) * STAR_SIZE_SPREAD,
            brightness: 0.5 + starHash(i, 23) * 0.5,
            phase: starHash(i, 37),
            gate: starHash(i, 53),
        });
    }
    return out;
}

function createStarMesh(res: EnvironmentResources): gpu.Mesh {
    // per-instance data is the engine-global static buffer captured by the material.
    const geometry = gpu.createPlaneGeometry(1, 1);
    const mesh = new gpu.Mesh(geometry, res.starMaterial);
    mesh.name = 'stars';
    mesh.frustumCulled = false;
    mesh.count = STAR_COUNT;
    mesh.renderOrder = -999;
    return mesh;
}

/**
 * per-room sky sphere. material is engine-global (cached); geometry binds
 * this room's env buffers by name so the shared shader resolves to per-
 * room storage at render time.
 */
function createSkyMesh(res: EnvironmentResources): gpu.Mesh {
    const geometry = gpu.createSphereGeometry(1, 32, 32);
    // env is bound value-based (the material captured `res.cfgNode`/`res.skyNode`);
    // no per-geometry env buffer.

    const mesh = new gpu.Mesh(geometry, res.skyMaterial);
    mesh.name = 'sky';
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000;
    return mesh;
}

/* ── lifecycle ────────────────────────────────────────────────────── */

/**
 * Build a room's env RENDER state (sky/sun/moon/star meshes + cloud anchor),
 * added to `scene`. Owned by the renderer; drawn with the engine-global
 * `resources` + `cloudResources` (threaded into `updateForCamera`, not stored).
 */
export function initEnvVisuals(
    scene: gpu.Scene,
    resources: EnvironmentResources,
    cloudResources: CloudResources.CloudResources,
): EnvVisuals {
    const skyMesh = createSkyMesh(resources);
    scene.add(skyMesh);
    const starMesh = createStarMesh(resources);
    scene.add(starMesh);
    const sunMoonMesh = createSkyBodyMesh(resources);
    scene.add(sunMoonMesh);
    const clouds = CloudVisuals.init(scene, cloudResources);
    return { skyMesh, sunMoonMesh, starMesh, clouds };
}

export function disposeEnvVisuals(vis: EnvVisuals): void {
    vis.skyMesh.removeFromParent();
    vis.sunMoonMesh.removeFromParent();
    vis.starMesh.removeFromParent();
    // sky/body/star materials + their static instance data are engine-global (built
    // once in createEnvironmentResources), so nothing per-room to free here; the
    // per-room plane geometries drop with the meshes.
    CloudVisuals.dispose(vis.clouds);
}

/** run the CPU cloud cull + pack the compacted instance buffer, advance the
 *  wall-clock field, and flush pending CPU→GPU writes for the env buffers.
 *  ACTIVE ROOM ONLY — the engine-global resource buffers hold exactly one room's
 *  state at a time (the currently rendered one). The renderer supplies its own
 *  `resources` + `cloudResources`; `env` is the room's client-side config. */
export function updateForCamera(
    vis: EnvVisuals,
    env: Environment,
    resources: EnvironmentResources,
    cloudResources: CloudResources.CloudResources,
    camera: gpu.Camera,
    time: TimeResources,
): void {
    syncEnvVisibility(vis, env);
    CloudVisuals.update(vis.clouds, cloudResources, env, camera, time);
    flush(env, resources);
}

/** Sync the sky/sun/moon/star/cloud MESH visibility from the config's master
 *  `enabled` toggle (was flipped inline in `applyConfig`; now render state the
 *  renderer drives). Called from `updateForCamera` on the live path, and directly
 *  by offline icon renders (which flush without a per-frame `updateForCamera`). */
export function syncEnvVisibility(vis: EnvVisuals, env: Environment): void {
    const enabled = env.config.enabled;
    vis.skyMesh.visible = enabled;
    vis.sunMoonMesh.visible = enabled;
    vis.starMesh.visible = enabled;
    vis.clouds.mesh.visible = enabled;
}

/** force a push of this room's CPU shadow into the engine-global UBOs. call when
 *  a room becomes active, its config/sky may have drifted from the GPU contents
 *  while another room was active. */
export function flushActive(env: Environment, resources: EnvironmentResources): void {
    env._configDirty = true;
    env._skyDirty = true;
    flush(env, resources);
}

function flush(env: Environment, resources: EnvironmentResources): void {
    // point the engine-global frameGroup UBOs at this (active) room's CPU shadow;
    // gpucat re-packs from `.value` per backend. only the active room flushes, so
    // background rooms never touch the shared uniforms.
    //
    // time/wallTime are per-frame — set the small time UBO every tick. config/sky
    // are rarely-changing — set only when dirty.
    resources.envTime.value = { time: env.time, wallTime: (performance.now() - env._wallStartMs) / 1000 };
    if (env._configDirty) {
        resources.envConfig.value = env._config;
        env._configDirty = false;
    }
    if (env._skyDirty) {
        resources.envSky.value = env._sky;
        env._skyDirty = false;
    }
}
