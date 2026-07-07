import { describe, expect, it } from 'vitest';
import { bytesEqual, bytesEqualPrefix } from '../../../../src/core/utils/bytes';

describe('bytesEqual', () => {
    it('true for identical, false for differing length or content', () => {
        expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
        expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
        expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    });
});

describe('bytesEqualPrefix', () => {
    it('compares the first n bytes of a against all of b (no subarray view)', () => {
        // scratch is oversized; only [0:n) is meaningful, trailing bytes ignored.
        const scratch = new Uint8Array([1, 2, 3, 99, 99, 99]);
        expect(bytesEqualPrefix(scratch, 3, new Uint8Array([1, 2, 3]))).toBe(true);
    });

    it('false when b length != n', () => {
        const scratch = new Uint8Array([1, 2, 3, 99]);
        expect(bytesEqualPrefix(scratch, 3, new Uint8Array([1, 2]))).toBe(false);
        expect(bytesEqualPrefix(scratch, 3, new Uint8Array([1, 2, 3, 4]))).toBe(false);
    });

    it('false on a mismatch within the first n bytes', () => {
        const scratch = new Uint8Array([1, 2, 4, 99]);
        expect(bytesEqualPrefix(scratch, 3, new Uint8Array([1, 2, 3]))).toBe(false);
    });

    it('n=0 matches an empty snapshot', () => {
        expect(bytesEqualPrefix(new Uint8Array([9, 9]), 0, new Uint8Array(0))).toBe(true);
    });
});
