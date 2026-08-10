// rainbow.ts, brand-matched flowing rainbow color nodes for editor selection
// visuals.
//
// mirrors the website header gradient (see apps/website/src/app.css
// `.rainbow-*`): a 5-stop palette pink -> yellow -> blue -> purple -> pink that
// slides over time. here the slide runs along a world-space axis, so the bands
// read as anchored to the geometry (not the screen) as the camera orbits.
//
// one shared time uniform feeds every rainbow material; advance it once per
// frame with tickRainbow() so all outlines and fills stay phase-locked. line
// materials and fill materials each get a color node from the same palette,
// differing only in how they recover the fragment's world position (segment
// endpoints for expanded lines, the position attribute for solid fills).

import {
    attribute,
    d,
    dot,
    f32,
    floor,
    fract,
    greaterThanEqual,
    mix,
    modelWorldMatrix,
    mul,
    type Node,
    select,
    sub,
    varying,
    vec3f,
    vec4f,
} from 'gpucat';

// palette stops match the website wordmark gradient, sRGB components / 255:
//   #ff3ea5  #ffd23f  #3fa7ff  #8a2be2  (wraps back to #ff3ea5)
// authored in sRGB to match the eyeballed editor-colors constants (which are
// dropped into the fragment output the same way, no linearization).
//
// `t` wraps to a 4-segment ramp; segment i picks stops (a, b) and interpolates
// by the fractional part. select chains pick the stops branchlessly (the WGSL
// backend lowers these to `select(false, true, cond)`).
function rainbowPalette(t: Node<d.f32>): Node<d.vec3f> {
    const x = mul(fract(t), f32(4));
    const i = floor(x);
    const f = sub(x, i);
    const c0 = vec3f(1.0, 0.243, 0.647);
    const c1 = vec3f(1.0, 0.824, 0.247);
    const c2 = vec3f(0.247, 0.655, 1.0);
    const c3 = vec3f(0.541, 0.169, 0.886);
    const ge1 = greaterThanEqual(i, f32(1));
    const ge2 = greaterThanEqual(i, f32(2));
    const ge3 = greaterThanEqual(i, f32(3));
    // a = [c0, c1, c2, c3][i], b = [c1, c2, c3, c0][i]
    const a = select(select(select(c0, c1, ge1), c2, ge2), c3, ge3);
    const b = select(select(select(c1, c2, ge1), c3, ge2), c0, ge3);
    return mix(a, b, f);
}

// world units per full palette cycle. small enough that a multi-voxel
// selection shows several bands, large enough that a single voxel reads as a
// near-solid colour that still animates through the palette over time.
const PERIOD = 6;
// palette cycles per second along the flow (the time term).
const FLOW_SPEED = 0.15;
// world-space flow axis, a (1,1,1) diagonal keeps the bands moving across any
// face the camera looks at. pre-normalized components (1/sqrt(3)).
const AXIS_X = 0.5774;
const AXIS_Y = 0.5774;
const AXIS_Z = 0.5774;

// phase(worldPos) = dot(worldPos, axis) / PERIOD - time * FLOW_SPEED
// `elapsedTime` is the shared render clock's uniform node (TimeResources),
// threaded in by identity so every rainbow material stays phase-locked with the
// rest of the engine's time-driven animation.
function rainbowPhase(worldPos: Node<d.vec3f>, elapsedTime: Node<d.f32>): Node<d.f32> {
    const along = mul(dot(worldPos, vec3f(AXIS_X, AXIS_Y, AXIS_Z)), f32(1 / PERIOD));
    return sub(along, mul(elapsedTime, f32(FLOW_SPEED)));
}

function rainbowColor(worldPos: Node<d.vec3f>, elapsedTime: Node<d.f32>, alpha: number): Node<d.vec4f> {
    return vec4f(rainbowPalette(rainbowPhase(worldPos, elapsedTime)), f32(alpha)) as unknown as Node<d.vec4f>;
}

/**
 * Rainbow color node for `LineMaterial` outlines (screen-expanded segments).
 *
 * Recovers the fragment's world position from the segment endpoints the line
 * geometry carries per vertex (`instanceStart` / `instanceEnd`), selected by
 * `uv.x` (0 at start, 1 at end). Mixing by `uv.x` and interpolating the result
 * as a varying yields the smooth along-edge world position.
 */
export function rainbowLineColor(elapsedTime: Node<d.f32>, alpha = 1): Node<d.vec4f> {
    const start = attribute('instanceStart', d.vec3f);
    const end = attribute('instanceEnd', d.vec3f);
    const u = attribute('uv', d.vec2f).x;
    const local = mix(start, end, u);
    const world = varying(mul(modelWorldMatrix, vec4f(local, f32(1))).xyz);
    return rainbowColor(world as unknown as Node<d.vec3f>, elapsedTime, alpha);
}

/** Rainbow color node for solid fill meshes (from the `position` attribute). */
export function rainbowFillColor(elapsedTime: Node<d.f32>, alpha: number): Node<d.vec4f> {
    const local = attribute('position', d.vec3f);
    const world = varying(mul(modelWorldMatrix, vec4f(local, f32(1))).xyz);
    return rainbowColor(world as unknown as Node<d.vec3f>, elapsedTime, alpha);
}
