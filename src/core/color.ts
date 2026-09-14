import type { Vec3 } from 'math';

/** IEC 61966-2-1 sRGB transfer, byte input (0..255) → linear float (0..1). */
export function srgbByteToLinear(c: number): number {
    const n = c / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
}

/** sRGB byte triple (0..255 each) → linear Vec3. */
export function srgbBytesToLinear(r: number, g: number, b: number): Vec3 {
    return [srgbByteToLinear(r), srgbByteToLinear(g), srgbByteToLinear(b)];
}
