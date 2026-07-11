import { beforeEach, describe, expect, it } from 'vitest';
import {
    __decideReload,
    __popModule,
    __pushModule,
    _reset,
    recordScript,
    recordTrait,
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
 * We drive the module-scope snapshot directly through the same push/record/pop
 * surface the Vite transform injects, then call `__decideReload` with a
 * synthetic module namespace standing in for the freshly-evaluated exports.
 */

const MOD = 'file:///game/mod.ts';

/** a stand-in for a declarative handle: every real handle carries this stamp. */
function handle(registry: string, id: string): unknown {
    return { dependency: { registry, id } };
}

/** simulate one evaluation of MOD that records the given traits/scripts. */
function evaluate(record: () => void): void {
    const prev = __pushModule(MOD);
    record();
    __popModule(prev);
}

describe('module-scope — reload decision', () => {
    beforeEach(() => _reset());

    it('returns "initial" on the first evaluation (no previous snapshot)', () => {
        evaluate(() => recordTrait('mod/a', 'hash-1'));
        expect(__decideReload(MOD, { A: handle('traits', 'mod/a') })).toBe('initial');
    });

    it('patches when exports are all handles and shape is unchanged', () => {
        evaluate(() => recordTrait('mod/a', 'hash-1'));
        evaluate(() => recordTrait('mod/a', 'hash-1'));
        expect(__decideReload(MOD, { A: handle('traits', 'mod/a') })).toBe('patch');
    });

    it('patches a pure side-effect module that exports nothing', () => {
        evaluate(() => recordScript('mod/a.tick'));
        evaluate(() => recordScript('mod/a.tick'));
        expect(__decideReload(MOD, {})).toBe('patch');
    });

    it('invalidates when the module exports a non-handle value (a helper fn)', () => {
        evaluate(() => recordTrait('mod/a', 'hash-1'));
        evaluate(() => recordTrait('mod/a', 'hash-1'));
        // shape is stable, but a plain function export can't be swapped in place
        const fresh = { A: handle('traits', 'mod/a'), generateCourse: () => 42 };
        expect(__decideReload(MOD, fresh)).toBe('invalidate');
    });

    it('invalidates a pure-helper module (only non-handle exports)', () => {
        // no handles registered at all — the course.ts case
        evaluate(() => {});
        evaluate(() => {});
        expect(__decideReload(MOD, { generateCourse: () => 42 })).toBe('invalidate');
    });

    it('invalidates when a trait body hash changes even if exports are all handles', () => {
        evaluate(() => recordTrait('mod/a', 'hash-1'));
        evaluate(() => recordTrait('mod/a', 'hash-2'));
        expect(__decideReload(MOD, { A: handle('traits', 'mod/a') })).toBe('invalidate');
    });

    it('invalidates when a script key is added (binding-shape change)', () => {
        evaluate(() => {
            recordTrait('mod/a', 'hash-1');
            recordScript('mod/a.tick');
        });
        evaluate(() => {
            recordTrait('mod/a', 'hash-1');
            recordScript('mod/a.tick');
            recordScript('mod/a.render');
        });
        expect(__decideReload(MOD, { A: handle('traits', 'mod/a') })).toBe('invalidate');
    });

    it('treats a non-handle object export (no dependency stamp) as non-swappable', () => {
        evaluate(() => recordTrait('mod/a', 'hash-1'));
        evaluate(() => recordTrait('mod/a', 'hash-1'));
        expect(__decideReload(MOD, { config: { some: 'object' } })).toBe('invalidate');
    });
});
