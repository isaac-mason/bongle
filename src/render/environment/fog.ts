import { abs, cameraPosition, clamp, type d, f32, length, max, mix, mul, type Node, sub, varying, vec2f } from 'gpucat';
import type { Vec3 } from 'math';
import { type Environment, type ResolvedEnvironment, SKY_STOPS } from '../../client/environment';
import { srgbBytesToLinear } from '../../core/color';
import type { EnvironmentResources } from './environment';

// Sunrise/sunset glow tint, matches the sky shader's FOG_SUN_TINT and the deeper red it blends toward at peak.
const FOG_SUN_TINT: Vec3 = srgbBytesToLinear(244, 125, 29);
const FOG_SUNSET_DEEP_TINT: Vec3 = srgbBytesToLinear(255, 70, 30);

/** How much of the sky's sun-wash a single fog colour inherits at peak sunset; the sky's own wash is direction-dependent, but fog is one colour for the whole horizon. */
const FOG_SUNSET_TINT_WEIGHT = 0.5;

/** Default fraction of `end` at which the fade begins, for the engine's own boundary guard when a game pins a numeric `end`. */
const BOUNDARY_GUARD_START = 0.9;
const CHUNK_SIZE = 16;

/** Start/end written for a disabled band: `dist < start` for any reachable fragment, so the term evaluates to 0 without a branch. */
const BAND_DISABLED_START = 1e9;
const BAND_DISABLED_END = 1e9 + 1;

/** The two distance bands fog is evaluated against: spherical (`start`/`end`, pinned by a numeric `fog.end`) and cylindrical (`renderStart`/`renderEnd`, sized from view radius). The shader takes whichever is thicker. */
export type FogBands = { start: number; end: number; renderStart: number; renderEnd: number };

export function createFogBands(): FogBands {
    return { start: BAND_DISABLED_START, end: BAND_DISABLED_END, renderStart: BAND_DISABLED_START, renderEnd: BAND_DISABLED_END };
}

/**
 * Resolves both bands from the room's single `fog` group plus this client's view radius.
 * `end: 'view'` gives one cylindrical band across the view radius, so looking straight up
 * doesn't fog the sky at a radius where the horizontal edge is still far away. `end: <number>`
 * gives a spherical band at the authored distance, plus the boundary guard underneath it.
 * Disabled turns both bands off, so the world stops hard at the boundary.
 */
export function resolveFogBands(out: FogBands, config: ResolvedEnvironment, viewChunkRadius: number): void {
    const fog = config.fog;
    if (!fog.enabled || !config.enabled) {
        out.start = BAND_DISABLED_START;
        out.end = BAND_DISABLED_END;
        out.renderStart = BAND_DISABLED_START;
        out.renderEnd = BAND_DISABLED_END;
        return;
    }

    const viewDistance = viewChunkRadius * CHUNK_SIZE;
    if (fog.end === 'view') {
        // The authored fraction drives the view-sized band directly.
        out.start = BAND_DISABLED_START;
        out.end = BAND_DISABLED_END;
        out.renderStart = viewDistance * fog.start;
        out.renderEnd = viewDistance;
        return;
    }

    out.start = fog.end * fog.start;
    out.end = fog.end;
    out.renderStart = viewDistance * BOUNDARY_GUARD_START;
    out.renderEnd = viewDistance;
}

/** Resolves this frame's fog rgb into `out`. An authored colour passes through; `'sky'` lerps the sky LUT's horizon stop by time-of-day and applies the same dim/sunset tint the sky shader paints. */
export function resolveFogColor(out: Vec3, env: Environment): void {
    const fog = env.config.fog;
    if (fog.color !== 'sky') {
        out[0] = fog.color[0];
        out[1] = fog.color[1];
        out[2] = fog.color[2];
        return;
    }

    // 4-stop wrap-lerp of the horizon triple, mirroring the sky shader's LUT walk in `buildSkyMaterial`.
    const scaled = env.time * SKY_STOPS;
    const segF = Math.floor(scaled);
    const fracT = scaled - segF;
    const stops = env.config.sky.stops;
    // Clamp short LUTs to their last stop, matching `buildSkyValue`'s padding.
    const a = stops[Math.min(segF % SKY_STOPS, stops.length - 1)]!;
    const b = stops[Math.min((segF + 1) % SKY_STOPS, stops.length - 1)]!;
    let r = a.horizon[0] + (b.horizon[0] - a.horizon[0]) * fracT;
    let g = a.horizon[1] + (b.horizon[1] - a.horizon[1]) * fracT;
    let bl = a.horizon[2] + (b.horizon[2] - a.horizon[2]) * fracT;

    // Sunset peaks when the sun sits right at the horizon; same curve as the sky shader's sunsetNear * sunAboveGate.
    const sunAngle = (env.time - 0.25) * Math.PI * 2;
    const sunY = Math.sin(sunAngle);
    const sunsetNear = 1 - Math.min(Math.max(Math.abs(sunY) * 3.5, 0), 1);
    const sunAboveGate = smoothstep(-0.12, 0.08, sunY);
    const sunsetFactor = sunsetNear * sunAboveGate;

    const skyDim = 1 - sunsetFactor * 0.35;
    r *= skyDim;
    g *= skyDim;
    bl *= skyDim;

    const tintW = sunsetFactor * FOG_SUNSET_TINT_WEIGHT;
    const tintR = FOG_SUN_TINT[0] + (FOG_SUNSET_DEEP_TINT[0] - FOG_SUN_TINT[0]) * sunsetFactor;
    const tintG = FOG_SUN_TINT[1] + (FOG_SUNSET_DEEP_TINT[1] - FOG_SUN_TINT[1]) * sunsetFactor;
    const tintB = FOG_SUN_TINT[2] + (FOG_SUNSET_DEEP_TINT[2] - FOG_SUN_TINT[2]) * sunsetFactor;

    out[0] = r + (tintR - r) * tintW;
    out[1] = g + (tintG - g) * tintW;
    out[2] = bl + (tintB - bl) * tintW;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
    return t * t * (3 - 2 * t);
}

/**
 * Sodium-style `getFragDistance`: (cylindrical, spherical) distance in camera-relative
 * world space, computed per-vertex and interpolated. Must be world-relative, not
 * view-space, since view-space y is camera-up and the cylindrical term needs world-up.
 */
export function fogDistance(worldPos: Node<d.vec3f>, name: string): Node<d.vec2f> {
    const rel = sub(worldPos, cameraPosition).toVar(`${name}Rel`);
    return varying(vec2f(max(length(rel.xz), abs(rel.y)), length(rel)), name);
}

/** Linear ramp; the denominator is floored so a degenerate start == end band can't divide by zero. */
function linearFog(dist: Node<d.f32>, start: Node<d.f32>, end: Node<d.f32>): Node<d.f32> {
    return clamp(sub(dist, start).div(max(sub(end, start), f32(1e-4))), f32(0), f32(1));
}

/**
 * Mixes `rgb` toward the fog colour. RGB-only by construction, so translucent surfaces
 * fog without their blend weight changing. `fogOpacity` scales the environmental term
 * only; the render-distance term always reaches full since it's a correctness feature,
 * not an art knob, and a partial one would leave the chunk boundary visible.
 */
export function applyFog(env: EnvironmentResources, rgb: Node<d.vec3f>, dist: Node<d.vec2f>): Node<d.vec3f> {
    const cfg = env.cfgNode;
    const t = env.timeNode;

    const envValue = mul(mul(linearFog(dist.y, t.fogStart, t.fogEnd), cfg.fogEnabled.toF32()), cfg.fogOpacity).toVar(
        'fogEnvValue',
    );
    const renderValue = linearFog(dist.x, t.renderFogStart, t.renderFogEnd).toVar('fogRenderValue');
    const fogValue = mul(max(envValue, renderValue), cfg.enabled.toF32()).toVar('fogValue');

    return mix(rgb, t.fogColor, fogValue).toVar('fogged');
}
