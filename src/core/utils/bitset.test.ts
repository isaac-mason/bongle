import { describe, expect, it } from 'vitest';
import * as bitset from './bitset';

describe('bitset', () => {
    it('add/has round-trips low and high bits', () => {
        const b = bitset.init();
        bitset.add(b, 0);
        bitset.add(b, 31);
        bitset.add(b, 32);
        expect(bitset.has(b, 0)).toBe(true);
        expect(bitset.has(b, 31)).toBe(true);
        expect(bitset.has(b, 32)).toBe(true);
        expect(bitset.has(b, 1)).toBe(false);
    });

    // regression: words are stored unsigned (`>>> 0`) but JS `&` yields a signed
    // Int32, so a mask with bit 31 set came back negative and never equalled the
    // unsigned stored mask — any query requiring a trait at slot 31/63/… silently
    // never matched.
    it('containsAll matches a mask whose high bit (31) is set', () => {
        const node = bitset.init();
        bitset.add(node, 0);
        bitset.add(node, 31);

        const maskBit31 = bitset.init();
        bitset.add(maskBit31, 31);
        expect(bitset.containsAll(node, maskBit31)).toBe(true);

        const maskBoth = bitset.init();
        bitset.add(maskBoth, 0);
        bitset.add(maskBoth, 31);
        expect(bitset.containsAll(node, maskBoth)).toBe(true);

        const maskMissing = bitset.init();
        bitset.add(maskMissing, 30);
        expect(bitset.containsAll(node, maskMissing)).toBe(false);
    });

    it('containsNone detects overlap at bit 31', () => {
        const node = bitset.init();
        bitset.add(node, 31);

        const overlapping = bitset.init();
        bitset.add(overlapping, 31);
        expect(bitset.containsNone(node, overlapping)).toBe(false);

        const disjoint = bitset.init();
        bitset.add(disjoint, 30);
        expect(bitset.containsNone(node, disjoint)).toBe(true);
    });
});
