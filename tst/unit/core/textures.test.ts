// The `texture()` kind: one picture, from disk or computed from other textures.
//
// This is the half of the sprite/tile split that has identity. Its predecessor, `draw()`,
// was a value constructor with no store — no id, no hash of its own, no dep edges, no
// dedup, and nothing to name in an error. Everything asserted here is a capability the
// old shape could not have.
//
// The dep edges are the load-bearing part: a computed texture's sources are `DepKey`s in
// its def, so `hash` sees WHICH textures it draws from but not their pixels. Content
// reaches consumers through DepGraph instead, which is why `deps` must return them.

import { beforeEach, describe, expect, it } from 'vitest';
import { __popModule, __pushModule } from '../../../src/core/capture/module-scope';
import { registry, texture, textureStore } from '../../../src/core/registry';

const MOD = 'file:///game/textures.ts';

beforeEach(() => {
    registry._reset();
});

/** evaluate `body` as the module `MOD`, the way the injected prelude/postlude do. */
function evaluate(body: () => void): void {
    const previous = __pushModule(MOD);
    body();
    __popModule(previous);
}

describe('texture()', () => {
    it('declares a file texture', () => {
        const stone = texture('stone', { src: 'textures/stone.png' });
        expect(stone.def).toEqual({ id: 'stone', from: 'file', src: 'textures/stone.png' });
        expect(textureStore.byId.get('stone')).toBe(stone.def);
    });

    it('declares a computed texture, storing its inputs as dep refs', () => {
        const stone = texture('stone', { src: 'textures/stone.png' });
        const dust = texture('stone:dust', {
            size: [8, 8],
            inputs: { tex: stone },
            params: { seed: 7 },
            fn: () => {},
        });

        // handles in, DepKeys out: the API takes a pointer so the reference can't be a
        // typo or depend on declaration order, while the def stays plain hashable data.
        expect(dust.def).toMatchObject({
            id: 'stone:dust',
            from: 'computed',
            size: [8, 8],
            inputs: { tex: { registry: 'textures', id: 'stone' } },
            params: { seed: 7 },
        });
    });

    it('reports its inputs as deps, so a source edit can reach what is derived from it', () => {
        const stone = texture('stone', { src: 'textures/stone.png' });
        const dust = texture('stone:dust', { size: [8, 8], inputs: { tex: stone }, fn: () => {} });

        expect(textureStore.deps?.(dust.def)).toEqual([{ registry: 'textures', id: 'stone' }]);
        // a file texture draws from nothing.
        expect(textureStore.deps?.(stone.def)).toEqual([]);
    });

    it('keeps handle identity across a re-declaration', () => {
        const first = texture('stone', { src: 'a.png' });
        const second = texture('stone', { src: 'b.png' });

        expect(second).toBe(first);
        expect(first.def.from === 'file' && first.def.src).toBe('b.png');
    });

    it('stays silent to dispatch when nothing moved', () => {
        texture('stone', { src: 'a.png' });
        textureStore.pendingChanges.length = 0;

        texture('stone', { src: 'a.png' });
        expect(textureStore.pendingChanges).toEqual([]);
    });

    it('dedups by id, so sharing is by referencing the same handle', () => {
        const a = texture('shared', { src: 'a.png' });
        const b = texture('shared', { src: 'a.png' });

        expect(b).toBe(a);
        expect(textureStore.byId.size).toBe(1);
    });

    it('is reclaimed when its declaration disappears from the module', () => {
        evaluate(() => {
            texture('kept', { src: 'a.png' });
            texture('dropped', { src: 'b.png' });
        });
        expect(textureStore.byId.has('dropped')).toBe(true);

        // the module re-evaluates without the second declaration, as it would after the
        // author deletes the line.
        evaluate(() => {
            texture('kept', { src: 'a.png' });
        });

        expect(textureStore.byId.has('kept')).toBe(true);
        expect(textureStore.byId.has('dropped')).toBe(false);
    });
});

// A computed texture's `fn` is hashed as SOURCE TEXT, so everything it closes over is
// invisible: editing a captured constant, or a helper the fn calls rather than is, leaves
// the hash identical. `textureHash` answers `undefined` for those rather than claiming
// they are unchanged, so a re-declaration is always reported and the bake re-runs. The
// atlas builders hash the real baked pixels, so this costs a bake and writes nothing when
// the pixels did not actually move.
describe('change detection for a computed texture', () => {
    const changes = () => registry.textures.pendingChanges.map((c) => `${c.kind}:${c.id}`);

    it('reports a re-declaration whose fn source is byte-identical', () => {
        // stands in for a captured value the fn reads: the source text below never
        // changes, so a hash over it cannot tell these two runs apart.
        let captured = 1;
        const declare = () => texture('tint', { size: [1, 1], fn: (ctx) => ctx.fillRect(0, 0, captured, 1) });

        evaluate(declare);
        const revisionAfterFirst = registry.textures.revision;
        registry.textures.pendingChanges.length = 0;

        captured = 2;
        evaluate(declare);

        expect(changes()).toEqual(['changed:tint']);
        expect(registry.textures.revision).toBeGreaterThan(revisionAfterFirst);
    });

    it('stays silent for a re-declared FILE texture, which the hash does describe', () => {
        evaluate(() => texture('stone', { src: 'a.png' }));
        registry.textures.pendingChanges.length = 0;
        const revisionAfterFirst = registry.textures.revision;

        evaluate(() => texture('stone', { src: 'a.png' }));

        // the pessimism is scoped to what the hash genuinely cannot see; a path is
        // fully describable, so this still short-circuits.
        expect(changes()).toEqual([]);
        expect(registry.textures.revision).toBe(revisionAfterFirst);
    });

    it('still reports a file texture whose path actually moved', () => {
        evaluate(() => texture('stone', { src: 'a.png' }));
        registry.textures.pendingChanges.length = 0;

        evaluate(() => texture('stone', { src: 'b.png' }));

        expect(changes()).toEqual(['changed:stone']);
    });
});
