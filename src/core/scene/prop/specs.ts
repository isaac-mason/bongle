import { type Mat4, mat4, type Quat, quat, type Vec3, vec3 } from 'math';
import type { PropPath } from './path';
import type { ObjectSchema, Schema, ShapeSpecData } from './prop';

export type ShapeSite = { path: PropPath; spec: ShapeSpecData; local: Record<string, unknown>; space: 'local' | 'world' };

/** one annotated object met by `walkObjects`, with the frames composed for it. */
export type ObjectSite = {
    schema: ObjectSchema;
    local: Record<string, unknown>;
    path: PropPath;
    /** the frame the object's own `frame` is expressed in. */
    parent: Mat4;
    /** `parent` times the object's own frame; what its fields and a `frame` handle live in. */
    matrix: Mat4;
    /** `matrix` times the shape's `center`; what the shape itself is drawn and handled in. */
    shapeMatrix: Mat4;
};

const IDENTITY: Mat4 = mat4.create();
const POOL: { frame: Mat4; shape: Mat4 }[] = [];
const _p: Vec3 = [0, 0, 0];
const _q: Quat = [0, 0, 0, 1];

/**
 * visits every object in `value` (through fields, list items, the union variant the value selects and optional wrappers),
 * composing `frame` annotations along the way; `space: 'world'` restarts the chain at identity. `visit` returns true to stop.
 */
export function walkObjects(
    schema: Schema,
    value: unknown,
    matrixIn: Mat4,
    visit: (site: ObjectSite) => boolean | undefined,
    path: PropPath = [],
    depth = 0,
): boolean {
    switch (schema.type) {
        case 'object': {
            if (value === null || typeof value !== 'object') return false;
            const local = value as Record<string, unknown>;
            while (POOL.length <= depth) POOL.push({ frame: mat4.create(), shape: mat4.create() });
            const pool = POOL[depth]!;
            const parent = schema.space === 'world' ? IDENTITY : matrixIn;
            let matrix = parent;
            if (schema.frame) {
                const position = schema.frame.position ? (local[schema.frame.position] as Vec3 | undefined) : undefined;
                const quaternion = schema.frame.quaternion ? (local[schema.frame.quaternion] as Quat | undefined) : undefined;
                mat4.fromRotationTranslation(pool.frame, quaternion ?? quat.identity(_q), position ?? vec3.set(_p, 0, 0, 0));
                matrix = mat4.multiply(pool.frame, parent, pool.frame);
            }
            let shapeMatrix = matrix;
            const center =
                schema.shape && schema.shape.kind !== 'segment' && schema.shape.center
                    ? (local[schema.shape.center] as Vec3 | undefined)
                    : undefined;
            if (center) {
                mat4.fromTranslation(pool.shape, center);
                shapeMatrix = mat4.multiply(pool.shape, matrix, pool.shape);
            }
            if (visit({ schema, local, path, parent, matrix, shapeMatrix })) return true;
            for (const [key, field] of Object.entries(schema.fields)) {
                if (walkObjects(field, local[key], matrix, visit, [...path, key], depth + 1)) return true;
            }
            return false;
        }
        case 'union': {
            if (value === null || typeof value !== 'object') return false;
            const discriminator = (value as Record<string, unknown>)[schema.key];
            const variant = schema.variants.find((v) => {
                const lit = v.fields[schema.key];
                return lit !== undefined && lit.type === 'literal' && lit.value === discriminator;
            });
            return variant ? walkObjects(variant, value, matrixIn, visit, path, depth) : false;
        }
        case 'list': {
            if (!Array.isArray(value)) return false;
            for (let i = 0; i < value.length; i++) {
                if (walkObjects(schema.of, value[i], matrixIn, visit, [...path, i], depth)) return true;
            }
            return false;
        }
        case 'nullable':
        case 'optional':
        case 'nullish':
            return walkObjects(schema.of, value, matrixIn, visit, path, depth);
        default:
            return false;
    }
}

/** the first shape-annotated object reachable through `value`. */
export function findShape(schema: Schema, value: unknown): ShapeSite | null {
    let found: ShapeSite | null = null;
    walkObjects(schema, value, IDENTITY, (site) => {
        if (!site.schema.shape) return false;
        found = { path: site.path, spec: site.schema.shape, local: site.local, space: site.schema.space ?? 'local' };
        return true;
    });
    return found;
}

/** every shape or frame spec in `schema` that names a field the object lacks or of the wrong kind. */
export function checkSpecs(schema: Schema, path = ''): string[] {
    const problems: string[] = [];
    switch (schema.type) {
        case 'object':
            checkObject(schema, path, problems);
            for (const [key, field] of Object.entries(schema.fields)) problems.push(...checkSpecs(field, `${path}.${key}`));
            return problems;
        case 'union':
            for (const variant of schema.variants) problems.push(...checkSpecs(variant, path));
            return problems;
        case 'list':
        case 'nullable':
        case 'optional':
        case 'nullish':
            return checkSpecs(schema.of, `${path}[]`);
        case 'record':
            return checkSpecs(schema.field, `${path}[]`);
        case 'tuple':
            for (const [i, of] of schema.of.entries()) problems.push(...checkSpecs(of, `${path}[${i}]`));
            return problems;
        default:
            return problems;
    }
}

function checkObject(schema: ObjectSchema, path: string, problems: string[]): void {
    const expect = (field: string | undefined, want: string, test: (s: Schema) => boolean): void => {
        if (field === undefined) return;
        const target = schema.fields[field];
        if (target === undefined) problems.push(`${path}: spec names '${field}', which is not a field`);
        else if (!test(target)) problems.push(`${path}: spec field '${field}' is not ${want}`);
    };
    const shape = schema.shape;
    if (shape) {
        if (shape.kind === 'sphere') {
            expect(shape.radius, 'a radius', (s) => s.type === 'number' && s.subtype === 'radius');
            expect(shape.center, 'a point', (s) => s.type === 'vector3' && s.subtype === 'point');
        } else if (shape.kind === 'box3') {
            expect(shape.halfExtents, 'a vector3', (s) => s.type === 'vector3');
            expect(shape.center, 'a point', (s) => s.type === 'vector3' && s.subtype === 'point');
        } else {
            expect(shape.from, 'a point', (s) => s.type === 'vector3' && s.subtype === 'point');
            expect(shape.to, 'a point', (s) => s.type === 'vector3' && s.subtype === 'point');
        }
    }
    const frame = schema.frame;
    if (frame) {
        expect(frame.position, 'a point', (s) => s.type === 'vector3' && s.subtype === 'point');
        expect(frame.quaternion, 'a quaternion', (s) => s.type === 'quaternion');
    }
}
