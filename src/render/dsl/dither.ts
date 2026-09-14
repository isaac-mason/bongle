import { add, Discard, d, Fn, f32, fract, fragCoord, If, mul, type Node } from 'gpucat';
import { ALPHA_REF } from '../../core/voxels/mip-levels';

/**
 * shared by every albedo-based trait: a hard alpha cutout plus an interleaved-gradient
 * screen-door so partial coverage fades pixelly instead of popping. coverage is owned solely by
 * `dither` (0 = solid, 1 = gone); tint never feeds this, it can't gate coverage. cheap and stays
 * in the opaque pipeline, no sort, no blend. `dither = 0` is a pure cutout, the no-fade fast path.
 */
export function ditherDiscard(color: Node<d.vec4f>, alpha: Node<d.f32>, dither: Node<d.f32>): Node<d.vec4f> {
    const discard = Fn(
        (c, a, fade, fragX, fragY) => {
            // the same ALPHA_REF the mip chain preserves coverage against, so the
            // bake and the discard cannot drift apart.
            If(a.lessThan(f32(ALPHA_REF)), () => {
                Discard();
            });
            const ign = fract(mul(f32(52.9829189), fract(add(mul(f32(0.06711056), fragX), mul(f32(0.00583715), fragY))))).toVar(
                'ditherIgn',
            );
            If(fade.greaterThan(ign), () => {
                Discard();
            });
            return c;
        },
        {
            name: 'ditherDiscard',
            return: d.vec4f,
            params: [
                { name: 'color', type: d.vec4f },
                { name: 'alpha', type: d.f32 },
                { name: 'fade', type: d.f32 },
                { name: 'fragX', type: d.f32 },
                { name: 'fragY', type: d.f32 },
            ],
        },
    );
    return discard(color, alpha, dither, fragCoord.x, fragCoord.y);
}
