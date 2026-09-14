import { describe, expect, it } from 'vitest';
import { getAtPath, samePath, setAtPath } from '../../../../src/core/scene/prop/path';

describe('prop path', () => {
    it('reads through objects and lists', () => {
        const root = { shape: { kind: 'compound', items: [{ position: [1, 2, 3] }] } };
        expect(getAtPath(root, ['shape', 'items', 0, 'position'])).toEqual([1, 2, 3]);
        expect(getAtPath(root, ['shape', 'items', 4])).toBeUndefined();
    });

    it('setAtPath rebuilds the containers on the path and shares the rest', () => {
        const other = { radius: 1 };
        const first = { position: [1, 2, 3] };
        const root = { shape: { kind: 'compound', items: [first, other] } };
        const next = setAtPath(root, ['shape', 'items', 0, 'position'], [9, 9, 9]) as typeof root;
        expect(next).not.toBe(root);
        expect(getAtPath(next, ['shape', 'items', 0, 'position'])).toEqual([9, 9, 9]);
        expect(next.shape.items[1]).toBe(other);
        expect(first.position).toEqual([1, 2, 3]);
    });

    it('an empty path replaces the root', () => {
        expect(setAtPath({ a: 1 }, [], 5)).toBe(5);
    });

    it('samePath compares element-wise', () => {
        expect(samePath(['a', 0], ['a', 0])).toBe(true);
        expect(samePath(['a', 0], ['a', '0'])).toBe(false);
        expect(samePath(['a'], ['a', 0])).toBe(false);
    });
});
