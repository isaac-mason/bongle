import { type Mat4, mat4, type Quat, quat, type Vec3, vec3 } from 'math';
import type { PropPath } from './path';
import type { ObjectKind, ObjectSchema, Schema } from './prop';

/** one kinded object (a shape or a pose) met by `walkObjects`, with the frames composed for it. */
export type ObjectSite = {
    schema: ObjectSchema & { kind: ObjectKind };
    local: Record<string, unknown>;
    path: PropPath;
    /** the frame the object's fields are expressed in: node world times every enclosing pose. */
    parent: Mat4;
    /** the object's own frame: `parent` times its pose; a shape sits at `parent`'s origin so this is `parent` itself. */
    matrix: Mat4;
    /** the nearest pose enclosing the object, the one that places it; null when only the node does. */
    posePath: PropPath | null;
};

const IDENTITY: Mat4 = mat4.create();
const POOL: { frame: Mat4; own: Mat4 }[] = [];
const _p: Vec3 = [0, 0, 0];
const _q: Quat = [0, 0, 0, 1];

/** the pose field that frames `schema`'s other fields, seen through optional wrappers; null when it has none. */
export function poseFieldOf(schema: ObjectSchema): string | null {
    for (const [key, field] of Object.entries(schema.fields)) {
        if (unwrap(field).kind === 'pose') return key;
    }
    return null;
}

function unwrap(schema: Schema): { kind: ObjectKind | undefined; space: 'local' | 'world' } {
    let inner = schema;
    while (inner.type === 'nullable' || inner.type === 'optional' || inner.type === 'nullish') inner = inner.of;
    return inner.type === 'object' ? { kind: inner.kind, space: inner.space ?? 'local' } : { kind: undefined, space: 'local' };
}

/**
 * visits every shape and pose in `value` (through fields, list items, the union variant the value selects and optional
 * wrappers). an object holding a pose field is framed by it; `space: 'world'` restarts the chain at identity.
 * `visit` returns true to stop.
 */
export function walkObjects(
    schema: Schema,
    value: unknown,
    matrixIn: Mat4,
    visit: (site: ObjectSite) => boolean | undefined,
    path: PropPath = [],
    depth = 0,
    posePath: PropPath | null = null,
): boolean {
    switch (schema.type) {
        case 'object': {
            if (value === null || typeof value !== 'object') return false;
            const local = value as Record<string, unknown>;
            while (POOL.length <= depth) POOL.push({ frame: mat4.create(), own: mat4.create() });
            const pool = POOL[depth]!;
            const parent = schema.space === 'world' ? IDENTITY : matrixIn;
            if (schema.kind === 'pose') {
                const position = local.position as Vec3 | undefined;
                const quaternion = local.quaternion as Quat | undefined;
                mat4.fromRotationTranslation(pool.own, quaternion ?? quat.identity(_q), position ?? vec3.set(_p, 0, 0, 0));
                mat4.multiply(pool.own, parent, pool.own);
                return (
                    visit({ schema: schema as ObjectSite['schema'], local, path, parent, matrix: pool.own, posePath }) === true
                );
            }
            if (schema.kind !== undefined) {
                return visit({ schema: schema as ObjectSite['schema'], local, path, parent, matrix: parent, posePath }) === true;
            }
            let matrix = parent;
            const poseField = poseFieldOf(schema);
            if (poseField !== null) {
                const poseSpace = unwrap(schema.fields[poseField]!).space;
                const pose = local[poseField] as { position?: Vec3; quaternion?: Quat } | null | undefined;
                mat4.fromRotationTranslation(
                    pool.frame,
                    pose?.quaternion ?? quat.identity(_q),
                    pose?.position ?? vec3.set(_p, 0, 0, 0),
                );
                matrix = mat4.multiply(pool.frame, poseSpace === 'world' ? IDENTITY : parent, pool.frame);
            }
            for (const [key, field] of Object.entries(schema.fields)) {
                // the pose is visited in the frame it is expressed in, its siblings in the frame it makes
                const isPose = key === poseField;
                const fieldMatrix = isPose ? parent : matrix;
                const fieldPose = isPose || poseField === null ? posePath : [...path, poseField];
                if (walkObjects(field, local[key], fieldMatrix, visit, [...path, key], depth + 1, fieldPose)) return true;
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
            return variant ? walkObjects(variant, value, matrixIn, visit, path, depth, posePath) : false;
        }
        case 'list': {
            if (!Array.isArray(value)) return false;
            for (let i = 0; i < value.length; i++) {
                if (walkObjects(schema.of, value[i], matrixIn, visit, [...path, i], depth, posePath)) return true;
            }
            return false;
        }
        case 'nullable':
        case 'optional':
        case 'nullish':
            return walkObjects(schema.of, value, matrixIn, visit, path, depth, posePath);
        default:
            return false;
    }
}

export type ShapeKind = Exclude<ObjectKind, 'pose'>;

export type ShapeSite = ObjectSite & { schema: ObjectSchema & { kind: ShapeKind } };

export function isShape(site: ObjectSite): site is ShapeSite {
    return site.schema.kind !== 'pose';
}

/** the first shape reachable through `value`, its matrices relative to the walk root (the node). */
export function findShape(schema: Schema, value: unknown): ShapeSite | null {
    let found: ShapeSite | null = null;
    walkObjects(schema, value, IDENTITY, (site) => {
        if (!isShape(site)) return false;
        found = { ...site, parent: mat4.clone(site.parent), matrix: mat4.clone(site.matrix) };
        return true;
    });
    return found;
}

/** every object in `schema` whose frame is ambiguous because it holds more than one pose field. */
export function checkSpecs(schema: Schema, path = ''): string[] {
    const problems: string[] = [];
    switch (schema.type) {
        case 'object': {
            const poses = Object.entries(schema.fields)
                .filter(([, field]) => unwrap(field).kind === 'pose')
                .map(([key]) => key);
            if (poses.length > 1)
                problems.push(`${path}: holds ${poses.length} pose fields (${poses.join(', ')}), only one can frame it`);
            for (const [key, field] of Object.entries(schema.fields)) problems.push(...checkSpecs(field, `${path}.${key}`));
            return problems;
        }
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
