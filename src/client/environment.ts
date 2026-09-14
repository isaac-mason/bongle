import type { Vec2, Vec3 } from 'math';
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
    fog: { enabled: boolean; color: Vec3 | 'sky'; end: number | 'view'; start: number; opacity: number };
};

/** rarely-changing config, numeric shape the renderer's `envConfig` UBO consumes. */
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
    fogEnabled: number;
    fogOpacity: number;
};

/**
 * Per-room environment config, pure client CPU state. Scripts mutate it via
 * `applyTime`/`applyConfig`; the renderer reads it each frame and flushes the
 * `_config`/`_sky` shadows into its engine-global env UBOs.
 */
export type Environment = {
    /** time-of-day driver, wraps in [0,1). 0=midnight, 0.25=sunrise, 0.5=noon. */
    time: number;
    config: ResolvedEnvironment;

    /** CPU shadow of the rarely-changing config, flushed to the `envConfig` UBO by the active room on dirty. */
    _config: EnvConfigValue;
    /** CPU shadow of the sky LUT (12 vec3), flushed to the `envSky` UBO on dirty. */
    _sky: [number, number, number][];
    /** epoch for `wallTime`, `performance.now()` at room creation. */
    _wallStartMs: number;
    /** dirty flags: only the active room writes to GPU, flushed on tick. */
    _configDirty: boolean;
    _skyDirty: boolean;
};

/** exported so the renderer can seed its env UBOs from the initial config on construction. */
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
        fogEnabled: config.fog.enabled ? 1 : 0,
        fogOpacity: config.fog.opacity,
    };
}

/** sky LUT as 12 vec3 (4 stops x zenith/horizon/nadir); gpucat rounds each to the 16-byte uniform stride at pack. */
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

/** builds a room's env config, pure CPU with no backend resources; `room.environment` owns it. */
export function createEnvironment(initial: ResolvedEnvironment): Environment {
    return {
        // 0.6 (past midday) seeds an off-axis sun so faces differentiate via N.L on boot.
        time: 0.6,
        config: cloneConfig(initial),
        _config: buildConfigObject(initial),
        _sky: buildSkyValue(initial.sky.stops),
        _wallStartMs: performance.now(),
        _configDirty: true,
        _skyDirty: true,
    };
}

/** hot path; no GPU write here, background rooms must not touch the engine-global buffer. */
export function applyTime(env: Environment, t: number): void {
    // time is flushed to the envTime UBO every tick regardless, so no dirty flag needed.
    env.time = ((t % 1) + 1) % 1;
}

/** slow path: shallow-merges config groups and repacks the CPU shadows; GPU flush happens on the active room's tick. */
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
    if (input.fog) {
        if (input.fog.enabled !== undefined) cfg.fog.enabled = input.fog.enabled;
        if (input.fog.color !== undefined) cfg.fog.color = input.fog.color;
        if (input.fog.end !== undefined) cfg.fog.end = input.fog.end;
        if (input.fog.start !== undefined) cfg.fog.start = input.fog.start;
        if (input.fog.opacity !== undefined) cfg.fog.opacity = input.fog.opacity;
    }

    // sky/cloud mesh visibility (EnvVisuals) is render state; the renderer syncs it
    // from `config.enabled` each frame, so only the CPU config is touched here.
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
        fog: {
            enabled: c.fog.enabled,
            color: c.fog.color === 'sky' ? 'sky' : [c.fog.color[0], c.fog.color[1], c.fog.color[2]],
            end: c.fog.end,
            start: c.fog.start,
            opacity: c.fog.opacity,
        },
    };
}
