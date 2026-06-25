import { describe, expect, it } from 'vitest';
import type { Voxels } from '../../core/voxels/voxels';
import { parsePattern, samplePattern, splitTopLevel } from './pattern';

// current pattern kinds (`block`, `random`) don't read voxels/pos. pass a
// stub so the widened signature compiles; world-reading kinds will get real
// fixtures when they land.
const V = null as unknown as Voxels;

describe('parsePattern', () => {
    it('single block', () => {
        expect(parsePattern('stone')).toEqual({ kind: 'block', block: { blockId: 'stone' } });
    });

    it('block with state', () => {
        expect(parsePattern('oak_log[axis=y]')).toEqual({
            kind: 'block',
            block: { blockId: 'oak_log', props: { axis: 'y' } },
        });
    });

    it('comma list → equal weights', () => {
        const p = parsePattern('stone,dirt');
        expect(p).toEqual({
            kind: 'random',
            choices: [
                { pattern: { kind: 'block', block: { blockId: 'stone' } }, weight: 1 },
                { pattern: { kind: 'block', block: { blockId: 'dirt' } }, weight: 1 },
            ],
        });
    });

    it('weighted list', () => {
        const p = parsePattern('10%stone,90%dirt');
        expect(p).toEqual({
            kind: 'random',
            choices: [
                { pattern: { kind: 'block', block: { blockId: 'stone' } }, weight: 10 },
                { pattern: { kind: 'block', block: { blockId: 'dirt' } }, weight: 90 },
            ],
        });
    });

    it('decimal weight', () => {
        const p = parsePattern('12.5%stone,dirt');
        expect(p.kind).toBe('random');
        if (p.kind === 'random') expect(p.choices[0]!.weight).toBeCloseTo(12.5);
    });

    it('protects brackets when splitting on comma', () => {
        const p = parsePattern('oak_stairs[facing=east,half=top],dirt');
        expect(p).toEqual({
            kind: 'random',
            choices: [
                {
                    pattern: {
                        kind: 'block',
                        block: { blockId: 'oak_stairs', props: { facing: 'east', half: 'top' } },
                    },
                    weight: 1,
                },
                { pattern: { kind: 'block', block: { blockId: 'dirt' } }, weight: 1 },
            ],
        });
    });

    it('throws on empty', () => {
        expect(() => parsePattern('')).toThrow();
        expect(() => parsePattern('   ')).toThrow();
    });

    it('throws on weight=0', () => {
        expect(() => parsePattern('0%stone,dirt')).toThrow();
    });
});

describe('samplePattern', () => {
    it('single block', () => {
        expect(samplePattern({ kind: 'block', block: { blockId: 'stone' } }, V, 0, 0, 0, '')).toBe('stone');
    });

    it('block with state → key with brackets', () => {
        expect(samplePattern({ kind: 'block', block: { blockId: 'oak_log', props: { axis: 'y' } } }, V, 0, 0, 0, '')).toBe(
            'oak_log[axis=y]',
        );
    });

    it('$active resolves to the supplied active key', () => {
        expect(samplePattern({ kind: 'active' }, V, 0, 0, 0, 'oak_log[axis=y]')).toBe('oak_log[axis=y]');
    });

    it('$active falls back to air when active key is empty', () => {
        expect(samplePattern({ kind: 'active' }, V, 0, 0, 0, '')).toBe('air');
    });

    it('weighted random respects weights', () => {
        // 0%..0.5 → first (weight 1 of 3), 0.5..1.0 → second (weight 2 of 3)
        const p = parsePattern('1%stone,2%dirt');
        let seq = [0.0, 0.4];
        let i = 0;
        const rng = () => seq[i++]!;
        expect(samplePattern(p, V, 0, 0, 0, '', rng)).toBe('stone');
        expect(samplePattern(p, V, 0, 0, 0, '', rng)).toBe('dirt');
        seq = [0.99];
        i = 0;
        expect(samplePattern(p, V, 0, 0, 0, '', rng)).toBe('dirt');
    });
});

describe('splitTopLevel', () => {
    it('respects brackets', () => {
        expect(splitTopLevel('a,b[c,d],e', ',')).toEqual(['a', 'b[c,d]', 'e']);
    });

    it('respects braces', () => {
        expect(splitTopLevel("a,sign{'text':'x,y'},b", ',')).toEqual(['a', "sign{'text':'x,y'}", 'b']);
    });
});
