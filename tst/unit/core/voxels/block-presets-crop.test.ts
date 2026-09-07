// ── crop preset: growth stages ──────────────────────────────────────

import { registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crop } from '../../../../src/core/voxels/block-presets';
import { blockTexture } from '../../../../src/core/voxels/blocks';
import { resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    resetVoxelRegistry();
});

const stageTextures = (count: number) =>
    Array.from({ length: count }, (_, index) => blockTexture(`test:stage_${index + 1}`, { src: `stage_${index + 1}.png` }));

describe('crop preset', () => {
    it('gives every stage its own state key', () => {
        const wheat = crop('test:wheat', { textures: stageTextures(4) });
        const keys = [1, 2, 3, 4].map((stage) => wheat.stage(stage));
        expect(new Set(keys).size).toBe(4);
    });

    it('defaults to the first stage and ripens to the last', () => {
        const wheat = crop('test:wheat', { textures: stageTextures(4) });
        expect(wheat.defaultKey()).toBe(wheat.stage(1));
        expect(wheat.ripe()).toBe(wheat.stage(4));
    });

    it('clamps a stage outside the range rather than producing an unregistered key', () => {
        const wheat = crop('test:wheat', { textures: stageTextures(4) });
        expect(wheat.stage(0)).toBe(wheat.stage(1));
        expect(wheat.stage(99)).toBe(wheat.ripe());
    });

    it('draws a different texture per stage', () => {
        const textures = stageTextures(3);
        const wheat = crop('test:wheat', { textures });
        const textureOf = (age: number) => {
            const model = wheat.def.model!({ age });
            if (model.type !== 'custom') throw new Error('crop should build a custom cross-quad model');
            return model.quads[0].texture;
        };
        expect(textureOf(1)).toBe(textures[0]);
        expect(textureOf(2)).toBe(textures[1]);
        expect(textureOf(3)).toBe(textures[2]);
    });

    it('rejects a crop with no stages', () => {
        expect(() => crop('test:empty', { textures: [] })).toThrow(/at least one stage/);
    });
});
