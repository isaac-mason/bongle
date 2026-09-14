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
const POOL: Mat4[] = [];
const _p: Vec3 = [0, 0, 0];
const _q: Quat = [0, 0, 0, 1];

/**
 * visits every shape and pose in `value` (through fields, list items, the union variant the value selects and optional
 * wrappers), composing each pose into its contents; `space: 'world'` restarts the chain at identity. `visit` returns true to stop.
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
            const parent = schema.space === 'world' ? IDENTITY : matrixIn;
            if (schema.kind === undefined) {
                for (const [key, field] of Object.entries(schema.fields)) {
                    if (walkObjects(field, local[key], parent, visit, [...path, key], depth, posePath)) return true;
                }
                return false;
            }
            if (schema.kind !== 'pose') {
                return visit({ schema: schema as ObjectSite['schema'], local, path, parent, matrix: parent, posePath }) === true;
            }
            while (POOL.length <= depth) POOL.push(mat4.create());
            const matrix = POOL[depth]!;
            const position = local.position as Vec3 | undefined;
            const quaternion = local.quaternion as Quat | undefined;
            mat4.fromRotationTranslation(matrix, quaternion ?? quat.identity(_q), position ?? vec3.set(_p, 0, 0, 0));
            mat4.multiply(matrix, parent, matrix);
            if (visit({ schema: schema as ObjectSite['schema'], local, path, parent, matrix, posePath })) return true;
            // the contents live in the pose's frame, and this pose is what places them
            for (const [key, field] of Object.entries(schema.fields)) {
                if (walkObjects(field, local[key], matrix, visit, [...path, key], depth + 1, path)) return true;
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
