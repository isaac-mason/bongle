// Per-room environment CONFIG — client-side CPU state.
//
// This is the client half of the environment: the time-of-day + sky/sun/moon/
// star/cloud config a room holds, mutated by scripts through `setTime` /
// `setEnvironment` (see api/environment). It touches NO GPU state and NO backend
// resources. The renderer READS this each frame and owns all the env RENDER
// state (sky/cloud meshes, the GPU flush) in `render/common/environment` — see
// its `EnvVisuals` + `updateForCamera`.
//
// `_config` / `_sky` are the CPU shadows in the shape the renderer's env UBOs
// consume (plain numbers, no GPU types); the renderer pushes them on dirty.

import type { Vec2 } from 'mathcat';
import type { EnvironmentConfig, SkyPreset, SkyStop } from '../api/environment';

/** number of sky LUT stops (zenith/horizon/nadir each), padded to this. */
export const SKY_STOPS = 4;

/** resolved CPU shadow, every field concrete, no optionals. */
export type ResolvedEnvironment = {
    enabled: boolean;
    sky: { stops: SkyStop[] };
    sun: { enabled: boolean; intensity: number };
    moon: { enabled: boolean };
    stars: { enabled: boolean; density: number };
    clouds: { enabled: boolean; density: number; wind: Vec2; altitude: number; thickness: number };
};

/** the rarely-changing config as a plain `Infer<EnvConfig>`-shaped object (the
 *  numeric shape the renderer's `envConfig` UBO consumes). */
export type EnvConfigValue = {
    enabled: number;
    sunEnabled: number;
    sunIntensity: number;
    moonEnabled: number;
    starsEnabled: number;
    starsDensity: number;
    cloudsEnabled: number;
    cloudsDensity: number;
    cloudsWindX: number;
    cloudsWindY: number;
    cloudsAltitude: number;
    cloudsThickness: number;
};

/**
 * Per-room environment CONFIG — pure client CPU state. Scripts mutate it via
 * `applyTime`/`applyConfig`; the renderer reads it each frame and flushes the
 * `_config`/`_sky` shadows into its engine-global env UBOs. Constructed with NO
 * backend resources — the render half is `EnvVisuals`, owned by the renderer.
 */
export type Environment = {
    /** time-of-day driver, wraps in [0,1). 0=midnight, 0.25=sunrise, 0.5=noon. */
    time: number;
    /** resolved CPU shadow, every field concrete, no optionals. */
    config: ResolvedEnvironment;

    /** per-room CPU shadow of the rarely-changing config; the active room flushes
     *  it to the engine-global `envConfig` UBO on dirty. time-of-day lives in
     *  `time` (flushed to the separate `envTime` UBO every frame), not here. */
    _config: EnvConfigValue;
    /** per-room CPU shadow of the sky LUT (12 vec3). active-room flush copies it
     *  to the `envSky` UBO on dirty. */
    _sky: [number, number, number][];
    /** epoch for `wallTime`, `performance.now()` at room creation. */
    _wallStartMs: number;
    /** dirty flags: only the active room writes to GPU. flushed on tick. */
    _configDirty: boolean;
    _skyDirty: boolean;
};

/** the rarely-changing config as an `Infer<EnvConfig>`-shaped object. Exported so
 *  the renderer can seed its env UBOs from the initial config on construction. */
export function buildConfigObject(config: ResolvedEnvironment): EnvConfigValue {
    return {
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
    };
}

/** the sky LUT as 12 vec3 (4 stops × zenith/horizon/nadir), padded to 4 stops.
 *  gpucat rounds each element to the backend's uniform stride (16 bytes) at pack. */
export function buildSkyValue(stops: SkyStop[]): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (let i = 0; i < SKY_STOPS; i++) {
        const s = stops[Math.min(i, stops.length - 1)]!;
        out.push([s.zenith[0], s.zenith[1], s.zenith[2]]);
        out.push([s.horizon[0], s.horizon[1], s.horizon[2]]);
        out.push([s.nadir[0], s.nadir[1], s.nadir[2]]);
    }
    return out;
}

/**
 * Build a room's env CONFIG (pure CPU, no backend resources). The client owns
 * this on `room.environment`; scripts mutate it and the renderer reads it.
 */
export function createEnvironment(initial: ResolvedEnvironment): Environment {
    return {
        // per-room CPU shadow, every script-driven mutation lands here. 0.6 (past
        // midday) seeds an off-axis sun so faces differentiate via N·L the moment
        // a room boots.
        time: 0.6,
        config: cloneConfig(initial),
        _config: buildConfigObject(initial),
        _sky: buildSkyValue(initial.sky.stops),
        _wallStartMs: performance.now(),
        // fresh rooms need an initial push to GPU on first activation.
        _configDirty: true,
        _skyDirty: true,
    };
}

/* ── writes ───────────────────────────────────────────────────────── */

/** hot path, patch time-of-day in the CPU shadow. NO GPU write here: background
 *  rooms must not touch the engine-global buffer; the active room flushes its own
 *  shadow each frame via the renderer's `updateForCamera`. */
export function applyTime(env: Environment, t: number): void {
    // wrap to [0,1), accepts unwrapped game time too. time is per-frame (flushed to
    // the envTime UBO every tick), so just update the shadow — no dirty flag.
    env.time = ((t % 1) + 1) % 1;
}

/** slow path, shallow-merge config groups, repack per-room CPU shadow(s), mark
 *  dirty. CPU only; GPU flush happens on the active room's tick. */
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

    // master `enabled` also toggles sky/cloud MESH visibility, but those are render
    // state (EnvVisuals); the renderer syncs them from `config.enabled` each frame.
    // Here we only touch the CPU config.
    env._config = buildConfigObject(cfg);
    env._configDirty = true;

    if (skyChanged) {
        env._sky = buildSkyValue(cfg.sky.stops);
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
