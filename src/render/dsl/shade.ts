import { type d, div, dot, f32, max, mix, mul, type Node, vec3f } from 'gpucat';

// four orthogonal per-instance axes: tint is a persistent, luminance-preserving recolour (rgb
// target, a intensity; never changes coverage, that's the `dither` axis); flash is a transient
// flat-colour overlay on top of tint but under lighting; glow is a lighting floor in the
// surface's own colour, capped not additive (there's no bloom pass to feed), litMin already
// folded into `light` by the caller; unlit hard-bypasses lighting so the CPU path can also skip
// light sampling.

/**
 * tint (multiply) -> flash (overlay) -> glow-floored lighting -> unlit bypass. `light` is the
 * scene multiplier before glow. returns rgb only; the caller multiplies `tint.a` into texel alpha.
 */
export function shadeTinted(
    albedo: Node<d.vec3f>,
    tint: Node<d.vec4f>,
    flash: Node<d.vec4f>,
    light: Node<d.vec3f>,
    glow: Node<d.f32>,
    unlit: Node<d.f32>,
): Node<d.vec3f> {
    // the raw multiply shifts hue but also changes brightness; rescaling back to the albedo's
    // own luminance keeps the shading/detail so the recolour never darkens.
    const lumWeights = vec3f(f32(0.2126), f32(0.7152), f32(0.0722)).toVar('lumWeights');
    const lumAlbedo = dot(albedo, lumWeights).toVar('lumAlbedo');
    const rawTint = mul(albedo, tint.rgb).toVar('rawTint');
    const lumRaw = max(dot(rawTint, lumWeights), f32(1e-4)).toVar('lumRaw');
    const lumScale = div(lumAlbedo, lumRaw).toVar('tintLumScale');
    const preserved = mul(rawTint, vec3f(lumScale, lumScale, lumScale)).toVar('tintPreserved');
    const tinted = mix(albedo, preserved, tint.w).toVar('tintedAlbedo');
    const flashed = mix(tinted, flash.rgb, flash.w).toVar('flashedAlbedo');

    // glow-floored scene lighting modulates the surface; unlit bypasses it.
    const glowFloor = max(light, vec3f(glow, glow, glow)).toVar('glowFloor');
    const litShaded = mul(flashed, glowFloor).toVar('litShaded');
    return mix(litShaded, flashed, unlit).toVar('shadedRgb');
}
