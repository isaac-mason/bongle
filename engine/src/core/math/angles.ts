/** Angle math helpers. Radians throughout. */

/** Wrap an angle into [-π, π]. Useful for computing the shortest signed
 *  delta between two yaws without blowing up across the ±π seam. */
export function wrapPi(a: number): number {
    const tau = Math.PI * 2;
    a %= tau;
    if (a > Math.PI) a -= tau;
    else if (a < -Math.PI) a += tau;
    return a;
}
