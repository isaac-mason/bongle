/**
 * environment, sky, sun, moon, stars, clouds.
 *
 * the GPU side is engine-global: two storage buffers (`envConfig`,
 * `envSky`) live on `EnvironmentResources` and are bound by name by every
 * env-aware shader. the CPU side is per-room: each `Environment` holds
 * its own `_packed` / `_skyPacked` shadow that `setTime` /
 * `setEnvironment` mutate without ever touching GPU state. only the
 * active room's `updateForCamera` flush copies its shadow into the
 * shared buffers each frame, and `flushActive` does the same on room
 * activation so a freshly-switched room's sky/config replaces the
 * previously-active room's contents.
 *
 *   `envConfig`, scalar/vector knobs incl. `time` (time-of-day, [0,1))
 *                 and `wallTime` (monotonic seconds since room boot), plus
 *                 sun intensity, star density, cloud params, master
 *                 `enabled`.
 *   `envSky`, 4-stop sky LUT (12 vec3s: zenith/horizon/nadir × 4 stops).
 *
 * the sky sphere material paints only the cheap, full-screen part:
 *   - LUT-driven vertical sky gradient (zenith→horizon→nadir, interp by time)
 *   - a single-term horizon sun-wash (orange sunrise/sunset)
 * all uniform-only math lives in the vertex stage as flat varyings, so the
 * per-pixel cost is a gradient + one pow. the discrete elements are drawn
 * as instanced billboards that only shade the pixels they cover:
 *   - sun + moon: 2 camera-facing square billboards on the far sphere
 *   - stars: baked round-dot billboards, twinkle/night-fade/density in-shader
 *
 * voxel + model + cloud materials bind the same `envConfig`, `skyBrightness`
 * and `sunDirection` derive from `cfg.time` in their fragment shaders, so
 * one EnvConfig write animates the whole active room's sky + world.
 */

import * as gpu from 'gpucat';
import type { Vec2, Vec3 } from 'mathcat';
import type { EnvironmentConfig, SkyPreset, SkyStop } from '../api/environment';
import { srgbBytesToLinear } from '../core/color';
import type * as CloudResources from './cloud-resources';
import * as CloudVisuals from './cloud-visuals';

/* ── types ────────────────────────────────────────────────────────── */

export type ResolvedEnvironment = {
    enabled: boolean;
    sky: { stops: SkyStop[] };
    sun: { enabled: boolean; intensity: number };
    moon: { enabled: boolean };
    stars: { enabled: boolean; density: number };
    clouds: { enabled: boolean; density: number; wind: Vec2; altitude: number; thickness: number };
};

/**
 * engine-global env GPU handles. one set across the whole engine, every
 * env-aware shader (sky, voxel, model, sprite, cloud) binds the same
 * `envConfigBuffer` + `envSkyBuffer` by name. only the active
 * room's per-room CPU shadow flushes into these buffers each frame (see
 * `updateForCamera`), so background rooms can mutate their own `Environment`
 * via `setTime`/`setEnvironment` without ever touching GPU state, and the
 * buffers always reflect exactly one room's intent.
 */
export type EnvironmentResources = {
    envConfigBuffer: gpu.GpuBuffer;
    envSkyBuffer: gpu.GpuBuffer;
};

export type Environment = {
    /** time-of-day driver, wraps in [0,1). 0=midnight, 0.25=sunrise, 0.5=noon. */
    time: number;
    /** resolved CPU shadow, every field concrete, no optionals. */
    config: ResolvedEnvironment;

    /** per-room sky sphere (added to room.scene). */
    skyMesh: gpu.Mesh;
    /** per-room sun + moon billboard pair (2 instances). */
    sunMoonMesh: gpu.Mesh;
    /** per-room star-field billboards (`STAR_COUNT` instances). */
    starMesh: gpu.Mesh;

    /** per-room scene anchor for the engine-global cloud system. just a
     *  Mesh + Scene pair, all heavy state (material, geometry, buffers)
     *  lives on `CloudResources`. The CPU cull runs against `camera` in
     *  `updateForCamera` and writes into the *shared* compacted instance
     *  buffer; safe because only the active room renders per frame. */
    clouds: CloudVisuals.CloudVisuals;

    /** per-room CPU shadow of the EnvConfig payload. `applyTime`/`applyConfig`
     *  mutate this; `updateForCamera` (active room only) flushes it to the
     *  engine-global `envConfigBuffer`. */
    _packed: Float32Array;
    /** per-room CPU shadow of the sky LUT payload. mirrors `_packed`,
     *  active-room flush copies it to `envSkyBuffer`. */
    _skyPacked: Float32Array;
    /** epoch for `wallTime`, `performance.now()` at room creation. */
    _wallStartMs: number;
    /** dirty flags: only the active room writes to GPU. flushed on tick. */
    _configDirty: boolean;
    _skyDirty: boolean;
    /** engine-global GPU buffers, flushed into on tick (active room only). */
    _resources: EnvironmentResources;
    /** engine-global cloud resources, shared material/geometry/buffers.
     *  Held here so `updateForCamera` can drive the CPU cull without
     *  threading cloudResources through every per-frame call site. */
    _cloudResources: CloudResources.CloudResources;
    /** per-room static instance buffers for the sun/moon + star billboards.
     *  baked once at init; held only so `dispose` can release them. */
    _skyBodyBuffer: gpu.GpuBuffer;
    _starBuffer: gpu.GpuBuffer;
};

/* ── GPU struct layout ────────────────────────────────────────────── */

/**
 * scalar/vector params packed into one storage buffer. sky LUT is
 * separate (`envSkyBuffer`) so it can be sized and updated independently
 * of the scalar config.
 *
 * `time` (time-of-day driver) and `wallTime` (monotonic seconds since
 * room boot) live here too so name-based storage lookups from per-mesh
 * geometry resolve every env input in a single binding, no separate
 * uniforms for materials to capture by reference.
 *
 * `enabled` is a u32 mask read by both sky + voxel materials. 0 = sky
 * mesh effectively transparent, voxel skyBrightness pinned to 1.0.
 */
export const EnvConfig = gpu.struct('EnvConfig', {
    time: gpu.d.f32,
    wallTime: gpu.d.f32,
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

const SKY_STOPS = 4;
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

/* ── pack helpers ─────────────────────────────────────────────────── */

function packConfig(config: ResolvedEnvironment, time: number, wallTime: number): Float32Array {
    return new Float32Array(
        gpu.pack(EnvConfig, {
            time,
            wallTime,
            enabled: config.enabled ? 1 : 0,
            sunEnabled: config.sun.enabled ? 1 : 0,
            sunIntensity: config.sun.intensity,
            moonEnabled: config.moon.enabled ? 1 : 0,
            starsEnabled: config.stars.enabled ? 1 : 0,
            starsDensity: config.stars.density,
            cloudsEnabled: config.clouds.enabled ? 1 : 0,
            cloudsDensity: config.clouds.density,
            cloudsWindX: config.clouds.wind[0],
            cloudsWindY: config.clouds.wind[1],
            cloudsAltitude: config.clouds.altitude,
            cloudsThickness: config.clouds.thickness,
        }),
    );
}

// EnvConfig field order is time, wallTime, ..., both f32, both at the
// head of the struct with no preceding padding, so they live at element
// indices 0 and 1 of the packed Float32Array. callers patch these
// directly on hot paths (`applyTime`, `updateForCamera`) instead of
// repacking the whole struct.
const TIME_F32_INDEX = 0;
const WALL_TIME_F32_INDEX = 1;

function packSkyStops(stops: SkyStop[]): Float32Array {
    // pad to 4 stops by repeating the last entry; align each vec3 to 16 bytes
    // (WGSL vec3<f32> stride). vec3f in array layout is 4 floats wide.
    const STRIDE = 4;
    const out = new Float32Array(SKY_VEC3_COUNT * STRIDE);
    for (let i = 0; i < SKY_STOPS; i++) {
        const s = stops[Math.min(i, stops.length - 1)]!;
        const base = i * SKY_VEC3_PER_STOP * STRIDE;
        out[base + 0] = s.zenith[0];
        out[base + 1] = s.zenith[1];
        out[base + 2] = s.zenith[2];
        out[base + STRIDE + 0] = s.horizon[0];
        out[base + STRIDE + 1] = s.horizon[1];
        out[base + STRIDE + 2] = s.horizon[2];
        out[base + STRIDE * 2 + 0] = s.nadir[0];
        out[base + STRIDE * 2 + 1] = s.nadir[1];
        out[base + STRIDE * 2 + 2] = s.nadir[2];
    }
    return out;
}

/* ── resources (engine-global) ────────────────────────────────────── */

/**
 * allocate the engine-global env buffers, seeded from `initial`. shape
 * and sizing are fixed once here, every per-room `Environment` flushes
 * into the same two buffers; only one room's state is live on the GPU
 * at a time (the active one).
 */
export function createEnvironmentResources(initial: ResolvedEnvironment): EnvironmentResources {
    const envConfigBuffer = gpu.createStorageBuffer(EnvConfig, packConfig(initial, 0.6, 0));
    const envSkyBuffer = gpu.createStorageBuffer(gpu.d.sizedArray(gpu.d.vec3f, SKY_VEC3_COUNT), packSkyStops(initial.sky.stops));
    return { envConfigBuffer, envSkyBuffer };
}

export function disposeResources(res: EnvironmentResources): void {
    res.envConfigBuffer.dispose();
    res.envSkyBuffer.dispose();
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
    instanceIndex,
    storage,
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
let _skyMaterial: gpu.Material | null = null;

function getSkyMaterial(): gpu.Material {
    if (_skyMaterial) return _skyMaterial;

    const cfg = storage('env', EnvConfig, 'read').fields();
    const skyArr = storage('envSky', gpu.d.sizedArray(gpu.d.vec3f, SKY_VEC3_COUNT), 'read');
    const tNode = cfg.time;

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

    _skyMaterial = new gpu.Material({
        name: 'sky-environment',
        vertex,
        fragment,
        cullMode: 'front',
        depthTest: false,
        depthWrite: false,
    });
    return _skyMaterial;
}

/* ── sun + moon (instanced billboards) ────────────────────────────── */

/**
 * engine-global sun/moon material: 2 camera-facing square billboards on
 * the far sphere. `kind` (0 sun, 1 moon) selects direction, enable and
 * day/night fade — all derived from `EnvConfig.time` in-shader, so the
 * instance buffer is static. lazy-cached like `getSkyMaterial`.
 */
let _skyBodyMaterial: gpu.Material | null = null;

function getSkyBodyMaterial(): gpu.Material {
    if (_skyBodyMaterial) return _skyBodyMaterial;

    const cfg = storage('env', EnvConfig, 'read').fields();
    const bodies = storage('skyBody', d.array(SkyBodyInstance), 'read');
    const inst = bodies.element(instanceIndex);
    const color = inst.field('color').toVar('sbColor');
    const kind = inst.field('kind').toVar('sbKind'); // 0 sun, 1 moon
    const halfSize = inst.field('halfSize').toVar('sbHalf');

    // sun/moon directions from time; select by kind (0/1) via mix.
    const TAU = f32(Math.PI * 2);
    const sunAngle = mul(sub(cfg.time, f32(0.25)), TAU).toVar('sbSunAngle');
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

    _skyBodyMaterial = new gpu.Material({
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
    return _skyBodyMaterial;
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

function createSkyBodyMesh(res: EnvironmentResources): { mesh: gpu.Mesh; buffer: gpu.GpuBuffer } {
    const geometry = gpu.createPlaneGeometry(1, 1);
    const buffer = new gpu.GpuBuffer(d.array(SkyBodyInstance), { data: bakeSkyBodyInstances(), usage: 'storage' });
    geometry.setBuffer('skyBody', buffer);
    geometry.setBuffer('env', res.envConfigBuffer);

    const mesh = new gpu.Mesh(geometry, getSkyBodyMaterial());
    mesh.name = 'sky-bodies';
    mesh.frustumCulled = false;
    mesh.count = 2;
    mesh.renderOrder = -998;
    return { mesh, buffer };
}

/* ── stars (instanced billboards) ─────────────────────────────────── */

/**
 * engine-global star material: `STAR_COUNT` camera-facing round-dot
 * billboards on the far sphere. per-star data (dir/size/brightness/phase/
 * gate) is static; twinkle, night fade and the live density gate read
 * `EnvConfig` in-shader, and invisible stars collapse to zero size so
 * daytime costs no fragments. lazy-cached like the others.
 */
let _starMaterial: gpu.Material | null = null;

function getStarMaterial(): gpu.Material {
    if (_starMaterial) return _starMaterial;

    const cfg = storage('env', EnvConfig, 'read').fields();
    const stars = storage('star', d.array(StarInstance), 'read');
    const inst = stars.element(instanceIndex);
    const dir = inst.field('dir').toVar('stDir');
    const baseSize = inst.field('size').toVar('stSize');
    const brightness = inst.field('brightness').toVar('stBright');
    const phase = inst.field('phase').toVar('stPhase');
    const gate = inst.field('gate').toVar('stGate');

    const TAU = f32(Math.PI * 2);
    const sunAngle = mul(sub(cfg.time, f32(0.25)), TAU).toVar('stSunAngle');
    const sunY = sin(sunAngle).toVar('stSunY');
    const nightFactor = clamp(mul(sub(f32(0.3), sunY), f32(2)), f32(0), f32(1)).toVar('stNight');
    const aboveHorizon = smoothstep(f32(0), f32(0.04), dir.y).toVar('stAbove');
    // live density: a star shows when its baked gate falls under the config.
    const densityVis = step(gate, cfg.starsDensity).toVar('stDensity');
    const starsOn = mul(cfg.starsEnabled.toF32(), cfg.enabled.toF32()).toVar('stOn');
    const vis = mul(mul(mul(nightFactor, aboveHorizon), densityVis), starsOn).toVar('stVis');

    const twinkle = add(f32(0.625), mul(f32(0.375), sin(add(mul(cfg.wallTime, f32(STAR_TWINKLE_SPEED)), mul(phase, TAU))))).toVar(
        'stTwinkle',
    );
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

    _starMaterial = new gpu.Material({
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
    return _starMaterial;
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

function createStarMesh(res: EnvironmentResources): { mesh: gpu.Mesh; buffer: gpu.GpuBuffer } {
    const geometry = gpu.createPlaneGeometry(1, 1);
    const buffer = new gpu.GpuBuffer(d.array(StarInstance), { data: bakeStarInstances(), usage: 'storage' });
    geometry.setBuffer('star', buffer);
    geometry.setBuffer('env', res.envConfigBuffer);

    const mesh = new gpu.Mesh(geometry, getStarMaterial());
    mesh.name = 'stars';
    mesh.frustumCulled = false;
    mesh.count = STAR_COUNT;
    mesh.renderOrder = -999;
    return { mesh, buffer };
}

/**
 * per-room sky sphere. material is engine-global (cached); geometry binds
 * this room's env buffers by name so the shared shader resolves to per-
 * room storage at render time.
 */
function createSkyMesh(res: EnvironmentResources): gpu.Mesh {
    const geometry = gpu.createSphereGeometry(1, 32, 32);
    geometry.setBuffer('env', res.envConfigBuffer);
    geometry.setBuffer('envSky', res.envSkyBuffer);

    const mesh = new gpu.Mesh(geometry, getSkyMaterial());
    mesh.name = 'sky';
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000;
    return mesh;
}

/* ── lifecycle ────────────────────────────────────────────────────── */

export function init(
    scene: gpu.Scene,
    resources: EnvironmentResources,
    initial: ResolvedEnvironment,
    cloudResources: CloudResources.CloudResources,
): Environment {
    const skyMesh = createSkyMesh(resources);
    scene.add(skyMesh);
    const stars = createStarMesh(resources);
    scene.add(stars.mesh);
    const sunMoon = createSkyBodyMesh(resources);
    scene.add(sunMoon.mesh);
    const clouds = CloudVisuals.init(scene, cloudResources);

    // per-room CPU shadow, every script-driven mutation lands here.
    // 0.6 (past midday) seeds an off-axis sun so faces differentiate
    // via N·L the moment a room boots.
    const time = 0.6;
    const _packed = packConfig(initial, time, 0);
    const _skyPacked = packSkyStops(initial.sky.stops);

    return {
        time,
        config: cloneConfig(initial),
        skyMesh,
        sunMoonMesh: sunMoon.mesh,
        starMesh: stars.mesh,
        clouds,
        _packed,
        _skyPacked,
        _wallStartMs: performance.now(),
        // fresh rooms need an initial push to GPU on first activation.
        _configDirty: true,
        _skyDirty: true,
        _resources: resources,
        _cloudResources: cloudResources,
        _skyBodyBuffer: sunMoon.buffer,
        _starBuffer: stars.buffer,
    };
}

export function dispose(env: Environment): void {
    env.skyMesh.removeFromParent();
    env.sunMoonMesh.removeFromParent();
    env.starMesh.removeFromParent();
    // sky/body/star materials are engine-global (cached), do NOT dispose;
    // geometry is per-room and drops with the mesh, but the instance
    // buffers are held explicitly, so release them here.
    env._skyBodyBuffer.dispose();
    env._starBuffer.dispose();
    CloudVisuals.dispose(env.clouds);
    // resources are engine-global; not disposed here.
}

/** run the CPU cloud cull + pack the compacted instance buffer, advance
 *  the wall-clock field, and flush any pending CPU→GPU writes for the
 *  env buffers. ACTIVE ROOM ONLY, the engine-global resource buffers
 *  hold exactly one room's state at a time, the currently rendered one. */
export function updateForCamera(env: Environment, camera: gpu.Camera): void {
    CloudVisuals.update(env.clouds, env._cloudResources, env, camera);
    const wallTime = (performance.now() - env._wallStartMs) / 1000;
    env._packed[WALL_TIME_F32_INDEX] = wallTime;
    env._configDirty = true;
    flush(env);
}

/** force a full push of this room's CPU shadow into the engine-global
 *  buffers. call when a room becomes active, its `_packed`/`_skyPacked`
 *  may have drifted from the GPU contents while another room was active. */
export function flushActive(env: Environment): void {
    env._configDirty = true;
    env._skyDirty = true;
    flush(env);
}

function flush(env: Environment): void {
    if (env._configDirty) {
        env._resources.envConfigBuffer.array = env._packed;
        env._resources.envConfigBuffer.needsUpdate = true;
        env._configDirty = false;
    }
    if (env._skyDirty) {
        env._resources.envSkyBuffer.array = env._skyPacked;
        env._resources.envSkyBuffer.needsUpdate = true;
        env._skyDirty = false;
    }
}

/* ── writes ───────────────────────────────────────────────────────── */

/** hot path, patch one f32 in the per-room EnvConfig CPU shadow + mark
 *  dirty. NO GPU write here: background rooms must not touch the engine-
 *  global buffer. the active room flushes its own shadow each frame via
 *  `updateForCamera`. */
export function applyTime(env: Environment, t: number): void {
    // wrap to [0,1), accepts unwrapped game time too.
    const wrapped = ((t % 1) + 1) % 1;
    env.time = wrapped;
    env._packed[TIME_F32_INDEX] = wrapped;
    env._configDirty = true;
}

/** slow path, shallow-merge config groups, repack per-room CPU shadow(s),
 *  mark dirty. CPU only; GPU flush happens on the active room's tick. */
export function applyConfig(env: Environment, input: EnvironmentConfig, presets: Record<SkyPreset, SkyStop[]>): void {
    const cfg = env.config;

    if (input.enabled !== undefined) cfg.enabled = input.enabled;

    let skyChanged = false;
    if (input.sky) {
        // stops wins over preset if both set.
        if (input.sky.stops) {
            cfg.sky.stops = input.sky.stops;
            skyChanged = true;
        } else if (input.sky.preset) {
            cfg.sky.stops = presets[input.sky.preset];
            skyChanged = true;
        }
    }

    if (input.sun?.enabled !== undefined) cfg.sun.enabled = input.sun.enabled;
    if (input.sun?.intensity !== undefined) cfg.sun.intensity = input.sun.intensity;
    if (input.moon?.enabled !== undefined) cfg.moon.enabled = input.moon.enabled;
    if (input.stars?.enabled !== undefined) cfg.stars.enabled = input.stars.enabled;
    if (input.stars?.density !== undefined) cfg.stars.density = input.stars.density;
    if (input.clouds) {
        if (input.clouds.enabled !== undefined) cfg.clouds.enabled = input.clouds.enabled;
        if (input.clouds.density !== undefined) cfg.clouds.density = input.clouds.density;
        if (input.clouds.wind !== undefined) cfg.clouds.wind = input.clouds.wind;
        if (input.clouds.altitude !== undefined) cfg.clouds.altitude = input.clouds.altitude;
        if (input.clouds.thickness !== undefined) cfg.clouds.thickness = input.clouds.thickness;
    }

    // master-enabled toggles mesh visibility, voxel materials read it
    // from the buffer too. mesh visibility is per-room state on the
    // per-room sky/cloud meshes, so it's safe to flip immediately.
    env.skyMesh.visible = cfg.enabled;
    env.sunMoonMesh.visible = cfg.enabled;
    env.starMesh.visible = cfg.enabled;
    env.clouds.mesh.visible = cfg.enabled;

    // preserve current time + wallTime through the repack, they live in
    // the same buffer but are driven independently by `applyTime` /
    // `updateForCamera` and would be clobbered if we re-read them from
    // the resolved config (which has no notion of them).
    const wallTime = env._packed[WALL_TIME_F32_INDEX]!;
    env._packed = packConfig(cfg, env.time, wallTime);
    env._configDirty = true;

    if (skyChanged) {
        env._skyPacked = packSkyStops(cfg.sky.stops);
        env._skyDirty = true;
    }
}

function cloneConfig(c: ResolvedEnvironment): ResolvedEnvironment {
    return {
        enabled: c.enabled,
        sky: { stops: c.sky.stops },
        sun: { enabled: c.sun.enabled, intensity: c.sun.intensity },
        moon: { enabled: c.moon.enabled },
        stars: { enabled: c.stars.enabled, density: c.stars.density },
        clouds: {
            enabled: c.clouds.enabled,
            density: c.clouds.density,
            wind: [c.clouds.wind[0], c.clouds.wind[1]],
            altitude: c.clouds.altitude,
            thickness: c.clouds.thickness,
        },
    };
}
