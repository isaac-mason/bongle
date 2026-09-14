import type { Vec2, Vec3 } from 'math';
import * as ClientEnvironment from '../client/environment';
import { srgbBytesToLinear } from '../core/color';
import type { ScriptContext } from '../core/scene/scripts';

export type SkyPreset = 'overworld';

export type SkyStop = {
    /** wraps in [0,1]; sun position = `t * 2 * PI` */
    t: number;
    zenith: Vec3;
    horizon: Vec3;
    nadir: Vec3;
};

/** Input shape for {@link setEnvironment}, every field optional; shallow-merges into current state. */
export type EnvironmentConfig = {
    enabled?: boolean;
    sky?: { preset?: SkyPreset; stops?: SkyStop[] };
    sun?: { enabled?: boolean; intensity?: number };
    moon?: { enabled?: boolean };
    stars?: { enabled?: boolean; density?: number };
    /**
     * Planar cloud layer at `altitude` world units. `thickness` is the virtual depth the shader
     * marches through for a fake 3D volume; `density` is coverage in [0,1]; `wind` drifts the
     * noise field over `envTime`.
     */
    clouds?: { enabled?: boolean; density?: number; wind?: Vec2; altitude?: number; thickness?: number };
    /**
     * Distance fog, fading from `start` to `end`.
     *
     *   `end`     world units, or `'view'` (default) to track the client's own view radius,
     *             fading the world out at the streamed chunk boundary.
     *   `start`   fraction of `end` where the fade begins, not world units.
     *   `color`   `'sky'` tracks the sky LUT's horizon at the current time of day, or a linear
     *             rgb triple pins it.
     *   `opacity` how opaque fog gets at `end`; 1 fully replaces the colour.
     */
    fog?: { enabled?: boolean; color?: Vec3 | 'sky'; end?: number | 'view'; start?: number; opacity?: number };
};

// authored stops are sRGB byte triples; the shader works in linear space (the texture atlas uses
// `rgba8unorm-srgb` and decodes on sample), so decode at authoring time to match the texels
const rgb = srgbBytesToLinear;

// temperate sky, four stops keyed to time-of-day (midnight, sunrise, noon, sunset). the orange
// sunset glow is procedural in the shader (fog_sun_tint); the LUT only carries the ambient tone.
const OVERWORLD: SkyStop[] = [
    { t: 0.0, zenith: rgb(12, 16, 40), horizon: rgb(20, 26, 56), nadir: rgb(4, 4, 14) },
    { t: 0.25, zenith: rgb(65, 70, 115), horizon: rgb(95, 110, 160), nadir: rgb(20, 18, 30) },
    { t: 0.5, zenith: rgb(97, 181, 245), horizon: rgb(144, 211, 246), nadir: rgb(60, 70, 88) },
    { t: 0.75, zenith: rgb(65, 70, 115), horizon: rgb(95, 110, 160), nadir: rgb(20, 18, 30) },
];

/** Named sky LUT tables. Only `overworld` is tuned right now. */
export const PRESETS: Record<SkyPreset, SkyStop[]> = {
    overworld: OVERWORLD,
};

// fog defaults fade the world out at whatever the client can see; start: 0.9 matches
// minecraft's terrain-fog fraction at both of our tier radii (6 and 12 chunks)
const FOG_DEFAULT: ClientEnvironment.ResolvedEnvironment['fog'] = {
    enabled: true,
    color: 'sky',
    end: 'view',
    start: 0.9,
    opacity: 1,
};

/** Default resolved environment config when a room boots. */
export const ENVIRONMENT_DEFAULT: ClientEnvironment.ResolvedEnvironment = {
    enabled: true,
    sky: { stops: OVERWORLD },
    sun: { enabled: false, intensity: 0.45 },
    moon: { enabled: false },
    stars: { enabled: false, density: 0.005 },
    clouds: { enabled: false, density: 0.5, wind: [1, 0], altitude: 96, thickness: 2 },
    fog: FOG_DEFAULT,
};

export const ENVIRONMENT_OVERWORLD: ClientEnvironment.ResolvedEnvironment = {
    enabled: true,
    sky: { stops: OVERWORLD },
    sun: { enabled: true, intensity: 0.45 },
    moon: { enabled: true },
    stars: { enabled: true, density: 0.005 },
    clouds: { enabled: true, density: 0.5, wind: [1, 0], altitude: 96, thickness: 2 },
    fog: FOG_DEFAULT,
};

function activeEnv(ctx: ScriptContext): ClientEnvironment.Environment | null {
    return ctx.client?.room?.environment ?? null;
}

/**
 * Advances the environment time, in hours (0 = midnight, 6 = sunrise, 12 = noon, 18 = sunset,
 * wraps mod 24). Hot path, one f32 uniform write; safe to call every frame.
 */
export function setEnvironmentTime(ctx: ScriptContext, hours: number): void {
    const env = activeEnv(ctx);
    if (!env) return;
    ClientEnvironment.applyTime(env, hours / 24);
}

/** Current environment time in hours, in [0, 24). */
export function getEnvironmentTime(ctx: ScriptContext): number {
    const env = activeEnv(ctx);
    return env ? env.time * 24 : 0;
}

/**
 * Merges a partial config into the room's environment (see {@link EnvironmentConfig}). Slow
 * path, repacks and re-uploads the config buffer: call from script init or game events, never
 * every frame (use {@link setEnvironmentTime} for per-frame time-of-day). Merges per-field;
 * omitted groups and fields keep their current value. No-ops without an active client environment.
 *
 * @example
 * setEnvironment(ctx, {
 *     sun: { intensity: 0.2 },
 *     clouds: { enabled: true, density: 0.9, thickness: 4 },
 * });
 */
export function setEnvironment(ctx: ScriptContext, config: EnvironmentConfig): void {
    const env = activeEnv(ctx);
    if (!env) return;
    ClientEnvironment.applyConfig(env, config, PRESETS);
}
