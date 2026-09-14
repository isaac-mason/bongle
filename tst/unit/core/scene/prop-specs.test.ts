import { mat4 } from 'math';
import { describe, expect, it } from 'vitest';
import { RigidBodyDef, TransformedShapeDef } from '../../../../src/builtins/rigid-body';
import { prop, validate } from '../../../../src/core/scene/prop';
import { findShape, walkObjects } from '../../../../src/core/scene/prop/specs';

describe('shape and pose value types', () => {
    it('a shape is an object with a fixed layout and a type literal, so shapes union on `type`', () => {
        expect(prop.sphere()).toEqual({
            type: 'object',
            kind: 'sphere',
            fields: { type: prop.literal('sphere'), radius: prop.radius() },
        });
        expect(prop.box({ space: 'world' })).toMatchObject({ kind: 'box', space: 'world' });
        expect(Object.keys(prop.segment().fields)).toEqual(['type', 'from', 'to']);
        const Zone = prop.union('type', [prop.box(), prop.sphere()]);
        expect(validate(Zone, { type: 'sphere', radius: 1 })).toEqual([]);
        expect(validate(Zone, { type: 'box', halfExtents: [1, 1, 1] })).toEqual([]);
        expect(validate(Zone, { type: 'sphere' }).length).toBeGreaterThan(0);
    });

    it('a pose holds what it places, and its contents cannot shadow position or quaternion', () => {
        expect(Object.keys(prop.pose().fields)).toEqual(['position', 'quaternion']);
        expect(Object.keys(prop.pose({ shape: prop.sphere() }).fields)).toEqual(['shape', 'position', 'quaternion']);
        // @ts-expect-error a pose owns its position
        prop.pose({ position: prop.point() });
        expect(TransformedShapeDef.kind).toBe('pose');
        const good: unknown = {
            shape: { type: 'transformed', position: [1, 0, 0], quaternion: [0, 0, 0, 1], shape: { type: 'sphere', radius: 1 } },
        };
        expect(validate(RigidBodyDef, good)).toEqual([]);
    });

    it('a shape inside a pose sits at the pose; beside one, it sits at the node', () => {
        const root = mat4.fromTranslation(mat4.create(), [10, 0, 0]);
        const pose = { position: [1, 0, 0], quaternion: [0, 0, 0, 1] };
        const at = (schema: ReturnType<typeof prop.object>, value: unknown) => {
            const seen: string[] = [];
            walkObjects(schema, value, root, (site) => {
                seen.push(`${site.schema.kind}@${site.matrix[12]},${site.matrix[13]},${site.matrix[14]}`);
                return false;
            });
            return seen;
        };
        const Held = prop.object({ zone: prop.pose({ shape: prop.sphere() }) });
        const held = { zone: { ...pose, shape: { type: 'sphere', radius: 1 } } };
        expect(at(Held, held)).toEqual(['pose@11,0,0', 'sphere@11,0,0']);
        expect(findShape(Held, held)).toMatchObject({ path: ['zone', 'shape'], posePath: ['zone'] });

        const Beside = prop.object({ spawn: prop.pose(), zone: prop.sphere() });
        const beside = { spawn: pose, zone: { type: 'sphere', radius: 1 } };
        expect(at(Beside, beside)).toEqual(['pose@11,0,0', 'sphere@10,0,0']);
        expect(findShape(Beside, beside)).toMatchObject({ path: ['zone'], posePath: null });

        const Nested = prop.object({ outer: prop.pose({ inner: prop.pose({ shape: prop.box() }) }) });
        const nested = { outer: { ...pose, inner: { ...pose, shape: { type: 'box', halfExtents: [1, 1, 1] } } } };
        expect(at(Nested, nested)).toEqual(['pose@11,0,0', 'pose@12,0,0', 'box@12,0,0']);
        expect(findShape(Nested, nested)!.posePath).toEqual(['outer', 'inner']);

        const World = prop.object({ zone: prop.pose({ shape: prop.sphere() }, { space: 'world' }) });
        expect(at(World, held)).toEqual(['pose@1,0,0', 'sphere@1,0,0']);
    });

    it('a radius is never negative and a direction is unit length', () => {
        expect(prop.radius()).toEqual({ type: 'number', subtype: 'radius', min: 0 });
        expect(validate(prop.radius(), -1).map((i) => i.severity)).toEqual(['warn']);
        expect(validate(prop.direction(), [0, 2, 0]).map((i) => i.message)).toEqual(['direction has length 2.000, expected 1']);
        expect(validate(prop.direction(), [0, 1, 0])).toEqual([]);
        expect(validate(prop.point(), [0, 2, 0])).toEqual([]);
    });
});
