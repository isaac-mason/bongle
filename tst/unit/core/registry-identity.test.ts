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
import { prefab } from '../../../src/api/prefabs';
import { createEmptyDef } from '../../../src/core/models/build-runtime-handle';
import { model, _registerModelDef as registerModel } from '../../../src/core/models/models';
import { particle } from '../../../src/core/particles/particles';
import { declare, type HandleOf, type RegistryStore, registry, structuralHash, upsert } from '../../../src/core/registry';
import { command } from '../../../src/core/rpc';
import { sync, trait } from '../../../src/core/scene/traits';
import { sprite } from '../../../src/core/sprites/sprites';
import { block, blockTexture } from '../../../src/core/voxels/blocks';

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    registry._reset();
});

type Payload = { id: string; value: number };

function makeStore(): RegistryStore<Payload> {
    return {
        name: 'test',
        byId: new Map(),
        handles: new Map(),
        meta: new Map(),
        moduleToIds: new Map(),
        seen: new Map(),
        pendingChanges: [],
        revision: 0,
        hash: (p) => structuralHash(p),
        diff: (a, b) => structuralHash(a) !== structuralHash(b),
    };
}

const mintHandle = (def: Payload): HandleOf<Payload> => ({ id: def.id, dependency: { registry: 'test', id: def.id }, def });

/** drain and return the ids that fired a `changed` event on a store. */
function takeChanged(store: RegistryStore<Payload>): string[] {
    const ids = store.pendingChanges.filter((c) => c.kind === 'changed').map((c) => c.id);
    store.pendingChanges.length = 0;
    return ids;
}

describe('declare', () => {
    it('mints once, then swaps the def under the same handle', () => {
        const store = makeStore();
        const first = declare(store, 'a', () => ({ id: 'a', value: 1 }), mintHandle);
        expect(first.def.value).toBe(1);
        store.pendingChanges.length = 0;

        const second = declare(store, 'a', () => ({ id: 'a', value: 2 }), mintHandle);
        expect(second).toBe(first); // identity survives the re-declare
        expect(first.def.value).toBe(2); // ...and the importer's reference sees it
        expect(takeChanged(store)).toEqual(['a']);
        expect(store.byId.get('a')).toBe(first.def);
    });

    it('stays silent to dispatch when the content did not move', () => {
        const store = makeStore();
        const first = declare(store, 'a', () => ({ id: 'a', value: 1 }), mintHandle);
        store.pendingChanges.length = 0;

        expect(declare(store, 'a', () => ({ id: 'a', value: 1 }), mintHandle)).toBe(first);
        expect(takeChanged(store)).toEqual([]);
    });

    it('hands the previous def to mintDef so a kind can merge onto it', () => {
        const store = makeStore();
        declare(store, 'a', () => ({ id: 'a', value: 1 }), mintHandle);
        const merged = declare(store, 'a', (previous) => ({ ...previous!, id: 'a' }), mintHandle);
        expect(merged.def.value).toBe(1);
    });

    it('adopts a placeholder that a codegen barrel seeded before user code ran', () => {
        const store = makeStore();
        upsert(store, 'a', { id: 'a', value: 7 });
        expect(store.handles.has('a')).toBe(false);

        const handle = declare(store, 'a', (previous) => ({ ...previous!, id: 'a' }), mintHandle);
        expect(handle.def.value).toBe(7);
        expect(store.handles.get('a')).toBe(handle);
    });

    it('never prunes handles, so an id re-declared later keeps its identity', () => {
        const store = makeStore();
        const first = declare(store, 'a', () => ({ id: 'a', value: 1 }), mintHandle);
        store.byId.delete('a');
        store.meta.delete('a');

        expect(declare(store, 'a', () => ({ id: 'a', value: 3 }), mintHandle)).toBe(first);
        expect(first.def.value).toBe(3);
    });

    it('carries `id` on the handle, since identity cannot go stale the way data can', () => {
        const store = makeStore();
        const handle = declare(store, 'a', () => ({ id: 'a', value: 1 }), mintHandle);
        declare(store, 'a', () => ({ id: 'a', value: 2 }), mintHandle);
        // `id` is the one field safe to hold outside the def: a re-declaration of an
        // id is by definition the same id, so it can never drift from the def the way
        // `name` or any other authored field would.
        expect(handle.id).toBe('a');
        expect(handle.id).toBe(handle.def.id);
    });

    it('leaves upsert as the fresh-object path it always was', () => {
        const store = makeStore();
        const first = upsert(store, 'a', { id: 'a', value: 1 });
        expect(upsert(store, 'a', { id: 'a', value: 2 })).not.toBe(first);
    });
});

// ── per-kind contract ───────────────────────────────────────────────
//
// Each case re-declares one id with CHANGED content, the way a module re-eval
// under HMR does, and asserts the handle an importer is still holding is the one
// that got updated.

describe('re-declaration preserves handle identity', () => {
    it('blockTexture', () => {
        const first = blockTexture('t', { src: 'a.png' });
        const second = blockTexture('t', { src: 'b.png' });
        expect(second).toBe(first);
        expect(first.def.frames).toHaveLength(1);
    });

    it('block', () => {
        blockTexture('t', { src: 'a.png' });
        const first = block('stone', { name: 'Stone' });
        const second = block('stone', { name: 'Rock' });
        expect(second).toBe(first);
        expect(first.def.name).toBe('Rock');
    });

    it('sprite', () => {
        const first = sprite('s', { src: 'a.png' });
        const second = sprite('s', { src: 'b.png' });
        expect(second).toBe(first);
        expect(first.def.src).toBe('b.png');
    });

    it('particle', () => {
        const s = sprite('p', { src: 'a.png' });
        const first = particle('fx', { sprite: s, playback: 'loop', update: () => {}, glow: 0 });
        const second = particle('fx', { sprite: s, playback: 'loop', update: () => {}, glow: 1 });
        expect(second).toBe(first);
        expect(first.def.glow).toBe(1);
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
        expect((handle.construct() as Record<string, unknown>).hp).toBe(1);

        trait('t', { hp: 5 });
        const instance = handle.construct() as Record<string, unknown>;
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
