import { type Mat4, mat4, type Vec3, vec3 } from 'math';
import { getVisualWorldMatrix, TransformTrait } from '../../builtins/transform';
import { registry } from '../../core/registry';
import type { ShapeSpecData } from '../../core/scene/prop/prop';
import { walkObjects } from '../../core/scene/prop/specs';
import type { Node } from '../../core/scene/scene-tree';
import { getTrait } from '../../core/scene/scene-tree';
import * as Lines from '../../render/overlay/lines';
import type { Rgba } from './editor-colors';

const CIRCLE_SEGMENTS = 32;

const GREAT_CIRCLE_ALPHA = 0.35;

let _eye: Vec3 = [0, 0, 0];

/** every shape-annotated object in the node's controls, each under its enclosing frames. */
export function drawNode(lines: Lines.LineBatch, node: Node, color: Rgba, eye: Vec3): void {
    const transform = getTrait(node, TransformTrait);
    if (!transform) return;
    _eye = eye;
    const world = getVisualWorldMatrix(transform);
    for (let slot = 0; slot < node.traits.length; slot++) {
        const instance = node.traits[slot];
        const handle = registry.slotToTrait[slot];
        if (!instance || !handle) continue;
        for (const reg of handle.def.controls) {
            walkObjects(reg.schema, reg.get(instance), world, (site) => {
                if (site.schema.shape) drawShape(lines, site.schema.shape, site.local, site.shapeMatrix, color);
                return false;
            });
        }
    }
}

const _a: Vec3 = [0, 0, 0];

const _b: Vec3 = [0, 0, 0];

const _identityBox: Mat4 = mat4.create();

/** the 12 edges of a world-space box. */
export function drawAabb(lines: Lines.LineBatch, aabb: ArrayLike<number>, color: Rgba): void {
    const [x0, y0, z0, x1, y1, z1] = [aabb[0]!, aabb[1]!, aabb[2]!, aabb[3]!, aabb[4]!, aabb[5]!];
    for (const y of [y0, y1]) for (const z of [z0, z1]) segment(lines, _identityBox, x0, y, z, x1, y, z, color);
    for (const x of [x0, x1]) for (const z of [z0, z1]) segment(lines, _identityBox, x, y0, z, x, y1, z, color);
    for (const x of [x0, x1]) for (const y of [y0, y1]) segment(lines, _identityBox, x, y, z0, x, y, z1, color);
}

function segment(
    lines: Lines.LineBatch,
    matrix: Mat4,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    color: Rgba,
): void {
    vec3.transformMat4(_a, vec3.set(_a, ax, ay, az), matrix);
    vec3.transformMat4(_b, vec3.set(_b, bx, by, bz), matrix);
    Lines.line(lines, _a[0], _a[1], _a[2], _b[0], _b[1], _b[2], color[0], color[1], color[2], color[3]);
}

function drawShape(lines: Lines.LineBatch, spec: ShapeSpecData, local: Record<string, unknown>, matrix: Mat4, color: Rgba): void {
    if (spec.kind === 'box3') {
        const half = local[spec.halfExtents] as Vec3 | undefined;
        if (half) box(lines, matrix, half[0], half[1], half[2], color);
    } else if (spec.kind === 'sphere') {
        const radius = local[spec.radius] as number | undefined;
        if (radius !== undefined) sphere(lines, matrix, 0, 0, 0, radius, color);
    } else if (spec.kind === 'segment') {
        const from = local[spec.from] as Vec3 | undefined;
        const to = local[spec.to] as Vec3 | undefined;
        if (from && to) segment(lines, matrix, from[0], from[1], from[2], to[0], to[1], to[2], color);
    }
}

function box(lines: Lines.LineBatch, matrix: Mat4, hx: number, hy: number, hz: number, color: Rgba): void {
    for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) segment(lines, matrix, -hx, sy * hy, sz * hz, hx, sy * hy, sz * hz, color);
    }
    for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) segment(lines, matrix, sx * hx, -hy, sz * hz, sx * hx, hy, sz * hz, color);
    }
    for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) segment(lines, matrix, sx * hx, sy * hy, -hz, sx * hx, sy * hy, hz, color);
    }
}

const _center: Vec3 = [0, 0, 0];

const _toEye: Vec3 = [0, 0, 0];

const _u: Vec3 = [0, 0, 0];

const _v: Vec3 = [0, 0, 0];

const _p0: Vec3 = [0, 0, 0];

const _p1: Vec3 = [0, 0, 0];

const _identity: Mat4 = mat4.create();

/** the circle where the sphere's surface turns away from the eye; the ring an onlooker actually sees. */
export function silhouette(center: Vec3, radius: number, eye: Vec3, outCenter: Vec3, outU: Vec3, outV: Vec3): number {
    vec3.subtract(_toEye, eye, center);
    const d = vec3.length(_toEye);
    if (d <= radius) return 0;
    vec3.scale(_toEye, _toEye, 1 / d);
    const ringRadius = (radius * Math.sqrt(d * d - radius * radius)) / d;
    vec3.scaleAndAdd(outCenter, center, _toEye, (radius * radius) / d);
    const helper: Vec3 = Math.abs(_toEye[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    vec3.normalize(outU, vec3.cross(outU, helper, _toEye));
    vec3.cross(outV, _toEye, outU);
    return ringRadius;
}

function sphere(lines: Lines.LineBatch, matrix: Mat4, cx: number, cy: number, cz: number, radius: number, color: Rgba): void {
    const step = (Math.PI * 2) / CIRCLE_SEGMENTS;
    const dim: Rgba = [color[0], color[1], color[2], color[3] * GREAT_CIRCLE_ALPHA];
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const a0 = i * step;
        const a1 = a0 + step;
        const c0 = Math.cos(a0) * radius;
        const s0 = Math.sin(a0) * radius;
        const c1 = Math.cos(a1) * radius;
        const s1 = Math.sin(a1) * radius;
        segment(lines, matrix, cx + c0, cy + s0, cz, cx + c1, cy + s1, cz, dim);
        segment(lines, matrix, cx, cy + c0, cz + s0, cx, cy + c1, cz + s1, dim);
        segment(lines, matrix, cx + c0, cy, cz + s0, cx + c1, cy, cz + s1, dim);
    }
    vec3.transformMat4(_center, vec3.set(_center, cx, cy, cz), matrix);
    const ringRadius = silhouette(_center, radius, _eye, _center, _u, _v);
    if (ringRadius === 0) return;
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const a0 = i * step;
        const a1 = a0 + step;
        vec3.scaleAndAdd(_p0, _center, _u, Math.cos(a0) * ringRadius);
        vec3.scaleAndAdd(_p0, _p0, _v, Math.sin(a0) * ringRadius);
        vec3.scaleAndAdd(_p1, _center, _u, Math.cos(a1) * ringRadius);
        vec3.scaleAndAdd(_p1, _p1, _v, Math.sin(a1) * ringRadius);
        segment(lines, _identity, _p0[0], _p0[1], _p0[2], _p1[0], _p1[1], _p1[2], color);
    }
}
