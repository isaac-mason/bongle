import type { PropPath } from './path';
import type { ObjectSchema, Schema, ShapeSpecData } from './prop';

export type ShapeSite = { path: PropPath; spec: ShapeSpecData; local: Record<string, unknown> };

/** the first shape-annotated object reachable through `value`: object fields, list items and the union variant the value selects. */
export function findShape(schema: Schema, value: unknown, path: PropPath = []): ShapeSite | null {
    switch (schema.type) {
        case 'object': {
            if (value === null || typeof value !== 'object') return null;
            const local = value as Record<string, unknown>;
            if (schema.shape) return { path, spec: schema.shape, local };
            for (const [key, field] of Object.entries(schema.fields)) {
                const found = findShape(field, local[key], [...path, key]);
                if (found) return found;
            }
            return null;
        }
        case 'union': {
            if (value === null || typeof value !== 'object') return null;
            const discriminator = (value as Record<string, unknown>)[schema.key];
            const variant = schema.variants.find((v) => {
                const lit = v.fields[schema.key];
                return lit !== undefined && lit.type === 'literal' && lit.value === discriminator;
            });
            return variant ? findShape(variant, value, path) : null;
        }
        case 'list': {
            if (!Array.isArray(value)) return null;
            for (let i = 0; i < value.length; i++) {
                const found = findShape(schema.of, value[i], [...path, i]);
                if (found) return found;
            }
            return null;
        }
        case 'nullable':
        case 'optional':
        case 'nullish':
            return findShape(schema.of, value, path);
        default:
            return null;
    }
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
