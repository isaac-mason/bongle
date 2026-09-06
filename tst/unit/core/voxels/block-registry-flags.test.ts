import { registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    BLOCK_FLAG_CLIMBABLE,
    BLOCK_FLAG_COLLISION,
    BLOCK_FLAG_LIQUID,
    BLOCK_FLAG_PATHFINDABLE,
    BLOCK_FLAG_SELECTION,
    BLOCK_FLAG_SNEAK_GUARD,
    resolveKey,
} from '../../../../src/core/voxels/block-registry';
import * as blockState from '../../../../src/core/voxels/block-state';
import {
    buildTestRegistry,
    resetVoxelRegistry,
    resetVoxelRegistryStoresOnly,
    type TestBlockSpec,
} from '../../../../src/core/voxels/test-helpers';

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    resetVoxelRegistry();
});

function buildRegistry(blocks: { id: string; def: Omit<TestBlockSpec, 'id' | 'texId'> }[]) {
    const registry = buildTestRegistry(blocks.map((b) => ({ id: b.id, texId: 'white', ...b.def })));
    const stateOf = (id: string) => registry.keyToState.get(id)!;
    return { registry, stateOf };
}

describe('block registry flags', () => {
    it('default solid block: collision + selection + sneak-guard, no climb/liquid', () => {
        const { registry, stateOf } = buildRegistry([{ id: 'stone', def: {} }]);
        const flags = registry.flags[stateOf('stone')]!;
        expect(flags & BLOCK_FLAG_COLLISION).toBeTruthy();
        expect(flags & BLOCK_FLAG_SELECTION).toBeTruthy();
        expect(flags & BLOCK_FLAG_SNEAK_GUARD).toBeTruthy();
        expect(flags & BLOCK_FLAG_CLIMBABLE).toBe(0);
        expect(flags & BLOCK_FLAG_LIQUID).toBe(0);
    });

    it('climbable: true sets CLIMBABLE bit', () => {
        const { registry, stateOf } = buildRegistry([{ id: 'vines', def: { climbable: true, collision: false } }]);
        const flags = registry.flags[stateOf('vines')]!;
        expect(flags & BLOCK_FLAG_CLIMBABLE).toBeTruthy();
        expect(flags & BLOCK_FLAG_COLLISION).toBe(0);
        // non-collidable blocks don't get SNEAK_GUARD even by default
        expect(flags & BLOCK_FLAG_SNEAK_GUARD).toBe(0);
    });

    it('liquid: sets LIQUID bit and writes viscosity', () => {
        const { registry, stateOf } = buildRegistry([{ id: 'water', def: { liquid: { viscosity: 0.5 }, collision: false } }]);
        const stateId = stateOf('water');
        expect(registry.flags[stateId]! & BLOCK_FLAG_LIQUID).toBeTruthy();
        expect(registry.liquidViscosity[stateId]).toBeCloseTo(0.5);
    });

    it('non-liquid blocks have viscosity 0', () => {
        const { registry, stateOf } = buildRegistry([{ id: 'stone', def: {} }]);
        expect(registry.liquidViscosity[stateOf('stone')]).toBe(0);
    });

    it('friction defaults to 1.0; override writes value', () => {
        const { registry, stateOf } = buildRegistry([
            { id: 'stone', def: {} },
            { id: 'ice', def: { friction: 0.1 } },
            { id: 'mud', def: { friction: 2.0 } },
        ]);
        expect(registry.friction[stateOf('stone')]).toBe(1);
        expect(registry.friction[stateOf('ice')]).toBeCloseTo(0.1);
        expect(registry.friction[stateOf('mud')]).toBeCloseTo(2);
    });

    it('restitution defaults to 0; override writes value', () => {
        const { registry, stateOf } = buildRegistry([
            { id: 'stone', def: {} },
            { id: 'trampoline', def: { restitution: 0.9 } },
        ]);
        expect(registry.restitution[stateOf('stone')]).toBe(0);
        expect(registry.restitution[stateOf('trampoline')]).toBeCloseTo(0.9);
    });

    it('sneakGuard: false clears SNEAK_GUARD bit on a collidable block', () => {
        const { registry, stateOf } = buildRegistry([{ id: 'ice', def: { sneakGuard: false } }]);
        const flags = registry.flags[stateOf('ice')]!;
        expect(flags & BLOCK_FLAG_COLLISION).toBeTruthy();
        expect(flags & BLOCK_FLAG_SNEAK_GUARD).toBe(0);
    });

    it('air state is pathfindable and otherwise flag-free', () => {
        const { registry } = buildRegistry([{ id: 'stone', def: {} }]);
        // air (state 0) is explicitly marked navigable so nav treats it as
        // passable; no other flags apply.
        expect(registry.flags[0]).toBe(BLOCK_FLAG_PATHFINDABLE); // AIR
        expect(registry.friction[0]).toBe(1); // default
        expect(registry.restitution[0]).toBe(0); // default
        expect(registry.liquidViscosity[0]).toBe(0);
    });
});

// ── state-id stability ──────────────────────────────────────────────
//
// `chunk.palette` stores RESOLVED global state ids, so an id that shifts silently
// re-points every voxel already written with it. Ids are reserved per block id for
// the process lifetime (see `reserveBlockSlot`) so that can't happen: declaring a
// new block appends, removing one abandons its range rather than compacting, and
// re-declaring hands the original range back.

describe('global state id stability', () => {
    it('keeps existing ids when a new block is declared alongside', () => {
        const before = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const stoneId = resolveKey(before, 'stone');

        const after = buildTestRegistry([{ id: 'dirt', texId: 'dirt' }]);
        expect(resolveKey(after, 'stone'), 'declaring dirt must not move stone').toBe(stoneId);
        expect(resolveKey(after, 'dirt')).not.toBe(stoneId);
    });

    it('hands an id its original range back after it is removed and re-declared', () => {
        const first = buildTestRegistry([
            { id: 'stone', texId: 'stone' },
            { id: 'dirt', texId: 'dirt' },
        ]);
        const stoneId = resolveKey(first, 'stone');
        const dirtId = resolveKey(first, 'dirt');

        // dirt's declaration disappears (its module stopped declaring it).
        resetVoxelRegistryStoresOnly();
        const without = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        expect(resolveKey(without, 'stone'), 'stone must not slide into the gap').toBe(stoneId);

        // ...and comes back. A palette written before the removal still means dirt.
        resetVoxelRegistryStoresOnly();
        const again = buildTestRegistry([
            { id: 'stone', texId: 'stone' },
            { id: 'dirt', texId: 'dirt' },
        ]);
        expect(resolveKey(again, 'stone')).toBe(stoneId);
        expect(resolveKey(again, 'dirt')).toBe(dirtId);
    });

    it('moves a block whose state schema changed size, keeping its dense index', () => {
        const before = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const index = before.idToHandle.get('stone')!._index;
        const baseStateId = before.idToHandle.get('stone')!._baseStateId;

        // an author adds a prop: the old range is one state wide and can't hold it.
        resetVoxelRegistryStoresOnly();
        const after = buildTestRegistry([
            {
                id: 'stone',
                texId: 'stone',
                states: blockState.create({ half: blockState.enumeration(['bottom', 'top'] as const) }),
            },
        ]);
        const handle = after.idToHandle.get('stone')!;
        expect(handle._baseStateId, 'the range must move to fit the wider schema').not.toBe(baseStateId);
        // ...but the dense index is identity, so per-room block observers survive.
        expect(handle._index).toBe(index);
    });
});
