/** byte-wise equality for two Uint8Arrays. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * equality of the first `n` bytes of `a` against all of `b`. lets hot diff paths
 * compare a shared scratch buffer (sized to its high-water mark) against a
 * right-sized snapshot without allocating a `subarray(0, n)` view per call.
 */
export function bytesEqualPrefix(a: Uint8Array, n: number, b: Uint8Array): boolean {
    if (b.length !== n) return false;
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
    return true;
}
