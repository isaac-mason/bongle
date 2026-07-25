import { afterEach, describe, expect, it } from 'vitest';
import { registerFlushHandler, requestFlush } from '../../../../src/core/capture/flush';
import { __pushModule, _reset, owningModule } from '../../../../src/core/capture/module-scope';

/**
 * Flush handlers are engine-level reconciliation (applyRegistryChanges, the
 * asset pipeline pass). They run in a coalesced microtask AFTER an HMR batch's
 * module bodies have all finished, so they must execute at __prod__ scope.
 *
 * The regression this guards: a user module body that throws between the
 * injected PRELUDE `__pushModule` and POSTLUDE `__popModule` leaks its id on
 * the owning-module stack (the pop is not exception-safe). Without a reset,
 * the next flush stamps reindex-derived registrations (e.g. block-dust
 * sprites) with that stale module as owner, and the registry's redeclaration
 * guard throws against the boot-time `__prod__` entry.
 */

const MOD = 'file:///game/src/models.ts';

/** run the microtask queue so a queued flush actually fires. */
function drainMicrotasks(): Promise<void> {
    return new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
}

describe('flush — owner scope', () => {
    afterEach(() => _reset());

    it('runs handlers at __prod__ scope even when a thrown module leaked on the stack', async () => {
        // simulate a module body that threw after push, before pop.
        __pushModule(MOD);
        expect(owningModule()).toBe(MOD);

        let owner = 'unset';
        const off = registerFlushHandler(() => {
            owner = owningModule();
        });

        requestFlush();
        await drainMicrotasks();
        off();

        expect(owner).toBe('__prod__');
    });

    it('coalesces multiple requests in a tick into a single handler run', async () => {
        let runs = 0;
        const off = registerFlushHandler(() => {
            runs++;
        });

        requestFlush();
        requestFlush();
        requestFlush();
        await drainMicrotasks();
        off();

        expect(runs).toBe(1);
    });

    it('a throwing handler does not block siblings or wedge the scheduler', async () => {
        let secondRan = false;
        const offBad = registerFlushHandler(() => {
            throw new Error('boom');
        });
        const offGood = registerFlushHandler(() => {
            secondRan = true;
        });

        requestFlush();
        await drainMicrotasks();
        expect(secondRan).toBe(true);

        // scheduler must not be wedged: a later flush still fires.
        secondRan = false;
        requestFlush();
        await drainMicrotasks();
        offBad();
        offGood();
        expect(secondRan).toBe(true);
    });
});
