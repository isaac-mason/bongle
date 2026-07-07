import { describe, expect, it } from 'vitest';
import { containsProfanity, normalizeToken } from '../../../src/core/profanity';

describe('normalizeToken', () => {
    it('lowercases, applies leet substitutions, strips non-alpha', () => {
        expect(normalizeToken('A$$.hole')).toBe('asshole');
        expect(normalizeToken('f4g')).toBe('fag');
        expect(normalizeToken('@ss')).toBe('ass');
        expect(normalizeToken('sh!t')).toBe('shit');
        // '!' is leet for 'i' in the canonical form
        expect(normalizeToken('hello!')).toBe('helloi');
    });
});

describe('containsProfanity', () => {
    it('flags plain profanity (whole token)', () => {
        expect(containsProfanity('you are an ass')).toBe(true);
        expect(containsProfanity('fuck this')).toBe(true);
        expect(containsProfanity('SHIT')).toBe(true);
    });

    it('flags leetspeak / punctuation evasions', () => {
        expect(containsProfanity('what an a$$')).toBe(true);
        expect(containsProfanity('a.s.s')).toBe(true);
        expect(containsProfanity('@ss')).toBe(true);
        expect(containsProfanity('sh!t happens')).toBe(true);
    });

    it('flags despite trailing punctuation that is also leet', () => {
        // regression: '!' is leet for 'i', so a naive map turns 'fuck!' into
        // 'fucki' and slips through. the strip pass catches it.
        expect(containsProfanity('fuck!')).toBe(true);
        expect(containsProfanity('shit!!!')).toBe(true);
    });

    it('does not match substrings of innocent words', () => {
        expect(containsProfanity('the assassin escaped')).toBe(false);
        expect(containsProfanity('our class starts soon')).toBe(false);
        expect(containsProfanity('green grass')).toBe(false);
    });

    it('does not flag innocent words the raw list collapses onto', () => {
        expect(containsProfanity('please pass the ball')).toBe(false);
        expect(containsProfanity('a huge mass of people')).toBe(false);
        expect(containsProfanity('hello there friend')).toBe(false);
        expect(containsProfanity('my aunt is here')).toBe(false);
    });

    it('respects the moderate allowlist (anatomy, mild, innocent homographs)', () => {
        expect(containsProfanity('the doctor examined the penis')).toBe(false);
        expect(containsProfanity('racial diversity matters')).toBe(false);
        expect(containsProfanity('a niggardly sum')).toBe(false);
        expect(containsProfanity('do not be an idiot')).toBe(false);
    });

    it('returns false for clean text', () => {
        expect(containsProfanity('good game everyone, nice round')).toBe(false);
        expect(containsProfanity('')).toBe(false);
    });
});
