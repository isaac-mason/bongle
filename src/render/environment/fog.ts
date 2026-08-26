/**
 * distance fog, forward, applied per-fragment by every world material.
 *
 * scripts see ONE `fog` group (`start` fraction, `end` in world units or
 * `'view'`). internally that resolves to two distance bands, max'd together the
 * way minecraft/sodium do it, and which band carries the fog depends on `end`:
 *   SPHERICAL, `length(camRel)`, used when a game pins a numeric `end`. the
 *     natural shape for near, authored fog: a ball of it around the camera.
 *   CYLINDRICAL, `max(length(xz), abs(y))`, sized from this client's view
 *     radius. carries `end: 'view'` (the default), and otherwise sits
 *     underneath a numeric `end` as a guard so the streamed chunk boundary is
 *     hidden either way. cylindrical is the trick: looking straight up or down
 *     must not fog the sky or your feet at a radius where the horizontal edge
 *     is still far away.
 * the split never reaches the API — see `resolveFogBands`.
 *
 * the fog COLOR is resolved on the CPU once per frame (`resolveFogColor`) and
 * written to the per-frame `envTime` UBO, so the shader reads one colour with no
 * mode branch. `'sky'` tracks the sky LUT's horizon stop at the current time of
 * day, which is what keeps the seam between fogged terrain and the sky behind it
 * closed as the sun moves.
 *
 * the sky sphere, sun/moon and stars are NOT fogged, they are what fog fades
 * into. neither is the cloud layer: it already fades on its own HORIZONTAL
 * distance (cloud-visuals precomputes a per-instance `fadeOut` from `horizDist`),
 * and the cylindrical term would wrongly erase clouds directly overhead, whose
 * `abs(y)` is the cloud altitude regardless of how close they are.
 */

import { abs, cameraPosition, clamp, type d, f32, length, max, mix, mul, type Node, sub, varying, vec2f } from 'gpucat';
import type { Vec3 } from 'math';
import { type Environment, type ResolvedEnvironment, SKY_STOPS } from '../../client/environment';
import { srgbBytesToLinear } from '../../core/color';
import type { EnvironmentResources } from './environment';

/* ── tunables ─────────────────────────────────────────────────────── */

// sunrise/sunset glow tint, matches the sky shader's FOG_SUN_TINT, and the
// deeper red it blends toward at peak (SUNSET_DEEP_TINT).
const FOG_SUN_TINT: Vec3 = srgbBytesToLinear(244, 125, 29);
const FOG_SUNSET_DEEP_TINT: Vec3 = srgbBytesToLinear(255, 70, 30);

/** how much of the sky's sun-wash a single fog colour inherits at peak sunset.
 *  the sky's own wash is direction-dependent and peaks at the sun; fog is one
 *  colour for the whole horizon, so it takes a fraction. */
const FOG_SUNSET_TINT_WEIGHT = 0.5;

/** default fraction of `end` at which the fade begins, used for the engine's own
 *  boundary guard when a game pins a numeric `end`. matches `FOG_DEFAULT.start`:
 *  minecraft's `clamp(renderDistance / 10, 4, 64)` band works out to exactly 0.9
 *  at both of our tier radii. */
const BOUNDARY_GUARD_START = 0.9;
const CHUNK_SIZE = 16;

/** start/end written for a disabled band. `dist < start` for any reachable
 *  fragment, so the term evaluates to 0 without a branch. */
const BAND_DISABLED_START = 1e9;
const BAND_DISABLED_END = 1e9 + 1;

/** the two distance bands fog is evaluated against. `start`/`end` is the
 *  SPHERICAL band a game pins with a numeric `fog.end`; `renderStart`/`renderEnd`
 *  is the CYLINDRICAL one sized from this client's view radius. the shader takes
 *  whichever is thicker, so the cylindrical one doubles as a guard: a game that
 *  pins fog further out than it can see still gets its chunk boundary hidden. */
export type FogBands = { start: number; end: number; renderStart: number; renderEnd: number };

export function createFogBands(): FogBands {
    return { start: BAND_DISABLED_START, end: BAND_DISABLED_END, renderStart: BAND_DISABLED_START, renderEnd: BAND_DISABLED_END };
}

/**
 * resolve both bands from the room's single `fog` group plus this client's view
 * radius. shaped after luanti's `set_sky{fog}`, where `fog_distance` defaults to
 * client-controlled and `fog_start` is a fraction of the visible range.
 *
 *   `end: 'view'`   one cylindrical band across the view radius. cylindrical so
 *                   looking straight up does not fog the sky at a radius where
 *                   the horizontal edge is still far away.
 *   `end: <number>` a spherical band at the authored distance, plus the boundary
 *                   guard left in place underneath it.
 *   disabled        both bands off, world stops hard at the boundary.
 *
 * no minimum on the view distance: minecraft floors it at 32 units, but that
 * only fires below a 2-chunk radius, and there it would end fog PAST the drawn
 * terrain and expose the very boundary the cylindrical band hides.
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
        // the authored fraction drives the view-sized band directly.
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

/**
 * resolve this frame's fog rgb into `out`. an authored colour passes through;
 * `'sky'` lerps the sky LUT's horizon stop by time-of-day and applies the same
 * dim + sunset tint the sky shader paints, so distant terrain fades into
 * roughly the colour the sky is actually showing behind it.
 */
export function resolveFogColor(out: Vec3, env: Environment): void {
    const fog = env.config.fog;
    if (fog.color !== 'sky') {
        out[0] = fog.color[0];
        out[1] = fog.color[1];
        out[2] = fog.color[2];
        return;
    }

    // 4-stop wrap-lerp of the horizon triple, mirroring the sky shader's LUT
    // walk (buildSkyMaterial) so both land on the same colour.
    const scaled = env.time * SKY_STOPS;
    const segF = Math.floor(scaled);
    const fracT = scaled - segF;
    const stops = env.config.sky.stops;
    // clamp short LUTs to their last stop, matching `buildSkyValue`'s padding.
    const a = stops[Math.min(segF % SKY_STOPS, stops.length - 1)]!;
    const b = stops[Math.min((segF + 1) % SKY_STOPS, stops.length - 1)]!;
    let r = a.horizon[0] + (b.horizon[0] - a.horizon[0]) * fracT;
    let g = a.horizon[1] + (b.horizon[1] - a.horizon[1]) * fracT;
    let bl = a.horizon[2] + (b.horizon[2] - a.horizon[2]) * fracT;

    // sunset peaks when the sun sits right at the horizon. same curve as the
    // sky shader's sunsetNear * sunAboveGate.
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

/* ── shader ───────────────────────────────────────────────────────── */

/**
 * sodium's `getFragDistance`: (cylindrical, spherical) distance in
 * camera-relative WORLD space. computed per-vertex and interpolated, as sodium
 * does. must be world-relative, not view-space: view-space y is camera-up, and
 * the cylindrical term needs world-up.
 *
 * f32 precision degrades far from origin at minecraft-scale coords, but every
 * caller already does `cameraViewMatrix * worldPos` with the same exposure, so
 * this adds no new failure mode.
 */
export function fogDistance(worldPos: Node<d.vec3f>, name: string): Node<d.vec2f> {
    const rel = sub(worldPos, cameraPosition).toVar(`${name}Rel`);
    return varying(vec2f(max(length(rel.xz), abs(rel.y)), length(rel)), name);
}

/** linear ramp, sodium's `linear_fog_value`. the denominator is floored so a
 *  degenerate start == end band can't divide by zero. */
function linearFog(dist: Node<d.f32>, start: Node<d.f32>, end: Node<d.f32>): Node<d.f32> {
    return clamp(sub(dist, start).div(max(sub(end, start), f32(1e-4))), f32(0), f32(1));
}

/**
 * mix `rgb` toward the fog colour. rgb-only by construction (callers pass the
 * colour before the vec4 is assembled), so translucent surfaces fog without
 * their blend weight changing.
 *
 * `fogOpacity` scales the ENVIRONMENTAL term only. the render-distance term
 * always reaches full: it is a rendering-correctness feature, not an art knob,
 * and a partial one would leave the chunk boundary visible.
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
