import { describe, expect, it } from 'vitest';
import { migrateScene, SCENE_LATEST } from '../../../src/migrations/scene';

describe('migrateScene', () => {
    it('bumps a v0 payload to v1 via the no-op step', () => {
        const raw = { version: 0, nodes: { root: { name: 'Root' } } };
        const out = migrateScene(raw);
        expect(out).toEqual({ version: 1, nodes: { root: { name: 'Root' } } });
    });

    it('treats a missing version as v0 and runs the chain', () => {
        const out = migrateScene({ nodes: {} });
        expect(out.version).toBe(SCENE_LATEST);
    });

    it('no-ops when the file is already at latest', () => {
        const raw = { version: SCENE_LATEST, nodes: {} };
        const out = migrateScene(raw);
        expect(out).toEqual(raw);
    });

    it('throws if the file is newer than latest', () => {
        expect(() => migrateScene({ version: 99, nodes: {} })).toThrow(/newer than SCENE_LATEST/);
    });
});
