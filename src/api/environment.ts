// api/environment.ts, script-facing per-room sky / sun / moon / stars /
// clouds. all motion derives from one shared `envTime` uniform,
// `setTime` is the hot path (one f32 write), `setEnvironment` shallow-
// merges into the config buffer.

import type { Vec2, Vec3 } from 'math';
import * as ClientEnvironment from '../client/environment';
import { srgbBytesToLinear } from '../core/color';
import type { ScriptContext } from '../core/scene/scripts';

/* ── types ────────────────────────────────────────────────────────── */

export type SkyPreset = 'overworld';

export type SkyStop = {
    /** wraps in [0,1]; sun position = `t * 2π` */
    t: number;
    zenith: Vec3;
    horizon: Vec3;
    nadir: Vec3;
};

/** input shape, every field optional. shallow-merges into current state. */
export type EnvironmentConfig = {
    enabled?: boolean;
    sky?: { preset?: SkyPreset; stops?: SkyStop[] };
    sun?: { enabled?: boolean; intensity?: number };
    moon?: { enabled?: boolean };
    stars?: { enabled?: boolean; density?: number };
    /**
     * planar cloud layer at `altitude` world-units. `thickness` controls the
     * virtual depth the fragment shader marches through to fake 3D volume,
     * larger values give chunkier, more parallaxing clouds. `density` is
     * coverage [0,1]; `wind` is a 2D drift velocity applied to the noise
     * field over `envTime`.
     */
    clouds?: { enabled?: boolean; density?: number; wind?: Vec2; altitude?: number; thickness?: number };
    /**
     * distance fog. fog runs from `start` to `end`, and by default `end` is
     * however far this client can actually see.
     *
     *   `end`     world units, or `'view'` (the default) to track the client's
     *             own view radius. `'view'` is what fades the world out at the
     *             streamed chunk boundary, and it is per-client, since view
     *             radius is a device performance setting a script can't know.
     *   `start`   FRACTION of `end` where the fade begins, not world units, so
     *             authoring never depends on knowing the view radius. 0.9 is a
     *             narrow lip at the boundary; 0.1 is fog across the whole view.
     *   `color`   `'sky'` tracks the sky LUT's horizon at the current time of
     *             day (so sunsets and night work unauthored), or a linear rgb
     *             triple pins it.
     *   `opacity` how opaque fog gets at `end`. 1 fully replaces the colour.
     *
     * Shaped after luanti's `set_sky{fog = {fog_distance, fog_start}}`, where
     * distance is client-controlled by default and start is a fraction of the
     * visible range (doc/lua_api.md).
     *
     * Setting a numeric `end` NEARER than the view radius does not re-expose the
     * chunk boundary: fog is already saturated well before it. Setting one
     * further out leaves the engine's own boundary fade in place underneath.
     *
     *   { end: 30, start: 0.1 }   near, thick, atmospheric fog
     *   { enabled: false }        no fog, world stops hard at the boundary
     */
    fog?: { enabled?: boolean; color?: Vec3 | 'sky'; end?: number | 'view'; start?: number; opacity?: number };
};

/* ── presets ──────────────────────────────────────────────────────── */

// authored stops are sRGB byte triples; the shader works in linear space
// (the texture atlas uses `rgba8unorm-srgb` and decodes on sample), so
// decode at authoring time to keep the LUT and texels in the same space.
const rgb = srgbBytesToLinear;

/**
 * minecraft-like temperate sky. four stops keyed to time-of-day:
 *   t=0    midnight, deep navy, stars dominate
 *   t=0.25 sunrise, muted lavender twilight (orange comes from FOG_SUN_TINT)
 *   t=0.5  noon, bright sky blue
 *   t=0.75 sunset, muted lavender twilight
 *
 * the orange sunset glow is procedural in the shader (`fog_sun_tint` near
 * the sun direction); the LUT itself only carries the ambient sky tone.
 */
const OVERWORLD: SkyStop[] = [
    { t: 0.0, zenith: rgb(12, 16, 40), horizon: rgb(20, 26, 56), nadir: rgb(4, 4, 14) },
    { t: 0.25, zenith: rgb(65, 70, 115), horizon: rgb(95, 110, 160), nadir: rgb(20, 18, 30) },
    { t: 0.5, zenith: rgb(97, 181, 245), horizon: rgb(144, 211, 246), nadir: rgb(60, 70, 88) },
    { t: 0.75, zenith: rgb(65, 70, 115), horizon: rgb(95, 110, 160), nadir: rgb(20, 18, 30) },
];

/**
 * named sky LUT tables. only `overworld` is tuned right now, additional
 * presets will land alongside their target room art (overcast, desert, etc.)
 * so the LUT and game palette get authored together.
 */
export const PRESETS: Record<SkyPreset, SkyStop[]> = {
    overworld: OVERWORLD,
};

/**
 * fog defaults: fade the world out at whatever the client can see.
 *
 * `start: 0.9` is minecraft's terrain-fog band expressed as a fraction. vanilla
 * computes it as `clamp(renderDistance / 10, 4, 64)` world units back from the
 * edge (FogRenderer.setupFog), which at both of our tier radii (6 and 12 chunks)
 * works out to exactly 0.9. the fraction is the luanti form and does not need
 * the radius to be known at authoring time.
 */
const FOG_DEFAULT: ClientEnvironment.ResolvedEnvironment['fog'] = {
    enabled: true,
    color: 'sky',
    end: 'view',
    start: 0.9,
    opacity: 1,
};

/** default config when a room boots. resolved (no optionals). */
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

/* ── api ──────────────────────────────────────────────────────────── */

function activeEnv(ctx: ScriptContext): ClientEnvironment.Environment | null {
    return ctx.client?.room?.environment ?? null;
}

/**
 * advance the environment time, in hours. hot path, one f32 uniform write.
 * safe to call every frame.
 *
 *   0 = midnight, 6 = sunrise, 12 = noon, 18 = sunset. wraps mod 24.
 *
 * the underlying uniform is normalised to [0,1) so a `0.25`-style fraction
 * still works (`setEnvironmentTime(0.25 * 24)`), but hours are the natural unit for
 * game scripts (`setEnvironmentTime(7.5)` reads as 7:30am).
 */
export function setEnvironmentTime(ctx: ScriptContext, hours: number): void {
    const env = activeEnv(ctx);
    if (!env) return;
    ClientEnvironment.applyTime(env, hours / 24);
}

/** current environment time in hours, in [0, 24). */
export function getEnvironmentTime(ctx: ScriptContext): number {
    const env = activeEnv(ctx);
    return env ? env.time * 24 : 0;
}

/**
 * Merge a partial config into the room's environment. Slow path: this
 * repacks and re-uploads the config storage buffer, so call it from script
 * init or in response to game events, never every frame. For time-of-day
 * animation use `setEnvironmentTime`, which is the per-frame hot path.
 *
 * The merge is per-field, not just top-level. Only the fields you set change;
 * everything else keeps its current value, and any group you omit is left
 * entirely untouched. So `setEnvironment(ctx, { clouds: { density: 0.8 } })`
 * changes cloud density alone and leaves cloud wind, sun, sky, etc. as they
 * were. To reset a group, pass every field explicitly (or start from one of
 * the `ENVIRONMENT_*` presets).
 *
 * Groups and their fields:
 *   - `enabled`  master switch for the whole environment. When false, the
 *                renderer also hides the sky and cloud meshes, so this is the
 *                one flag that gates rendering, not just config values.
 *   - `sky`      `{ preset }` selects a named LUT (see `SkyPreset`); `{ stops }`
 *                supplies a custom 4-stop LUT. They are mutually exclusive at
 *                merge time: if both are set, `stops` wins. A preset compiles
 *                to its `stops` array here, so nothing distinguishes the two
 *                downstream.
 *   - `sun`      `enabled` toggles the directional light; `intensity` scales it.
 *   - `moon`     `enabled` toggles the moon sprite.
 *   - `stars`    `enabled` toggles stars; `density` is their coverage.
 *   - `clouds`   see `EnvironmentConfig.clouds` for the field meanings
 *                (altitude / thickness / density / wind).
 *   - `fog`      distance fog, from `start` (a fraction) to `end` (world units
 *                or `'view'`). On by default at `'view'`, which fades the world
 *                out at the streamed chunk boundary. See `EnvironmentConfig.fog`.
 *
 * Example, dim the sun and thicken the clouds on some game event:
 *
 *   setEnvironment(ctx, {
 *       sun: { intensity: 0.2 },
 *       clouds: { enabled: true, density: 0.9, thickness: 4 },
 *   });
 *
 * No-ops if the room has no active client environment (e.g. on the server).
 */
export function setEnvironment(ctx: ScriptContext, config: EnvironmentConfig): void {
    const env = activeEnv(ctx);
    if (!env) return;
    ClientEnvironment.applyConfig(env, config, PRESETS);
}
