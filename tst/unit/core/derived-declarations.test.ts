// Engine-DERIVED declarations are reclaimed with their source.
//
// `block()` derives dust textures and sprites from the block's top face
// (`<id>:particle{0,1,2}`), so one block declaration silently produces several more
// registry entries. Those are real declarations — they land in the texture, sprite
// and particle stores, get packed into the atlas, and are shipped to every game.
//
// They used to be declared with the owning-module stack empty, i.e. under
// `__prod__`, which never gets a module scope and is therefore never swept. So
// deleting a `block()` from source removed the block and left its dust behind for
// the lifetime of the process — and in the asset pipeline, in the built atlas.
//
// The fix adds no second reclamation path: deriving needs only the tile HANDLE the
// model names, so it happens at DECLARATION time, inside the declaring module's own
// scope. The dust is therefore owned by the same module as the block it came from,
// and the ordinary per-module mark-and-sweep reclaims it for free. That ownership is
// the mechanism, so it is asserted directly below rather than inferred from the
// entries happening to disappear.

import { registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __decideReload, __popModule, __pushModule } from '../../../src/core/capture/module-scope';
import { registry, reindexRegistry, tile } from '../../../src/core/registry';
import { cube } from '../../../src/core/voxels/block-presets';

const MOD = 'file:///game/blocks.ts';

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    registry._reset();
});

/** evaluate `body` as the module `MOD`, the way the injected prelude/postlude do. */
function evaluate(body: () => void): void {
    const previous = __pushModule(MOD);
    body();
    __popModule(previous);
}

const dustIds = () => [...registry.sprites.byId.keys()].filter((id) => id.startsWith('stone:particle'));

describe('engine-derived declarations', () => {
    it('derives dust for a declared block', () => {
        evaluate(() => {
            const t = tile('t', { src: 'a.png' });
            cube('stone', { name: 'Stone', tiles: t });
        });
        reindexRegistry(registry);

        expect(dustIds().length).toBeGreaterThan(0);
    });

    it('gives the dust the same owning module as the block it came from', () => {
        evaluate(() => {
            const t = tile('t', { src: 'a.png' });
            cube('stone', { name: 'Stone', tiles: t });
        });

        // No reindex: derivation is part of the declaration, not of the freeze,
        // so the entries and their ownership exist the moment the module has run.
        expect(registry.blocks.meta.get('stone')?.module).toBe(MOD);
        const ids = dustIds();
        // guard the loop below against passing vacuously on zero entries.
        expect(ids.length, 'declaring a block must derive dust').toBeGreaterThan(0);
        for (const id of ids) {
            expect(registry.sprites.meta.get(id)?.module, `dust sprite ${id}`).toBe(MOD);
            expect(registry.sprites.meta.get(id)?.module, `sprite ${id}`).toBe(MOD);
            expect(registry.textures.meta.get(id)?.module, `texture ${id}`).toBe(MOD);
        }
    });

    it('reclaims the dust when the block declaration is deleted', () => {
        evaluate(() => {
            const t = tile('t', { src: 'a.png' });
            cube('stone', { name: 'Stone', tiles: t });
        });
        reindexRegistry(registry);
        expect(dustIds().length).toBeGreaterThan(0);

        // the module re-evaluates without the block, as it would after the author
        // deletes the line: the registry's passive removal drops the block, and the
        // next build must drop what was derived from it.
        evaluate(() => {
            tile('t', { src: 'a.png' });
        });
        reindexRegistry(registry);

        expect(registry.blocks.byId.has('stone')).toBe(false);
        expect(dustIds()).toEqual([]);
    });

    it('keeps dust across a re-declaration that still has the block', () => {
        evaluate(() => {
            const t = tile('t', { src: 'a.png' });
            cube('stone', { name: 'Stone', tiles: t });
        });
        reindexRegistry(registry);
        const before = dustIds();

        evaluate(() => {
            const t = tile('t', { src: 'a.png' });
            cube('stone', { name: 'Rock', tiles: t });
        });
        reindexRegistry(registry);

        // re-derived on the new pass, so the sweep must not take them.
        expect(dustIds()).toEqual(before);
    });
});

// Deriving at declaration time means the dust snapshots WHICH texture the tile's frame
// names. Handle identity does not keep that current, so a tile that re-points its frames
// has to cascade to importers rather than self-accept — that is what gets the block
// module re-run, the dust re-derived, and the stale entries swept. Nothing bespoke: it is
// the ordinary boundary rule, reached by giving `tileStore` a frames signature.
describe('a tile that re-points its frames invalidates its importers', () => {
    // `registry._reset()` clears the stores, not module-scope's per-module run records, so
    // each case gets its own module id rather than inheriting the previous one's baseline.
    function declaring(moduleId: string) {
        /** evaluate the module, then take the reload decision as the injected accept does. */
        return (body: () => unknown): string => {
            const previous = __pushModule(moduleId);
            const exported = body();
            __popModule(previous);
            return __decideReload(moduleId, { Stone: exported as Record<string, unknown> });
        };
    }

    it('patches when only the pixels move, cascades when the frame textures do', () => {
        const decide = declaring('file:///game/stone-tiles.ts');
        expect(decide(() => tile('kit:stone', { src: 'a.png' }))).toBe('initial');

        // same single frame, so `kit:stone` still resolves and dust stays correct.
        expect(decide(() => tile('kit:stone', { src: 'b.png' }))).toBe('patch');

        // static -> animated renames frame 0 from `kit:stone` to `kit:stone:0`, so anything
        // that resolved the old id is now pointing at nothing.
        expect(decide(() => tile('kit:stone', { src: ['b.png', 'c.png'] }))).toBe('invalidate');
    });

    it('patches an fps tweak, which nothing reads at declaration time', () => {
        const decide = declaring('file:///game/lava-tiles.ts');
        expect(decide(() => tile('kit:lava', { src: ['0.png', '1.png'], fps: 2 }))).toBe('initial');
        expect(decide(() => tile('kit:lava', { src: ['0.png', '1.png'], fps: 8 }))).toBe('patch');
    });
});
