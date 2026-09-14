import { type Mat4, mat4, type Vec3, vec3 } from 'math';
import { type Box3, box3 } from 'math/shapes';
import { getVisualWorldMatrix, TransformTrait } from '../../builtins/transform';
import type { Resources } from '../../core/resources';
import type { Node } from '../../core/scene/scene-tree';
import { getTrait } from '../../core/scene/scene-tree';
import * as Lines from '../../render/overlay/lines';
import { unionSubtreeLocalAabb } from '../node-aabb';

const EMPTY_HALF = 0.5;
const EDGE_STEPS = 8;

// the website wordmark gradient, flowing along the (1,1,1) diagonal; mirrors rainbow.ts for the line batch.
const STOPS: [number, number, number][] = [
    [1.0, 0.243, 0.647],
    [1.0, 0.824, 0.247],
    [0.247, 0.655, 1.0],
    [0.541, 0.169, 0.886],
];
const PERIOD = 6;
const FLOW_SPEED = 0.15;
const AXIS = 0.5774;

const _color: [number, number, number] = [0, 0, 0];

function rainbow(x: number, y: number, z: number, seconds: number): [number, number, number] {
    const phase = ((x + y + z) * AXIS) / PERIOD - seconds * FLOW_SPEED;
    const t = (phase - Math.floor(phase)) * 4;
    const i = Math.floor(t);
    const f = t - i;
    const a = STOPS[i]!;
    const b = STOPS[(i + 1) % 4]!;
    _color[0] = a[0] + (b[0] - a[0]) * f;
    _color[1] = a[1] + (b[1] - a[1]) * f;
    _color[2] = a[2] + (b[2] - a[2]) * f;
    return _color;
}

const _aabb: Box3 = box3.create();
const _a: Vec3 = [0, 0, 0];
const _b: Vec3 = [0, 0, 0];
const _p: Vec3 = [0, 0, 0];
const _q: Vec3 = [0, 0, 0];

function edge(
    lines: Lines.LineBatch,
    m: Mat4,
    seconds: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
): void {
    vec3.transformMat4(_a, vec3.set(_a, ax, ay, az), m);
    vec3.transformMat4(_b, vec3.set(_b, bx, by, bz), m);
    for (let i = 0; i < EDGE_STEPS; i++) {
        vec3.lerp(_p, _a, _b, i / EDGE_STEPS);
        vec3.lerp(_q, _a, _b, (i + 1) / EDGE_STEPS);
        const [r, g, b] = rainbow((_p[0] + _q[0]) / 2, (_p[1] + _q[1]) / 2, (_p[2] + _q[2]) / 2, seconds);
        Lines.line(lines, _p[0], _p[1], _p[2], _q[0], _q[1], _q[2], r, g, b, 1);
    }
}

const _identity: Mat4 = mat4.create();

/** a world-space box in the same rainbow flow; the inspected block uses it. */
export function drawAabb(lines: Lines.LineBatch, aabb: ArrayLike<number>, seconds: number): void {
    const [x0, y0, z0, x1, y1, z1] = [aabb[0]!, aabb[1]!, aabb[2]!, aabb[3]!, aabb[4]!, aabb[5]!];
    for (const y of [y0, y1]) for (const z of [z0, z1]) edge(lines, _identity, seconds, x0, y, z, x1, y, z);
    for (const x of [x0, x1]) for (const z of [z0, z1]) edge(lines, _identity, seconds, x, y0, z, x, y1, z);
    for (const x of [x0, x1]) for (const y of [y0, y1]) edge(lines, _identity, seconds, x, y, z0, x, y, z1);
}

/** the selection box: the subtree's bounds in the node's own frame, drawn through its world matrix. */
export function draw(lines: Lines.LineBatch, node: Node, resources: Resources, seconds: number): void {
    const transform = getTrait(node, TransformTrait);
    if (!transform) return;
    box3.set(_aabb, Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
    if (!unionSubtreeLocalAabb(node, resources, _aabb)) {
        box3.set(_aabb, -EMPTY_HALF, -EMPTY_HALF, -EMPTY_HALF, EMPTY_HALF, EMPTY_HALF, EMPTY_HALF);
    }
    const m = getVisualWorldMatrix(transform);
    const [x0, y0, z0, x1, y1, z1] = _aabb;
    for (const y of [y0, y1]) for (const z of [z0, z1]) edge(lines, m, seconds, x0, y, z, x1, y, z);
    for (const x of [x0, x1]) for (const z of [z0, z1]) edge(lines, m, seconds, x, y0, z, x, y1, z);
    for (const x of [x0, x1]) for (const y of [y0, y1]) edge(lines, m, seconds, x, y, z0, x, y, z1);
}
