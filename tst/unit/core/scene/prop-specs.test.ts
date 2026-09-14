import { mat4 } from 'math';
import { describe, expect, it } from 'vitest';
import { RigidBodyDef, TransformedShapeDef } from '../../../../src/builtins/rigid-body';
import { checkSpecs, prop, validate } from '../../../../src/core/scene/prop';
import { findShape, poseFieldOf, walkObjects } from '../../../../src/core/scene/prop/specs';

describe('shape and pose value types', () => {
    it('a shape is an object with a fixed layout and a type literal, so shapes union on `type`', () => {
        expect(prop.sphere()).toEqual({
            type: 'object',
            kind: 'sphere',
            fields: { type: prop.literal('sphere'), radius: prop.radius() },
        });
        expect(prop.box3({ space: 'world' })).toMatchObject({ kind: 'box3', space: 'world' });
        expect(Object.keys(prop.segment().fields)).toEqual(['type', 'from', 'to']);
        expect(Object.keys(prop.pose().fields)).toEqual(['position', 'quaternion']);
        const Zone = prop.union('type', [prop.box3(), prop.sphere()]);
        expect(validate(Zone, { type: 'sphere', radius: 1 })).toEqual([]);
        expect(validate(Zone, { type: 'box3', halfExtents: [1, 1, 1] })).toEqual([]);
        expect(validate(Zone, { type: 'sphere' }).length).toBeGreaterThan(0);
    });

    it('the rigid body defs are built from the value types and pass the check', () => {
        expect(poseFieldOf(TransformedShapeDef)).toBe('pose');
        expect(checkSpecs(RigidBodyDef)).toEqual([]);
        const good: unknown = {
            shape: {
                type: 'transformed',
                pose: { position: [1, 0, 0], quaternion: [0, 0, 0, 1] },
                shape: { type: 'sphere', radius: 1 },
            },
        };
        expect(validate(RigidBodyDef, good)).toEqual([]);
    });

    it('an object with two pose fields is reported, through unions and lists', () => {
        const ambiguous = prop.object({ a: prop.pose(), b: prop.optional(prop.pose()) });
        expect(checkSpecs(prop.list(prop.union('kind', [ambiguous])))).toEqual([
            '[]: holds 2 pose fields (a, b), only one can frame it',
        ]);
    });

    it("a pose frames its siblings and is the shape's placer; a world-space shape ignores everything above it", () => {
        const Item = prop.object({ pose: prop.pose(), shape: prop.sphere() });
        const World = prop.object({ pose: prop.pose(), shape: prop.sphere({ space: 'world' }) });
        const root = mat4.fromTranslation(mat4.create(), [10, 0, 0]);
        const value = {
            pose: { position: [1, 0, 0], quaternion: [0, 0, 0, 1] },
            shape: { type: 'sphere', radius: 1 },
        };
        const local = findShape(Item, value)!;
        expect(local.path).toEqual(['shape']);
        expect(local.posePath).toEqual(['pose']);
        const seen: string[] = [];
        walkObjects(Item, value, root, (site) => {
            seen.push(`${site.schema.kind}@${site.matrix[12]},${site.matrix[13]},${site.matrix[14]}`);
            return false;
        });
        expect(seen).toEqual(['pose@11,0,0', 'sphere@11,0,0']);
        const world: string[] = [];
        walkObjects(World, value, root, (site) => {
            world.push(`${site.schema.kind}@${site.matrix[12]},${site.matrix[13]},${site.matrix[14]}`);
            return false;
        });
        expect(world).toEqual(['pose@11,0,0', 'sphere@0,0,0']);
        expect(findShape(prop.sphere(), { type: 'sphere', radius: 1 })!.posePath).toBeNull();
    });

    it('a radius is never negative and a direction is unit length', () => {
        expect(prop.radius()).toEqual({ type: 'number', subtype: 'radius', min: 0 });
        expect(validate(prop.radius(), -1).map((i) => i.severity)).toEqual(['warn']);
        expect(validate(prop.direction(), [0, 2, 0]).map((i) => i.message)).toEqual(['direction has length 2.000, expected 1']);
        expect(validate(prop.direction(), [0, 1, 0])).toEqual([]);
        expect(validate(prop.point(), [0, 2, 0])).toEqual([]);
    });
});
