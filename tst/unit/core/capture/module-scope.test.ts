import { beforeEach, describe, expect, it } from 'vitest';
import {
    __decideReload,
    __popModule,
    __pushModule,
    _reset,
    owningModule,
    recordDeclaration,
    resetOwnerStack,
} from '../../../../src/core/capture/module-scope';

/**
 * The HMR reload decision (`__decideReload`) is the correctness core of
 * in-place patching: it decides whether a re-evaluated user module can
 * self-accept (`patch`) or must cascade to its importers (`invalidate`).
 *
 * The rule (React Fast Refresh's boundary rule): patch only when every export
 * is a hot-swappable engine handle AND the trait/script shape is unchanged.
 * Any non-handle export (a helper fn, a constant) is captured by-value by
 * importers, so patching in place would strand them on the stale binding —
 * those modules must invalidate.
 *
 * We drive the recorded signatures directly through the same push/record/pop
 * surface `registry-store`'s `commit` uses, then call `__decideReload` with a
 * synthetic module namespace standing in for the freshly-evaluated exports.
 *
 * `__decideReload` is what ROTATES the baseline (rather than module push), so a
 * run is only ever compared against the last evaluation that actually reached a
 * decision. Each `evaluate()` below is therefore followed by the decision, the
 * way the injected `hot.accept` callback does it in production.
 */

const MOD = 'file:///game/mod.ts';

/** a stand-in for a declarative handle: every real handle carries this stamp. */
function handle(registry: string, id: string): unknown {
    return { dependency: { registry, id } };
}

const recordTrait = (id: string, bodyHash: string) => recordDeclaration(MOD, 'traits', id, bodyHash);
/** scripts opt in with no signature: the declared-id SET is the whole shape. */
const recordScript = (key: string) => recordDeclaration(MOD, 'scripts', key, '');
/** tiles sign over WHICH textures their frames name (see `tileStore`'s `hmr`). */
const recordTile = (id: string, framesHash: string) => recordDeclaration(MOD, 'tiles', id, framesHash);

/** simulate one evaluation of MOD that records the given traits/scripts. */
function evaluate(record: () => void): void {
    const prev = __pushModule(MOD);
    record();
    __popModule(prev);
}

/** one evaluation followed by the decision, as the injected hot.accept does. */
function evaluateAndDecide(record: () => void, exports: Record<string, unknown> = {}): string {
    evaluate(record);
    return __decideReload(MOD, exports);
}

describe('module-scope — reload decision', () => {
    beforeEach(() => _reset());

    it('returns "initial" on the first evaluation (no previous snapshot)', () => {
        expect(evaluateAndDecide(() => recordTrait('mod/a', 'hash-1'), { A: handle('traits', 'mod/a') })).toBe('initial');
    });

    it('patches when exports are all handles and shape is unchanged', () => {
        const exports = { A: handle('traits', 'mod/a') };
        evaluateAndDecide(() => recordTrait('mod/a', 'hash-1'), exports);
        expect(evaluateAndDecide(() => recordTrait('mod/a', 'hash-1'), exports)).toBe('patch');
    });

    it('patches a pure side-effect module that exports nothing', () => {
        evaluateAndDecide(() => recordScript('mod/a.tick'));
        expect(evaluateAndDecide(() => recordScript('mod/a.tick'))).toBe('patch');
    });

    it('invalidates when the module exports a non-handle value (a helper fn)', () => {
        evaluateAndDecide(() => recordTrait('mod/a', 'hash-1'));
        // shape is stable, but a plain function export can't be swapped in place
        const fresh = { A: handle('traits', 'mod/a'), generateCourse: () => 42 };
        expect(evaluateAndDecide(() => recordTrait('mod/a', 'hash-1'), fresh)).toBe('invalidate');
    });

    it('invalidates a pure-helper module (only non-handle exports)', () => {
        // no handles registered at all — the course.ts case
        evaluateAndDecide(() => {});
        expect(evaluateAndDecide(() => {}, { generateCourse: () => 42 })).toBe('invalidate');
    });

    it('invalidates when a trait body hash changes even if exports are all handles', () => {
        const exports = { A: handle('traits', 'mod/a') };
        evaluateAndDecide(() => recordTrait('mod/a', 'hash-1'), exports);
        expect(evaluateAndDecide(() => recordTrait('mod/a', 'hash-2'), exports)).toBe('invalidate');
    });

    it('invalidates when a script key is added (binding-shape change)', () => {
        const exports = { A: handle('traits', 'mod/a') };
        evaluateAndDecide(() => {
            recordTrait('mod/a', 'hash-1');
            recordScript('mod/a.tick');
        }, exports);
        expect(
            evaluateAndDecide(() => {
                recordTrait('mod/a', 'hash-1');
                recordScript('mod/a.tick');
                recordScript('mod/a.render');
            }, exports),
        ).toBe('invalidate');
    });

    it('treats a non-handle object export (no dependency stamp) as non-swappable', () => {
        evaluateAndDecide(() => recordTrait('mod/a', 'hash-1'));
        expect(evaluateAndDecide(() => recordTrait('mod/a', 'hash-1'), { config: { some: 'object' } })).toBe('invalidate');
    });

    // A tile module exports nothing but tile handles, so the export rule alone would let
    // it self-accept forever. It must not: `block()` reads a tile's frame texture at
    // DECLARATION time to derive dust, which is a by-value read that handle identity does
    // not keep current. Re-pointing the frames has to cascade so the importing block
    // module re-declares and re-derives.
    it('invalidates when a tile re-points its frames, so importers re-derive from it', () => {
        const exports = { Stone: handle('tiles', 'kit:stone') };
        evaluateAndDecide(() => recordTile('kit:stone', 'frames-[kit:stone]'), exports);
        // `src: 'a.png'` -> `src: ['a.png', 'b.png']`: frame 0 is renamed `id` -> `id:0`.
        expect(evaluateAndDecide(() => recordTile('kit:stone', 'frames-[kit:stone:0,kit:stone:1]'), exports)).toBe('invalidate');
    });

    it('patches a tile whose pixels changed but whose frame textures did not', () => {
        const exports = { Stone: handle('tiles', 'kit:stone') };
        // `src: 'a.png'` -> `src: 'b.png'` keeps one frame under the same texture id, so
        // everything derived from it still resolves; the new pixels ride the flush path.
        evaluateAndDecide(() => recordTile('kit:stone', 'frames-[kit:stone]'), exports);
        expect(evaluateAndDecide(() => recordTile('kit:stone', 'frames-[kit:stone]'), exports)).toBe('patch');
    });
});

describe('module-scope — owner stack recovery', () => {
    beforeEach(() => _reset());

    it('reports __prod__ when the stack is empty', () => {
        expect(owningModule()).toBe('__prod__');
    });

    it('drops a module id leaked by a throwing body (push without pop)', () => {
        // a module body that throws between __pushModule (PRELUDE) and
        // __popModule (POSTLUDE) never pops — its id leaks on the stack.
        __pushModule(MOD);
        expect(owningModule()).toBe(MOD);
        resetOwnerStack();
        expect(owningModule()).toBe('__prod__');
    });

    it('preserves recorded signatures across a reset (only the stack clears)', () => {
        // reload decisions key off per-module snapshots, not the stack, so a
        // reset must not wipe them.
        const exports = { A: handle('traits', 'mod/a') };
        evaluateAndDecide(() => recordTrait('mod/a', 'hash-1'), exports);
        resetOwnerStack();
        expect(evaluateAndDecide(() => recordTrait('mod/a', 'hash-1'), exports)).toBe('patch');
    });
});
