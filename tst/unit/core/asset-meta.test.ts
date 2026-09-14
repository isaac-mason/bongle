// Asset meta: the one search rule every picker uses, and the normalisation
// every declaration runs.

import { describe, expect, it } from 'vitest';
import { assetMatches, normalizeTags, resolveAssetMeta, termsMatch } from '../../../src/core/asset-meta';

describe('resolveAssetMeta', () => {
    it('defaults the name to the id and the tags to an empty list', () => {
        expect(resolveAssetMeta('kit:oak_log', undefined)).toEqual({ name: 'kit:oak_log', tags: [] });
        expect(resolveAssetMeta('kit:oak_log', {})).toEqual({ name: 'kit:oak_log', tags: [] });
    });

    it('lowercases, trims and dedupes tags, keeping their order', () => {
        expect(normalizeTags([' Wood', 'tree', 'WOOD', '', 'oak '])).toEqual(['wood', 'tree', 'oak']);
    });
});

describe('assetMatches', () => {
    const oakLog = { id: 'kit:oak_log', name: 'Oak Log', tags: ['wood', 'tree', 'oak'] };
    const oakLeaves = { id: 'kit:oak_leaves', name: 'Oak Leaves', tags: ['tree', 'oak', 'foliage'] };

    it('hits on id, name or a tag, case-insensitively', () => {
        expect(assetMatches(oakLog, 'oak_log')).toBe(true);
        expect(assetMatches(oakLog, 'Oak Log')).toBe(true);
        expect(assetMatches(oakLog, 'WOOD')).toBe(true);
        expect(assetMatches(oakLog, 'stone')).toBe(false);
    });

    it('needs every word of the query, each found somewhere', () => {
        expect(assetMatches(oakLeaves, 'oak foliage')).toBe(true);
        expect(assetMatches(oakLog, 'oak foliage')).toBe(false);
        expect(assetMatches(oakLog, 'tree wood')).toBe(true);
    });

    it('hits everything on an empty query', () => {
        expect(assetMatches(oakLog, '')).toBe(true);
        expect(assetMatches(oakLog, '   ')).toBe(true);
    });

    it('is the same rule a picker applies to its own terms', () => {
        expect(termsMatch(['Oak Log', 'kit:oak_log', 'wood'], 'wood oak')).toBe(true);
        expect(termsMatch(['Oak Log', 'kit:oak_log'], 'wood')).toBe(false);
    });
});
