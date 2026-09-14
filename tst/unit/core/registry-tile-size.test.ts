// `tile()` enforces the atlas cell rule at declaration for computed frames:
// any multiple of 16 per side, since the packed atlas has no gutters and
// alignment is what keeps a tile on whole texels through four mip halvings.

import { beforeEach, describe, expect, it } from 'vitest';
import { registry, texture, tile } from '../../../src/core/registry';

beforeEach(() => {
    registry._reset();
});

describe('tile() frame size', () => {
    it('accepts 16x16 and 32x32 computed frames', () => {
        expect(() => tile('a', { frames: [texture('a16', { size: [16, 16], fn: () => {} })] })).not.toThrow();
        expect(() => tile('b', { frames: [texture('b32', { size: [32, 32], fn: () => {} })] })).not.toThrow();
        expect(() => tile('c', { frames: [texture('c48', { size: [48, 16], fn: () => {} })] })).not.toThrow();
    });

    it('rejects 24x24 and 8x8 computed frames', () => {
        expect(() => tile('d', { frames: [texture('d24', { size: [24, 24], fn: () => {} })] })).toThrow(/multiples of 16x16/);
        expect(() => tile('e', { frames: [texture('e8', { size: [8, 8], fn: () => {} })] })).toThrow(/multiples of 16x16/);
    });
});
