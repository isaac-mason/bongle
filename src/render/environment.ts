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
 * the sky material reads both and renders:
 *   - LUT-driven vertical sky gradient (zenith→horizon→nadir, interp by time)
 *   - sun and moon discs via dot(viewDir, sun/moonDir) threshold
 *   - procedural stars hashed from quantized view dir
 *   - horizon tint near the sun direction (orange sunrise/sunset)
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
const FOG_MOON_TINT: Vec3 = srgbBytesToLinear(127, 153, 204); // #7f99cc
// sun + moon are squares (blocky aesthetic). HALF_SIZE is the half-extent
// in the sun-local tangent plane (≈ sin of angular half-width). FEATHER
// is the smoothstep band, narrow so edges read as crisp, wide enough to
// avoid shader aliasing without MSAA on the sky.
const SUN_HALF_SIZE = 0.05;
const SUN_FEATHER = 0.005;
const MOON_HALF_SIZE = 0.045;
const MOON_FEATHER = 0.004;

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
    fract,
    sqrt,
    clamp,
    smoothstep,
    step,
    max,
    normalize,
    attribute,
    storage,
    varying,
    cameraProjectionMatrix,
    cameraViewMatrix,
    d,
} = gpu;

/**
 * david hoskins' "hash without sine", float-bit-mixing in [0,1) with no
 * visible banding for smoothly-varying inputs (unlike fract(sin(dot(...))*K)).
 * 3D → 1D channel.
 */
function hoskinsHash(p: gpu.Node<typeof gpu.d.vec3f>): gpu.Node<typeof gpu.d.f32> {
    const a = fract(mul(p, f32(0.1031))).toVar('hoskA');
    const yzx = vec3f(a.y, a.z, a.x);
    const dotSum = dot(a, add(yzx, vec3f(f32(33.33), f32(33.33), f32(33.33))));
    const b = add(a, vec3f(dotSum, dotSum, dotSum));
    return fract(mul(add(b.x, b.y), b.z));
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
    const wallT = cfg.wallTime;

    // -- vertex: pin sphere to far plane (background.ts trick) --
    const pos = attribute('position', d.vec3f);
    const viewPos = mul(cameraViewMatrix, vec4f(pos, f32(0))).toVar('viewPos');
    const clipPos = mul(cameraProjectionMatrix, vec4f(viewPos.xyz, f32(1))).toVar('clipPos');
    const vertex = vec4f(clipPos.x, clipPos.y, clipPos.w, clipPos.w).toVar('vertex');

    const dir = varying(normalize(pos), 'vDir');

    // -- LUT sample (inline; see sampleSkyLut note) --
    const scaled = mul(tNode, f32(4)).toVar('lutScaled');
    const segF = floor(scaled).toVar('lutSegF');
    const fracT = sub(scaled, segF).toVar('lutFracT');
    const segA = segF.toU32().mod(u32(SKY_STOPS)).toVar('lutSegA');
    const segB = add(segA, u32(1)).mod(u32(SKY_STOPS)).toVar('lutSegB');
    const aBase = mul(segA, u32(SKY_VEC3_PER_STOP)).toVar('lutABase');
    const bBase = mul(segB, u32(SKY_VEC3_PER_STOP)).toVar('lutBBase');

    const zenith = mix(skyArr.element(aBase), skyArr.element(bBase), fracT).toVar('zenith');
    const horizon = mix(skyArr.element(add(aBase, u32(1))), skyArr.element(add(bBase, u32(1))), fracT).toVar('horizon');
    const nadir = mix(skyArr.element(add(aBase, u32(2))), skyArr.element(add(bBase, u32(2))), fracT).toVar('nadir');

    // -- vertical gradient --
    // y in [-1,1]; above horizon blend horizon→zenith, below blend horizon→nadir.
    const y = dir.y;
    const above = step(f32(0), y).toVar('above');
    const tUp = smoothstep(f32(0), f32(1), clamp(abs(y), f32(0), f32(1))).toVar('tUp');
    const skyAbove = mix(horizon, zenith, tUp).toVar('skyAbove');
    const skyBelow = mix(horizon, nadir, tUp).toVar('skyBelow');
    const baseSky = mix(skyBelow, skyAbove, above).toVar('baseSky');

    // -- sun + moon directions (from envTime) --
    // sunAngle = (t - 0.25) * 2π → t=0.25 sunrise east, t=0.5 noon up.
    const TAU = f32(Math.PI * 2);
    const sunAngle = mul(sub(tNode, f32(0.25)), TAU).toVar('sunAngle');
    const sunDir = vec3f(cos(sunAngle), sin(sunAngle), f32(0)).toVar('sunDir');
    const moonDir = vec3f(sub(f32(0), sunDir.x), sub(f32(0), sunDir.y), f32(0)).toVar('moonDir');

    const cdotSun = dot(dir, sunDir).toVar('cdotSun');
    const cdotMoon = dot(dir, moonDir).toVar('cdotMoon');

    // -- night factor: how dark the sky is (sun below horizon) --
    // sunDir.y = sin(sunAngle). > 0 when sun above horizon.
    const nightFactor = clamp(mul(sub(f32(0.3), sunDir.y), f32(2)), f32(0), f32(1)).toVar('nightFactor');

    // -- sun + moon as squares (L∞ test in the sun-local tangent plane) --
    // sun orbits in the XY plane. tangent-along-orbit = perpendicular to
    // sunDir in that plane: (-sin, cos, 0). cross-axis is world Z. project
    // viewDir onto both axes, then test max(|u|,|v|) < HALF_SIZE.
    // hemisphere mask (step on cdot) keeps the antipodal point from also
    // lighting up, without it, dir=-sunDir would project to (0,0).
    const sunTangent = vec3f(sub(f32(0), sin(sunAngle)), cos(sunAngle), f32(0)).toVar('sunTangent');
    const worldZ = vec3f(f32(0), f32(0), f32(1));

    const uSun = dot(dir, sunTangent).toVar('uSun');
    const vSun = dot(dir, worldZ).toVar('vSun');
    const dSun = max(abs(uSun), abs(vSun)).toVar('dSun');
    const inFrontSun = step(f32(0), cdotSun).toVar('inFrontSun');
    const sunDisc = mul(
        sub(f32(1), smoothstep(f32(SUN_HALF_SIZE - SUN_FEATHER), f32(SUN_HALF_SIZE + SUN_FEATHER), dSun)),
        inFrontSun,
    ).toVar('sunDisc');
    const sunColorNode = vec3f(f32(SUN_COLOR[0]), f32(SUN_COLOR[1]), f32(SUN_COLOR[2]));
    const sunEnabled = cfg.sunEnabled.toF32().toVar('sunEnabled');
    const sunContrib = mul(mul(sunColorNode, sunDisc), sunEnabled).toVar('sunContrib');

    // moon-local axes: tangent flips sign because moonDir = -sunDir.
    const moonTangent = vec3f(sin(sunAngle), sub(f32(0), cos(sunAngle)), f32(0)).toVar('moonTangent');
    const uMoon = dot(dir, moonTangent).toVar('uMoon');
    const vMoon = dot(dir, worldZ).toVar('vMoon');
    const dMoon = max(abs(uMoon), abs(vMoon)).toVar('dMoon');
    const inFrontMoon = step(f32(0), cdotMoon).toVar('inFrontMoon');
    const moonDisc = mul(
        sub(f32(1), smoothstep(f32(MOON_HALF_SIZE - MOON_FEATHER), f32(MOON_HALF_SIZE + MOON_FEATHER), dMoon)),
        inFrontMoon,
    ).toVar('moonDisc');
    const moonColorNode = vec3f(f32(MOON_COLOR[0]), f32(MOON_COLOR[1]), f32(MOON_COLOR[2]));
    const moonEnabled = cfg.moonEnabled.toF32().toVar('moonEnabled');
    const moonContrib = mul(mul(mul(moonColorNode, moonDisc), nightFactor), moonEnabled).toVar('moonContrib');

    // -- sunset dramatics --
    // peaks when the sun is right at the horizon (sunrise / sunset); 0
    // when sun is high or well below. drives a widened, redder warm tint
    // and a dimmer rest-of-sky so the horizon glow stands out.
    const sunsetNear = sub(f32(1), clamp(mul(abs(sunDir.y), f32(3.5)), f32(0), f32(1))).toVar('sunsetNear');
    const sunAboveGate = smoothstep(f32(-0.12), f32(0.08), sunDir.y).toVar('sunAboveGate');
    const sunsetFactor = mul(sunsetNear, sunAboveGate).toVar('sunsetFactor');

    // -- horizon sun/moon tint (luanti's fog_sun_tint / fog_moon_tint) --
    // mix toward tint where dir is near sun/moon and near horizon. during
    // sunset the angular falloff widens (lower pow exponent) and the
    // strength rises, so more of the sun-facing sky catches fire.
    const horizonBand = sub(f32(1), clamp(mul(abs(y), f32(2.5)), f32(0), f32(1))).toVar('horizonBand');
    // two-term angular falloff (standard real-time atmospheric trick):
    //   - core: tight halo right around the sun (high pow exponent),
    //           always present, brightens at dusk.
    //   - wash: broad warm band reaching ~90-120° off the sun direction
    //           (near-linear falloff), only fires during sunset.
    // sum, clamped, gives a hot disc-adjacent glow blended into a
    // wider rosy spread, instead of a single point-sourced gradient.
    const cdotSunC = clamp(cdotSun, f32(0), f32(1)).toVar('cdotSunC');
    const sunCorePow = mix(f32(8), f32(5), sunsetFactor).toVar('sunCorePow');
    const sunWashPow = mix(f32(2), f32(0.9), sunsetFactor).toVar('sunWashPow');
    const sunCoreStrength = mix(f32(0.45), f32(0.95), sunsetFactor).toVar('sunCoreStrength');
    const sunWashStrength = mul(sunsetFactor, f32(0.45)).toVar('sunWashStrength');
    const sunCore = mul(pow(cdotSunC, sunCorePow), sunCoreStrength).toVar('sunCore');
    const sunWash = mul(pow(cdotSunC, sunWashPow), sunWashStrength).toVar('sunWash');
    const sunFalloff = clamp(add(sunCore, sunWash), f32(0), f32(1)).toVar('sunFalloff');
    const sunTintW = mul(mul(sunFalloff, horizonBand), sunEnabled).toVar('sunTintW');
    const moonTintW = mul(
        mul(mul(mul(pow(clamp(cdotMoon, f32(0), f32(1)), f32(3)), horizonBand), nightFactor), f32(0.25)),
        moonEnabled,
    ).toVar('moonTintW');

    // warm tint shifts orange → deep red as the sun nears the horizon.
    const sunTintBase = vec3f(f32(FOG_SUN_TINT[0]), f32(FOG_SUN_TINT[1]), f32(FOG_SUN_TINT[2]));
    const sunTintDeep = vec3f(f32(SUNSET_DEEP_TINT[0]), f32(SUNSET_DEEP_TINT[1]), f32(SUNSET_DEEP_TINT[2]));
    const sunTint = mix(sunTintBase, sunTintDeep, sunsetFactor).toVar('sunTint');
    const moonTint = vec3f(f32(FOG_MOON_TINT[0]), f32(FOG_MOON_TINT[1]), f32(FOG_MOON_TINT[2]));

    // darken the ambient sky during sunset. multiplying baseSky before
    // the tint mix preserves full-brightness orange where sunTintW≈1, so
    // only the un-tinted directions go dim, exactly the contrast we want.
    const skyDim = sub(f32(1), mul(sunsetFactor, f32(0.35))).toVar('skyDim');
    const baseSkyDimmed = mul(baseSky, skyDim).toVar('baseSkyDimmed');

    const tintedSky = mix(mix(baseSkyDimmed, sunTint, sunTintW), moonTint, moonTintW).toVar('tintedSky');

    // -- stars: round dots scattered in 3D dir space --
    // quantize `dir` into cells, then test the fragment's distance to its
    // cell center (in cell-unit space). this gives uniformly round dots
    // independent of how the sphere chord cuts the cube, the earlier
    // "cell membership" test produced irregular blob shapes because the
    // sphere intersected each cube in a different-shaped patch.
    const STAR_CELLS = f32(160);
    const starScaled = mul(dir, STAR_CELLS).toVar('starScaled');
    const starCell = floor(starScaled).toVar('starCell');
    const cellOffset = sub(starScaled, add(starCell, vec3f(f32(0.5), f32(0.5), f32(0.5)))).toVar('cellOffset');

    const SALT_B = vec3f(f32(11.7), f32(3.21), f32(0.91));
    const SALT_C = vec3f(f32(5.37), f32(17.91), f32(2.13));
    const SALT_J = vec3f(f32(2.71), f32(9.18), f32(4.66));
    const h1 = hoskinsHash(starCell).toVar('h1');
    const h5 = hoskinsHash(add(starCell, SALT_B)).toVar('h5');
    const hPhase = hoskinsHash(add(starCell, SALT_C)).toVar('hPhase');
    const hSize = hoskinsHash(add(starCell, SALT_J)).toVar('hSize');

    // gate by cell hash + density.
    const starThreshold = sub(f32(1), cfg.starsDensity).toVar('starThreshold');
    const starOn = step(starThreshold, h1).toVar('starOn');

    // small per-star radius variation so the field has size diversity.
    const starRadius = add(f32(0.18), mul(hSize, f32(0.18))).toVar('starRadius'); // [0.18, 0.36] cell-units
    const distToCenter = sqrt(dot(cellOffset, cellOffset)).toVar('distToCenter');
    const onStar = sub(f32(1), smoothstep(sub(starRadius, f32(0.05)), starRadius, distToCenter)).toVar('onStar');

    // per-star magnitude spread so the field doesn't look uniform.
    const starBrightness = add(f32(0.5), mul(h5, f32(0.5))).toVar('starBrightness');

    // brightness pulse, per-star phase, ~3 sec full cycle. wide band
    // (0.25-1.0) so the rise/fall reads at a glance.
    const TAU2 = f32(Math.PI * 2);
    const twinkleSpeed = f32(2.2);
    const twinklePhase = mul(hPhase, TAU2).toVar('twinklePhase');
    const twinkle = add(f32(0.625), mul(f32(0.375), sin(add(mul(wallT, twinkleSpeed), twinklePhase)))).toVar('twinkle');

    // mask stars behind the sun and moon discs so the celestial bodies
    // read as solid. sunDisc/moonDisc are smoothstepped, so this also
    // gives clean anti-aliased silhouettes.
    const occlusion = mul(sub(f32(1), sunDisc), sub(f32(1), moonDisc)).toVar('occlusion');

    const starsEnabled = cfg.starsEnabled.toF32().toVar('starsEnabled');
    // hide stars below the horizon, they read as bugs poking through the
    // ground plane when the camera tilts down. narrow smoothstep band
    // around y=0 keeps the cutoff from aliasing along the horizon line.
    const aboveHorizon = smoothstep(f32(0), f32(0.04), y).toVar('starAboveHorizon');
    const starIntensity = mul(
        mul(mul(mul(mul(mul(mul(starOn, onStar), starBrightness), twinkle), nightFactor), occlusion), starsEnabled),
        aboveHorizon,
    ).toVar('starIntensity');
    const starColorNode = vec3f(f32(STAR_COLOR[0]), f32(STAR_COLOR[1]), f32(STAR_COLOR[2]));
    const stars = mul(starColorNode, starIntensity).toVar('stars');

    const colorWithCelestials = add(add(add(tintedSky, sunContrib), moonContrib), stars).toVar('colorWithCelestials');

    // -- master enabled gate: when disabled, drop to black so a dedicated
    // clear color shows through (set pipeline-side). cheaper than tearing
    // the mesh out of the scene.
    const enabledMask = cfg.enabled.toF32().toVar('enabledMask');
    const final = mul(colorWithCelestials, enabledMask).toVar('finalRgb');

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
        clouds,
        _packed,
        _skyPacked,
        _wallStartMs: performance.now(),
        // fresh rooms need an initial push to GPU on first activation.
        _configDirty: true,
        _skyDirty: true,
        _resources: resources,
        _cloudResources: cloudResources,
    };
}

export function dispose(env: Environment): void {
    env.skyMesh.removeFromParent();
    // sky material is engine-global (cached), do NOT dispose; geometry
    // is per-room and disposed transitively when the mesh drops.
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
