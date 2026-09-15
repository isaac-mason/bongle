// ── declaration identity across re-evaluation ───────────────────────
//
// `capture/module-scope.ts` decides a module may SELF-ACCEPT when all its exports
// are engine handles, and justifies it like this:
//
//   "Handles are patched by-reference — importers hold the same handle object and
//    see new state through it — so they stay current across a patch."
//
// A self-accepting module's importers are deliberately NOT re-evaluated, so they
// keep the binding they already hold. That is only sound if re-declaring an id
// updates the handle the registry already has instead of binding a fresh object
// over it. These tests pin that per kind: same handle out, new def visible through
// it, and a `changed` event so dispatch still reacts.

import { registerAllShapes } from 'crashcat';
import * as pack from 'packcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createEmptyDef } from '../../../src/core/models/build-runtime-handle';
import {
    block,
    command,
    model,
    modelStore,
    prefab,
    _registerModelDef as registerModel,
    registry,
    sprite,
    sync,
    tile,
    trait,
    traitStore,
} from '../../../src/core/registry';
import { construct } from '../../../src/core/scene/traits';

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    registry._reset();
});

/** drain and return the ids that fired a `changed` event on a store. */
function takeChanged(store: { pendingChanges: Array<{ kind: string; id: string }> }): string[] {
    const ids = store.pendingChanges.filter((c) => c.kind === 'changed').map((c) => c.id);
    store.pendingChanges.length = 0;
    return ids;
}

// `declare` and `kind` are private to registry.ts — there is exactly one way for
// content to enter a store — so the contract is pinned through the real
// declaring APIs, which is what actually has to hold.
describe('declaring an id twice', () => {
    it('mints the handle once, then swaps the def under it', () => {
        const first = trait('t', { hp: 1 });
        registry.traits.pendingChanges.length = 0;

        const second = trait('t', { hp: 2 });
        expect(second).toBe(first); // identity survives the re-declare
        expect((first.def.body as { hp: number }).hp).toBe(2); // ...and holders see it
        expect(takeChanged(registry.traits)).toEqual(['t']);
        expect(registry.traits.byId.get('t')).toBe(first.def);
    });

    it('stays silent to dispatch when the content did not move', () => {
        const first = trait('t', { hp: 1 });
        registry.traits.pendingChanges.length = 0;

        expect(trait('t', { hp: 1 })).toBe(first);
        expect(takeChanged(registry.traits)).toEqual([]);
    });

    it('never touches members the engine populates after declaration', () => {
        const handle = trait('t', { hp: 1 });
        handle.netIndex = 7; // as `reindexRegistry` would

        trait('t', { hp: 2 });
        // the container is minted once and only `def` is re-pointed, so nothing
        // else on the handle is written — this survives by construction rather
        // than by each kind remembering to carry it across.
        expect(handle.netIndex).toBe(7);
    });

    it('adopts an entry a codegen barrel seeded before user code ran', () => {
        registerModel('m', { ...createEmptyDef('m'), src: 'seeded.glb' });
        // unlike the old placeholder path the container exists immediately, so a
        // consumer populating off the seeded payload has a handle to write into.
        const seeded = modelStore.handles.get('m');
        expect(seeded).toBeDefined();

        const handle = model('m', { src: 'user.glb' });
        expect(handle).toBe(seeded);
        expect(registry.models.meta.get('m')?.module).not.toBe('__placeholder__');
    });

    it('never prunes handles, so an id re-declared later keeps its identity', () => {
        const first = trait('t', { hp: 1 });
        traitStore.byId.delete('t');
        traitStore.meta.delete('t');

        expect(trait('t', { hp: 3 })).toBe(first);
        expect((first.def.body as { hp: number }).hp).toBe(3);
    });

    it('carries `id` on the handle, since identity cannot go stale the way data can', () => {
        const handle = trait('t', { hp: 1 });
        trait('t', { hp: 2 });
        // `id` is the one field safe to hold outside the def: a re-declaration of
        // an id is by definition the same id, so it can never drift from the def
        // the way `name` or any other authored field would.
        expect(handle.id).toBe('t');
        expect(handle.id).toBe(handle.def.id);
    });
});

// ── per-kind contract ───────────────────────────────────────────────
//
// Each case re-declares one id with CHANGED content, the way a module re-eval
// under HMR does, and asserts the handle an importer is still holding is the one
// that got updated.

describe('re-declaration preserves handle identity', () => {
    it('tile', () => {
        const first = tile('t', { src: 'a.png' });
        const second = tile('t', { src: 'b.png' });
        expect(second).toBe(first);
        expect(first.def.frames).toHaveLength(1);
    });

    it('block', () => {
        tile('t', { src: 'a.png' });
        const first = block('stone', { name: 'Stone' });
        const second = block('stone', { name: 'Rock' });
        expect(second).toBe(first);
        expect(first.def.name).toBe('Rock');
    });

    it('sprite', () => {
        const first = sprite('s', { src: 'a.png' });
        const second = sprite('s', { src: 'b.png' });
        expect(second).toBe(first);
        // a sprite holds frame REFERENCES; the source moved on the texture the `src`
        // sugar declared for it, which keeps the sprite's own identity untouched.
        expect(first.def.frames).toEqual([{ registry: 'textures', id: 's' }]);
        expect(registry.textures.byId.get('s')).toMatchObject({ from: 'file', src: 'b.png' });
    });

    it('trait', () => {
        const first = trait('t', { hp: 1 });
        const second = trait('t', { hp: 2 });
        expect(second).toBe(first);
        expect(first.def.body.hp).toBe(2);
    });

    it('prefab', () => {
        const first = prefab('p', { type: 'nodes', name: 'A' });
        const second = prefab('p', { type: 'nodes', name: 'B' });
        expect(second).toBe(first);
        expect(first.def.name).toBe('B');
    });

    it('command', () => {
        const schemaA = pack.object({ a: pack.uint8() });
        const schemaB = pack.object({ a: pack.uint16() });
        const first = command('c', 'client_to_server', schemaA);
        const second = command('c', 'client_to_server', schemaB);
        expect(second).toBe(first);
        expect(first.def.schema).toBe(schemaB);
    });

    it('wraps the per-trait registrations too, even though nothing holds them', () => {
        // control() returns void and sync() returns a positional SyncHandle, so no
        // importer holds these. They go through `declare` for shape: every kind
        // stores a def and mints a handle, so a future user-held ref is already
        // identity-stable rather than needing the mechanism retrofitted.
        const t = trait('t', { hp: 1 });
        sync(t, 'hp', { rate: 'dirty', get: () => 0, set: () => {} } as never);
        const handle = registry.sync.handles.get('t.hp');
        expect(handle, 'sync() should have minted a handle').toBeDefined();
        expect(handle!.def).toBe(registry.sync.byId.get('t.hp'));
        // the def the trait holds is the same object the store holds
        expect(t.def.sync[0]).toBe(handle!.def);
    });
});

// ── the hazard stable identity introduces ───────────────────────────
//
// Swapping the def wholesale is what makes this safe for most kinds: there are no
// per-field copies to keep in sync. Traits are the exception, because their def
// carries derived state that later calls in the same module append to.

describe('trait re-declaration resets def-local derived state', () => {
    it('lets sibling registrations re-register with an edited body', () => {
        const first = trait('t', { hp: 1 });
        sync(first, 'hp', { rate: 'dirty', get: () => 0, set: () => {} } as never);
        expect(first.def.sync).toHaveLength(1);

        // the module re-evaluates: trait() then the same sync() call runs again, with
        // an edited body. `sync()` refuses to re-register an id it already holds (it
        // warns and returns the existing index), so a re-declaration that reused the
        // old def would drop the edit silently and keep the old body.
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (...parts: unknown[]) => void warnings.push(parts.join(' '));
        try {
            const second = trait('t', { hp: 2 });
            sync(second, 'hp', { rate: 'realtime', get: () => 0, set: () => {} } as never);
            expect(second).toBe(first);
        } finally {
            console.warn = originalWarn;
        }

        expect(warnings, 'a re-eval must not look like a duplicate registration').toEqual([]);
        expect(first.def.sync).toHaveLength(1);
        expect((first.def.sync[0] as unknown as { rate: string }).rate).toBe('realtime');
    });

    it('recompiles construct against the new body', () => {
        const handle = trait('t', { hp: 1 });
        expect((construct(handle)() as Record<string, unknown>).hp).toBe(1);

        trait('t', { hp: 5 });
        const instance = construct(handle)() as Record<string, unknown>;
        expect(instance.hp).toBe(5);
        expect(instance._def).toBe(handle.def);
    });
});

// ── model handle forwarding ─────────────────────────────────────────

describe('ModelHandle forwarding accessors', () => {
    it('reads through to the live def, and follows a re-registration', () => {
        const handle = model('bow', { src: 'assets/bow.glb', name: 'Bow' });
        expect(handle.name).toBe('Bow');
        expect(handle.src).toBe('assets/bow.glb');
        // the placeholder def a cold declaration mints, before codegen catches up
        expect(handle.nodes).toBe(handle.def.nodes);

        // codegen lands: `registerModel` swaps the def under the same handle.
        const payload = createEmptyDef('bow');
        (payload as { nodes: Record<string, unknown> }).nodes = { arrow: { marker: true } as never };
        registerModel('bow', payload);

        expect(handle.def).toBe(payload);
        // the accessor followed the swap rather than holding a stale copy — the
        // whole reason these are getters and not fields.
        expect((handle.nodes as unknown as Record<string, { marker: boolean }>).arrow.marker).toBe(true);
    });
});

describe('asset tags', () => {
    it('every kind carries normalised tags on its def, empty when unset', () => {
        registry._reset();
        expect(block('plain', {}).def.tags).toEqual([]);
        expect(block('log', { name: 'Oak Log', tags: ['Wood', 'tree', 'wood '] }).def.tags).toEqual(['wood', 'tree']);
        expect(sprite('spark', { src: 'spark.png', tags: ['FX'] }).def.tags).toEqual(['fx']);
        expect(prefab('hut', { type: 'nodes', tags: ['building', 'wood'] }).def.tags).toEqual(['building', 'wood']);
        expect(model('bow', { src: 'assets/bow.glb', tags: ['weapon'] }).def.tags).toEqual(['weapon']);
    });

    it('re-declaring with new tags updates the def', () => {
        registry._reset();
        block('log', { tags: ['wood'] });
        expect(block('log', { tags: ['wood', 'oak'] }).def.tags).toEqual(['wood', 'oak']);
    });
});
