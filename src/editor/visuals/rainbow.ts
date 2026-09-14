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
// #ff3ea5, #ffd23f, #3fa7ff, #8a2be2 (wraps back to #ff3ea5).
// `t` wraps to a 4-segment ramp; segment i picks stops (a, b) and interpolates
// by the fractional part, branchlessly via select chains.
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

// world units per full palette cycle.
const PERIOD = 6;
// palette cycles per second along the flow.
const FLOW_SPEED = 0.15;
// world-space flow axis, a (1,1,1) diagonal, pre-normalized (1/sqrt(3)).
const AXIS_X = 0.5774;
const AXIS_Y = 0.5774;
const AXIS_Z = 0.5774;

// phase(worldPos) = dot(worldPos, axis) / PERIOD - time * FLOW_SPEED
function rainbowPhase(worldPos: Node<d.vec3f>, elapsedTime: Node<d.f32>): Node<d.f32> {
    const along = mul(dot(worldPos, vec3f(AXIS_X, AXIS_Y, AXIS_Z)), f32(1 / PERIOD));
    return sub(along, mul(elapsedTime, f32(FLOW_SPEED)));
}

function rainbowColor(worldPos: Node<d.vec3f>, elapsedTime: Node<d.f32>, alpha: number): Node<d.vec4f> {
    return vec4f(rainbowPalette(rainbowPhase(worldPos, elapsedTime)), f32(alpha)) as unknown as Node<d.vec4f>;
}

/** Rainbow color node for `LineMaterial` outlines; recovers world position from the segment endpoints (`instanceStart`/`instanceEnd`) mixed by `uv.x`. */
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
