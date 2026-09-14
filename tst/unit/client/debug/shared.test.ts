import { describe, expect, it } from 'vitest';

import { paletteColor, thresholdColor } from '../../../../src/client/debug/monitors/shared';

describe('thresholdColor', () => {
    it('returns undefined with no thresholds', () => {
        expect(thresholdColor(5)).toBeUndefined();
        expect(thresholdColor(5, [])).toBeUndefined();
    });

    it('picks the highest band the value has reached', () => {
        const t = [
            { at: 0, color: 'ok' },
            { at: 70, color: 'warn' },
            { at: 88, color: 'danger' },
        ];
        expect(thresholdColor(20, t)).toBe('ok');
        expect(thresholdColor(75, t)).toBe('warn');
        expect(thresholdColor(90, t)).toBe('danger');
    });

    it('is order-independent (thresholds need not be sorted)', () => {
        const shuffled = [
            { at: 88, color: 'danger' },
            { at: 0, color: 'ok' },
            { at: 70, color: 'warn' },
        ];
        expect(thresholdColor(75, shuffled)).toBe('warn');
        expect(thresholdColor(90, shuffled)).toBe('danger');
    });

    it('returns undefined below every band', () => {
        expect(thresholdColor(10, [{ at: 30, color: 'warn' }])).toBeUndefined();
    });

    it('supports the higher-is-better direction', () => {
        const fps = [
            { at: 0, color: 'danger' },
            { at: 30, color: 'warn' },
            { at: 50, color: 'ok' },
        ];
        expect(thresholdColor(60, fps)).toBe('ok');
        expect(thresholdColor(40, fps)).toBe('warn');
        expect(thresholdColor(20, fps)).toBe('danger');
    });
});

describe('paletteColor', () => {
    it('cycles the palette', () => {
        expect(paletteColor(0)).toBe(paletteColor(8));
        expect(paletteColor(1)).not.toBe(paletteColor(0));
    });

    it('handles negative indices safely', () => {
        expect(typeof paletteColor(-1)).toBe('string');
        expect(paletteColor(-1)).toMatch(/^#/);
    });
});
