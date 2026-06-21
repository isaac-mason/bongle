// Shared shader-node helpers (gpucat DSL) for the visual traits. A single
// home for the small pieces of fragment logic that every albedo-based trait
// — mesh, sprite, extruded sprite, voxel mesh — needs to agree on, so they
// can't drift apart in per-trait copies.

import { add, d, Discard, f32, Fn, fract, fragCoord, If, max, mix, mul, type Node, sub, vec3f } from 'gpucat';

// ── tint + flash + glow ─────────────────────────────────────────────
//
// The per-instance colour/lighting knobs, in one place so every trait
// agrees on what they mean. Four orthogonal axes, each owning one thing:
//
//   tint  — persistent recolour. Multiplies the albedo (white = no-op),
//           matching every other engine. `tint.a` is opacity and is applied
//           to the fragment alpha by the caller, not here.
//   flash — transient overlay. Lerps toward a flat colour on top of the
//           tint but underneath lighting (damage flash, charge-up).
//   glow  — emission as a lighting floor in the surface's OWN colour
//           (glow=1 → fully lit, shadow-free) rather than adding white,
//           which would wash it out. Capped, not additive: there's no bloom
//           pass for overbright to feed. `litMin` shares this axis and is
//           already folded into `light` by the caller.
//   unlit — bypasses lighting entirely (0..1), showing the tinted+flashed
//           surface. A hard flag, separate from glow/litMin because it also
//           lets the CPU path skip light sampling.

/**
 * Canonical albedo → fragment-rgb pipeline shared by every albedo-based
 * trait: tint (multiply) → flash (overlay) → glow-floored lighting → unlit
 * bypass. `light` is the scene multiplier BEFORE glow (litMin already folded
 * in). Returns rgb only; the caller multiplies `tint.a` into the texel alpha.
 */
export function shadeTinted(
    albedo: Node<d.vec3f>,
    tint: Node<d.vec4f>,
    flash: Node<d.vec4f>,
    light: Node<d.vec3f>,
    glow: Node<d.f32>,
    unlit: Node<d.f32>,
): Node<d.vec3f> {
    const tinted = mul(albedo, tint.rgb).toVar('tintedAlbedo');
    const flashed = mix(tinted, flash.rgb, flash.w).toVar('flashedAlbedo');

    // glow-floored scene lighting modulates the surface; unlit bypasses it.
    const glowFloor = max(light, vec3f(glow, glow, glow)).toVar('glowFloor');
    const litShaded = mul(flashed, glowFloor).toVar('litShaded');
    return mix(litShaded, flashed, unlit).toVar('shadedRgb');
}

// ── alpha cutout + dither ───────────────────────────────────────────

/**
 * Fragment discard shared by every albedo-based trait: a hard alpha cutout
 * (`alpha < 0.5`) plus an interleaved-gradient screen-door so partial
 * coverage fades pixelly instead of popping. Coverage combines `opacity`
 * (tint.a) and the explicit `dither` knob into one fade:
 *
 *   fade = 1 - opacity * (1 - dither)   // 0 = solid, 1 = gone
 *
 * Cheap (a few muls + fracts) and stays in the opaque pipeline — no sort,
 * no blend. Returns `color`, or discards the fragment. `dither = 0` and
 * `opacity = 1` give a pure cutout (the no-fade fast path).
 */
export function ditherDiscard(
    color: Node<d.vec4f>,
    alpha: Node<d.f32>,
    opacity: Node<d.f32>,
    dither: Node<d.f32>,
): Node<d.vec4f> {
    const discard = Fn(
        (c, a, fade, fragX, fragY) => {
            If(a.lessThan(f32(0.5)), () => {
                Discard();
            });
            const ign = fract(
                mul(f32(52.9829189), fract(add(mul(f32(0.06711056), fragX), mul(f32(0.00583715), fragY)))),
            ).toVar('ditherIgn');
            If(fade.greaterThan(ign), () => {
                Discard();
            });
            return c;
        },
        {
            name: 'ditherDiscard',
            params: [
                { name: 'color', type: d.vec4f },
                { name: 'alpha', type: d.f32 },
                { name: 'fade', type: d.f32 },
                { name: 'fragX', type: d.f32 },
                { name: 'fragY', type: d.f32 },
            ],
        },
    );
    const fade = sub(f32(1.0), mul(opacity, sub(f32(1.0), dither))).toVar('ditherFade');
    return discard(color, alpha, fade, fragCoord.x, fragCoord.y);
}
