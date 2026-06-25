import { registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    BLOCK_FLAG_CLIMBABLE,
    BLOCK_FLAG_COLLISION,
    BLOCK_FLAG_LIQUID,
    BLOCK_FLAG_PATHFINDABLE,
    BLOCK_FLAG_SELECTION,
    BLOCK_FLAG_SNEAK_GUARD,
} from './block-registry';
import { buildTestRegistry, resetVoxelRegistry, type TestBlockSpec } from './test-helpers';

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
