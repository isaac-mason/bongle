import { describe, expect, it } from 'vitest';
import { BoxShapeDef, RigidBodyDef, SphereShapeDef, TransformedShapeDef } from '../../../../src/builtins/rigid-body';
import { checkSpecs, prop, validate } from '../../../../src/core/scene/prop';
import type { ObjectSchema } from '../../../../src/core/scene/prop/prop';

describe('shape and frame specs', () => {
    it('a spec names fields by subtype, so the wrong kind of field is a type error', () => {
        prop.object(
            { radius: prop.radius(), mass: prop.number(), centre: prop.point() },
            // @ts-expect-error mass is a plain number, not a radius
            { shape: { kind: 'sphere', radius: 'mass' } },
        );
        prop.object(
            { radius: prop.radius() },
            // @ts-expect-error no such field
            { shape: { kind: 'sphere', radius: 'radiuss' } },
        );
        prop.object(
            { halfExtents: prop.vec3(), position: prop.point() },
            // @ts-expect-error halfExtents is not a point
            { frame: { position: 'halfExtents' } },
        );
        expect(true).toBe(true);
    });

    it('the rigid body shapes are annotated and pass the runtime check', () => {
        expect(SphereShapeDef.shape).toEqual({ kind: 'sphere', radius: 'radius' });
        expect(BoxShapeDef.shape).toEqual({ kind: 'box3', halfExtents: 'halfExtents' });
        expect(TransformedShapeDef.frame).toEqual({ position: 'position', quaternion: 'quaternion' });
        expect(checkSpecs(RigidBodyDef)).toEqual([]);
    });

    it('the runtime check names a missing field and a field of the wrong kind, through unions and lists', () => {
        const bad = prop.object({ radius: prop.number(), position: prop.vec3() }) as ObjectSchema;
        bad.shape = { kind: 'sphere', radius: 'radiuss' };
        bad.frame = { position: 'position' };
        const wrapped = prop.list(prop.union('kind', [bad]));

        expect(checkSpecs(wrapped)).toEqual([
            "[]: spec names 'radiuss', which is not a field",
            "[]: spec field 'position' is not a point",
        ]);
    });

    it('a radius is never negative and a direction is unit length', () => {
        expect(prop.radius()).toEqual({ type: 'number', subtype: 'radius', min: 0 });
        expect(validate(prop.radius(), -1).map((i) => i.severity)).toEqual(['warn']);
        expect(validate(prop.direction(), [0, 2, 0]).map((i) => i.message)).toEqual(['direction has length 2.000, expected 1']);
        expect(validate(prop.direction(), [0, 1, 0])).toEqual([]);
        expect(validate(prop.point(), [0, 2, 0])).toEqual([]);
    });
});

describe('shape centres', () => {
    it('a box may name a point as its centre, and a non-point centre is reported', async () => {
        const { checkSpecs, prop } = await import('../../../../src/core/scene/prop');
        const good = prop.object(
            { center: prop.point(), halfExtents: prop.vec3() },
            { shape: { kind: 'box3', halfExtents: 'halfExtents', center: 'center' } },
        );
        expect(checkSpecs(good)).toEqual([]);
        const bad = prop.object({ center: prop.vec3(), halfExtents: prop.vec3() }, {
            shape: { kind: 'box3', halfExtents: 'halfExtents', center: 'center' },
        } as never);
        expect(checkSpecs(bad)).toHaveLength(1);
    });
});
