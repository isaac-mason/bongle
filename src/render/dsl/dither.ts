import { add, Discard, d, Fn, f32, fract, fragCoord, If, mul, type Node } from 'gpucat';

// ── alpha cutout + dither ───────────────────────────────────────────
/**
 * Fragment discard shared by every albedo-based trait: a hard alpha cutout
 * (`alpha < 0.5`) plus an interleaved-gradient screen-door so partial
 * coverage fades pixelly instead of popping. Coverage is owned solely by the
 * `dither` knob:
 *
 *   fade = dither   // 0 = solid, 1 = gone
 *
 * Cheap (a few fracts) and stays in the opaque pipeline, no sort, no blend.
 * Returns `color`, or discards the fragment. `dither = 0` is a pure cutout
 * (the no-fade fast path). Tint never feeds this, it can't gate coverage.
 */

export function ditherDiscard(color: Node<d.vec4f>, alpha: Node<d.f32>, dither: Node<d.f32>): Node<d.vec4f> {
    const discard = Fn(
        (c, a, fade, fragX, fragY) => {
            If(a.lessThan(f32(0.5)), () => {
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
