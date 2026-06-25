// ── MODEL_LIQUID registry plumbing tests ────────────────────────────

import { registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BLOCK_FLAG_LIQUID, MODEL_CUBE, MODEL_LIQUID } from './block-registry';
import { buildTestRegistry, resetVoxelRegistry, type TestBlockSpec } from './test-helpers';

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    resetVoxelRegistry();
});

function buildRegistry(blocks: { id: string; def: Omit<TestBlockSpec, 'id' | 'texId'> }[]) {
    const registry = buildTestRegistry(blocks.map((b) => ({ id: b.id, texId: b.id, ...b.def })));
    const stateOf = (id: string) => registry.keyToState.get(id)!;
    return { registry, stateOf };
}

describe('block registry: MODEL_LIQUID classification', () => {
    it('block without surfaceHeight is MODEL_CUBE', () => {
        const { registry, stateOf } = buildRegistry([{ id: 'stone', def: {} }]);
        expect(registry.modelType[stateOf('stone')]).toBe(MODEL_CUBE);
    });

    it('block with surfaceHeight is MODEL_LIQUID', () => {
        const { registry, stateOf } = buildRegistry([
            { id: 'water', def: { surfaceHeight: 0.875, collision: false, liquid: { viscosity: 1 } } },
        ]);
        expect(registry.modelType[stateOf('water')]).toBe(MODEL_LIQUID);
    });
});

describe('block registry: surfaceHeight', () => {
    it('non-liquid blocks default to 1.0', () => {
        const { registry, stateOf } = buildRegistry([{ id: 'stone', def: {} }]);
        expect(registry.surfaceHeight[stateOf('stone')]).toBe(1);
    });

    it('liquid stores the configured numeric height', () => {
        const { registry, stateOf } = buildRegistry([
            { id: 'water', def: { surfaceHeight: 15 / 16, collision: false, liquid: { viscosity: 1 } } },
        ]);
        expect(registry.surfaceHeight[stateOf('water')]).toBeCloseTo(15 / 16);
    });

    it('function resolver receives props (single-state case)', () => {
        const { registry, stateOf } = buildRegistry([
            {
                id: 'water',
                def: {
                    surfaceHeight: () => 0.5,
                    collision: false,
                    liquid: { viscosity: 1 },
                },
            },
        ]);
        expect(registry.surfaceHeight[stateOf('water')]).toBeCloseTo(0.5);
    });
});

describe('block registry: fluidGroup', () => {
    it('non-liquid blocks have fluidGroup 0', () => {
        const { registry, stateOf } = buildRegistry([{ id: 'stone', def: {} }]);
        expect(registry.fluidGroup[stateOf('stone')]).toBe(0);
    });

    it('liquids with the same fluidGroup string get the same numeric id', () => {
        const { registry, stateOf } = buildRegistry([
            {
                id: 'water_a',
                def: { surfaceHeight: 1, fluidGroup: 'water', collision: false, liquid: { viscosity: 1 } },
            },
            {
                id: 'water_b',
                def: { surfaceHeight: 1, fluidGroup: 'water', collision: false, liquid: { viscosity: 1 } },
            },
        ]);
        const a = registry.fluidGroup[stateOf('water_a')]!;
        const b = registry.fluidGroup[stateOf('water_b')]!;
        expect(a).not.toBe(0);
        expect(a).toBe(b);
    });

    it('liquids with different fluidGroups get distinct ids', () => {
        const { registry, stateOf } = buildRegistry([
            {
                id: 'water',
                def: { surfaceHeight: 1, fluidGroup: 'water', collision: false, liquid: { viscosity: 1 } },
            },
            {
                id: 'lava',
                def: { surfaceHeight: 1, fluidGroup: 'lava', collision: false, liquid: { viscosity: 1 } },
            },
        ]);
        expect(registry.fluidGroup[stateOf('water')]).not.toBe(registry.fluidGroup[stateOf('lava')]);
    });

    it('LIQUID flag is still set alongside fluidGroup', () => {
        const { registry, stateOf } = buildRegistry([
            {
                id: 'water',
                def: { surfaceHeight: 1, fluidGroup: 'water', collision: false, liquid: { viscosity: 1 } },
            },
        ]);
        expect(registry.flags[stateOf('water')]! & BLOCK_FLAG_LIQUID).toBeTruthy();
    });
});

describe('block registry: screenTint', () => {
    it('block without screenTint has zero alpha (no tint)', () => {
        const { registry, stateOf } = buildRegistry([{ id: 'stone', def: {} }]);
        const off = stateOf('stone') * 4;
        expect(registry.screenTint[off + 3]).toBe(0);
    });

    it('configured screenTint is written verbatim', () => {
        const { registry, stateOf } = buildRegistry([
            {
                id: 'water',
                def: {
                    surfaceHeight: 1,
                    collision: false,
                    liquid: { viscosity: 1 },
                    screenTint: { color: [0.04, 0.1, 0.2], opacity: 0.3 },
                },
            },
        ]);
        const off = stateOf('water') * 4;
        expect(registry.screenTint[off]).toBeCloseTo(0.04);
        expect(registry.screenTint[off + 1]).toBeCloseTo(0.1);
        expect(registry.screenTint[off + 2]).toBeCloseTo(0.2);
        expect(registry.screenTint[off + 3]).toBeCloseTo(0.3);
    });
});
