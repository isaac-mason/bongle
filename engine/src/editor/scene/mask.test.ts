import { describe, expect, it } from 'vitest';
import { parseMask } from './mask';

describe('parseMask', () => {
    it('single block', () => {
        expect(parseMask('stone')).toEqual({
            kind: 'blocks',
            blocks: [{ blockId: 'stone' }],
        });
    });

    it('block with state', () => {
        expect(parseMask('oak_fence[east=true]')).toEqual({
            kind: 'blocks',
            blocks: [{ blockId: 'oak_fence', props: { east: 'true' } }],
        });
    });

    it('comma list → OR within single blocks node', () => {
        expect(parseMask('stone,dirt,grass_block')).toEqual({
            kind: 'blocks',
            blocks: [{ blockId: 'stone' }, { blockId: 'dirt' }, { blockId: 'grass_block' }],
        });
    });

    it('space-separated → intersection', () => {
        expect(parseMask('stone #existing')).toEqual({
            kind: 'and',
            masks: [
                { kind: 'blocks', blocks: [{ blockId: 'stone' }] },
                { kind: 'existing' },
            ],
        });
    });

    it('negation', () => {
        expect(parseMask('!stone')).toEqual({
            kind: 'not',
            mask: { kind: 'blocks', blocks: [{ blockId: 'stone' }] },
        });
    });

    it('negation with OR list', () => {
        expect(parseMask('!dirt,stone')).toEqual({
            kind: 'not',
            mask: {
                kind: 'blocks',
                blocks: [{ blockId: 'dirt' }, { blockId: 'stone' }],
            },
        });
    });

    it('existing', () => {
        expect(parseMask('#existing')).toEqual({ kind: 'existing' });
    });

    it('noise', () => {
        expect(parseMask('%50')).toEqual({ kind: 'noise', percent: 50 });
        expect(parseMask('%12.5')).toEqual({ kind: 'noise', percent: 12.5 });
    });

    it('combines intersection of negation, blocks, noise', () => {
        const m = parseMask('!air stone,dirt %50');
        expect(m).toEqual({
            kind: 'and',
            masks: [
                { kind: 'not', mask: { kind: 'blocks', blocks: [{ blockId: 'air' }] } },
                { kind: 'blocks', blocks: [{ blockId: 'stone' }, { blockId: 'dirt' }] },
                { kind: 'noise', percent: 50 },
            ],
        });
    });

    it('throws on empty', () => {
        expect(() => parseMask('')).toThrow();
    });

    it('throws on bad noise', () => {
        expect(() => parseMask('%150')).toThrow();
    });
});
