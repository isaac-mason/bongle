import type { Fs } from 'shakeup';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createShakeupBundlerHost } from '../../../build/dev/shakeup-host';
import { connectRealmPort, type RealmPort } from '../../../build/dev/shakeup-port';
import { browserEvaluator, makeImportMeta } from '../../../build/dev/shakeup-runner-host';
import { collectDirtyByRegistry } from '../../../src/core/capture/dep-graph';
import { registerFlushHandler } from '../../../src/core/capture/flush';
import { owningModule, _reset as resetModuleScope } from '../../../src/core/capture/module-scope';
import { registry } from '../../../src/core/registry';
import type { ScriptDef } from '../../../src/core/scene/scripts';
import { script } from '../../../src/core/registry';
import { trait } from '../../../src/core/registry';
import { __bongle } from '../../../src/internal-runtime';

// The capture bracket composed with shakeup's HMR, for real: the dev server transforms a user
// module through `capturePlugin` (so it gets the __bongle PRELUDE/POSTLUDE), a realm evaluates it
// over a port, and an fs edit drives the whole chain — handleChange → propagate → re-evaluate →
// the POSTLUDE's hot.accept → `__bongle.reload` → patch-or-invalidate.
//
// `bongle` and `bongle/internal` are bare specifiers, so the dev server externalises them and the
// runner native-imports them. We intercept that at the evaluator and hand back the REAL engine
// functions, so user code registers into the REAL registry singleton and the REAL module-scope
// snapshots. Nothing here is a stand-in for the runtime under test.

function portPair(): [RealmPort, RealmPort] {
    const a: RealmPort = { postMessage: (d) => queueMicrotask(() => b.onmessage?.({ data: d })), onmessage: null };
    const b: RealmPort = { postMessage: (d) => queueMicrotask(() => a.onmessage?.({ data: d })), onmessage: null };
    return [a, b];
}

const PROJECT = 'https://app.test/@project';

type Probe = {
    files: Record<string, string>;
    host: ReturnType<typeof createShakeupBundlerHost>;
    env: ReturnType<typeof connectRealmPort>;
    log: string[];
    flushes: number;
    /** ids shakeup gave up on: no accept boundary absorbed the edit. In the editor a realm
     *  can only warn about these (it cannot reload itself), so they are the signal that a
     *  save silently did nothing. */
    fullReloads: string[];
    /** errors `handleChange` rejected with — a module body that throws lands here. */
    editErrors: unknown[];
    take(): string[];
    /** write an edit and drive it through the host exactly as the editor's fs watcher would. */
    edit(path: string, code: string): Promise<void>;
};

function probe(files: Record<string, string>): Probe {
    const log: string[] = [];
    const state = { flushes: 0 };
    const fs: Fs = { read: async (id) => files[id] ?? null, exists: async (id) => id in files };
    const host = createShakeupBundlerHost({ fs, jsx: false, isUserModule: () => true });
    const [bundlerPort, runnerPort] = portPair();
    host.connectRealm('client', bundlerPort);

    // the realm's externals: the real engine surface user code calls.
    const bongle = { trait, script, log, owningModule };
    const evaluator = {
        ...browserEvaluator,
        async runExternalModule(spec: string): Promise<unknown> {
            if (spec === 'bongle/internal') return { __bongle };
            if (spec === 'bongle') return bongle;
            return browserEvaluator.runExternalModule(spec);
        },
    };
    const fullReloads: string[] = [];
    const editErrors: unknown[] = [];
    const env = connectRealmPort(runnerPort, {
        name: 'client',
        evaluator,
        createImportMeta: makeImportMeta((p) => `${PROJECT}${p}`),
        onFullReload: (id) => fullReloads.push(id),
    });

    registerFlushHandler(() => {
        state.flushes++;
    });

    const p: Probe = {
        files,
        host,
        env,
        log,
        fullReloads,
        editErrors,
        get flushes() {
            return state.flushes;
        },
        take: () => log.splice(0, log.length),
        edit: async (path, code) => {
            files[path] = code;
            // onFsChange is fire-and-forget in the editor, so await the underlying change to keep
            // the test deterministic, then drain the flush microtask the POSTLUDE schedules.
            // the editor's watcher is fire-and-forget with a .catch, so a broken edit rejects
            // there rather than propagating; mirror that so a throwing body is observable
            // instead of failing the test outright.
            await host.server.handleChange(path).catch((err: unknown) => {
                editErrors.push(err);
            });
            await new Promise((r) => setTimeout(r, 0));
        },
    } as Probe;
    return p;
}

/** a user module registering one script whose body logs `tag`. */
const scriptModule = (traitId: string, tag: string): string =>
    `import { trait, script, log } from 'bongle';
export const T = trait('${traitId}');
script(T, 'tick', (ctx) => { log.push('${tag}'); });`;

beforeEach(() => {
    resetModuleScope();
    registry.scripts.pendingChanges.length = 0;
    registry.traits.pendingChanges.length = 0;
});

describe('capture bracket + shakeup HMR', () => {
    it('makes every user module a self-accepting HMR boundary', async () => {
        const p = probe({ '/game.ts': scriptModule('hmr/boundary', 'v1') });
        await p.env.import('/game.ts');

        // without this the dev server has no boundary to stop at and every edit is a full reload.
        expect(p.host.server.node('/game.ts')?.hmr.selfAccepts).toBe(true);
        p.host.close();
    });

    it('brackets the module body so registrations are stamped with their owning module', async () => {
        const p = probe({
            '/game.ts': `import { owningModule, log } from 'bongle';\nlog.push(owningModule());\nexport const v = 1;`,
        });
        await p.env.import('/game.ts');

        // the PRELUDE pushed import.meta.url; registry upserts during the body see it as the owner.
        expect(p.take()).toEqual([`${PROJECT}/game.ts`]);
        // and the POSTLUDE popped it back off.
        expect(owningModule()).toBe('__prod__');
        p.host.close();
    });

    it('an edited script body is what the registry holds afterwards', async () => {
        const p = probe({ '/game.ts': scriptModule('hmr/swap', 'v1') });
        await p.env.import('/game.ts');

        const run = (): string[] => {
            const def = registry.scripts.byId.get('hmr/swap.tick') as ScriptDef;
            (def.factory as unknown as (ctx: unknown) => void)({});
            return p.take();
        };
        expect(run()).toEqual(['v1']);

        await p.edit('/game.ts', scriptModule('hmr/swap', 'v2'));
        // the registered factory must BE the edited one — this is the whole point of the feature.
        expect(run()).toEqual(['v2']);
        p.host.close();
    });

    it('a script-only edit patches in place, without cascading to importers', async () => {
        const p = probe({
            '/game.ts': scriptModule('hmr/patch', 'v1'),
            '/main.ts': `import { log } from 'bongle';\nimport './game';\nlog.push('main:eval');`,
        });
        await p.env.import('/main.ts');
        p.take();

        await p.edit('/game.ts', scriptModule('hmr/patch', 'v2'));
        // all exports are handles and the script key set is unchanged → 'patch'. The importer must
        // NOT re-evaluate: that's the surgical case, and re-running main would reset its state.
        expect(p.take()).toEqual([]);
        p.host.close();
    });

    it('a module exporting a non-handle invalidates and cascades to its importer', async () => {
        const helper = (n: number) => `import { log } from 'bongle';
export const bonus = () => ${n};
log.push('helper:eval:${n}');`;
        const p = probe({
            '/helper.ts': helper(1),
            '/main.ts': `import { log } from 'bongle';\nimport { bonus } from './helper';\nlog.push('main:eval:' + bonus());`,
        });
        await p.env.import('/main.ts');
        expect(p.take()).toEqual(['helper:eval:1', 'main:eval:1']);

        await p.edit('/helper.ts', helper(2));
        // `bonus` is captured by VALUE by main, so patching helper in place would leave main calling
        // the old function. __decideReload sees the non-handle export and invalidates; shakeup
        // bubbles to main, which re-links and sees the new value.
        expect(p.take()).toContain('main:eval:2');
        p.host.close();
    });

    // The regression this whole path exists for: /game.ts is transformed BEFORE /traits.ts (the dev
    // server walks down from the entry), so a transform-time producer lookup would miss and the edge
    // would never be wired. __addDeps settles it at runtime instead.
    it('a producer edit reaches the scripts that close over it, cross-module', async () => {
        const p = probe({
            '/traits.ts': `import { trait } from 'bongle';\nexport const Enemy = trait('hmr/enemy');`,
            '/game.ts': `import { trait, script, log } from 'bongle';
import { Enemy } from './traits';
export const T = trait('hmr/consumer');
script(T, 'tick', (ctx) => { log.push('tick'); Enemy; });`,
        });
        await p.env.import('/game.ts');

        // the dep-wrap is what wires script → producer; without it the edge below never exists.
        expect((await p.host.server.fetchModule('/game.ts')).code).toContain('__bongle.deps(');

        registry.traits.pendingChanges.length = 0;
        registry.scripts.pendingChanges.length = 0;
        await p.edit('/traits.ts', `import { trait } from 'bongle';\nexport const Enemy = trait('hmr/enemy', { hp: 10 });`);

        // dispatch narrows applyTraitSwap to this set — a script missing from it is a script that
        // silently keeps running its stale closure over the old producer.
        const dirty = collectDirtyByRegistry([registry.traits, registry.scripts]);
        expect(dirty.get('scripts')).toContain('hmr/consumer.tick');
        p.host.close();
    });

    it('the flush is requested once per edit, not once per registration', async () => {
        const p = probe({
            '/game.ts': `import { trait, script, log } from 'bongle';
export const T = trait('hmr/flush');
script(T, 'a', (ctx) => { log.push('a'); });
script(T, 'b', (ctx) => { log.push('b'); });
script(T, 'c', (ctx) => { log.push('c'); });`,
        });
        await p.env.import('/game.ts');
        const before = p.flushes;

        await p.edit('/game.ts', p.files['/game.ts'].replace("log.push('a')", "log.push('a2')"));
        // three script re-registrations in one module body, one coalesced flush.
        expect(p.flushes - before).toBe(1);
        p.host.close();
    });
});

// ── a module body that throws ─────────────────────────────────────────
//
// The capture POSTLUDE carries `__popModule` AND the `hot.accept` registration, and a body that
// throws reaches neither. `module-scope.ts` already guards two consequences of that (the owning
// stack via `resetOwnerStack`, the signature baseline via `beginRun`'s `completed` check); these
// pin down the third, the one a user actually feels: what it takes to get a bake out of the far
// side of a broken edit.
//
// Shaped like the real thing rather than a bare `throw`: a removed engine export called at module
// scope, which is what an API rename looks like to a project that has not caught up yet.
const brokenModule = (traitId: string): string =>
    `import { trait, gone } from 'bongle';
export const T = trait('${traitId}');
gone();`;

describe('a module body that throws', () => {
    // `handleChange` does not propagate the re-eval failure, so it surfaces as an unhandled
    // rejection instead. Captured here so the suite stays green while the tests below pin down
    // what that costs.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
        unhandled.push(err);
    };
    beforeAll(() => process.on('unhandledRejection', onUnhandled));
    afterAll(() => {
        process.off('unhandledRejection', onUnhandled);
    });

    it('never reaches the host error reporting, so the build log stays silent', async () => {
        const p = probe({ '/game.ts': scriptModule('hmr/throw-report', 'v1') });
        await p.env.import('/game.ts');

        await p.edit('/game.ts', brokenModule('hmr/throw-report'));

        // `shakeup-host.ts` reports via `handleChange(path).catch(reportError)`; a body that throws
        // rejects out of `applyEdit` WITHOUT that promise seeing it, so nothing reaches the editor.
        expect(p.editErrors).toEqual([]);
    });

    it('leaves the last-good registration in place', async () => {
        const p = probe({ '/game.ts': scriptModule('hmr/throw-keep', 'v1') });
        await p.env.import('/game.ts');
        expect(registry.traits.byId.has('hmr/throw-keep')).toBe(true);

        await p.edit('/game.ts', brokenModule('hmr/throw-keep'));

        // the runner restores the last-good instance, so the registry keeps what v1 declared.
        expect(registry.traits.byId.has('hmr/throw-keep')).toBe(true);
    });

    it('fires no flush, so nothing downstream of the registry is told to re-run', async () => {
        const p = probe({ '/game.ts': scriptModule('hmr/throw-flush', 'v1') });
        await p.env.import('/game.ts');
        const before = p.flushes;

        await p.edit('/game.ts', brokenModule('hmr/throw-flush'));

        expect(p.flushes).toBe(before);
    });

    // The shape a real project actually has: the broken file is a DEPENDENCY of the entry, and it
    // exports a plain function alongside its handles — so __decideReload invalidates and the update
    // has to bubble to the importer rather than patching in place. Both halves matter: a throw
    // leaves the importer linked to a module instance that never finished evaluating.
    it('recovers when the broken module is an imported dependency with a non-handle export', async () => {
        const dep = (tag: string) => `import { trait, log } from 'bongle';
export const T = trait('hmr/dep-recover');
export const help = () => '${tag}';
log.push('dep:${tag}');`;
        const brokenDep = `import { trait, gone, log } from 'bongle';
export const T = trait('hmr/dep-recover');
export const help = () => 'broken';
gone();
log.push('dep:unreachable');`;
        const p = probe({
            '/dep.ts': dep('v1'),
            '/main.ts': `import { log } from 'bongle';\nimport { help } from './dep';\nlog.push('main:' + help());`,
        });
        await p.env.import('/main.ts');
        expect(p.take()).toEqual(['dep:v1', 'main:v1']);

        await p.edit('/dep.ts', brokenDep);
        const afterBreak = p.flushes;
        p.take();

        await p.edit('/dep.ts', dep('v2'));

        expect(p.take()).toContain('main:v2'); // the importer re-linked to the fixed module
        expect(p.flushes).toBeGreaterThan(afterBreak);
        expect(p.fullReloads).toEqual([]);
        p.host.close();
    });

    it('recovers on the next good edit: the fix re-registers AND flushes', async () => {
        const p = probe({ '/game.ts': scriptModule('hmr/throw-recover', 'v1') });
        await p.env.import('/game.ts');
        await p.edit('/game.ts', brokenModule('hmr/throw-recover'));
        const afterBreak = p.flushes;
        p.take();

        await p.edit('/game.ts', scriptModule('hmr/throw-recover', 'v2'));

        // this is the whole question: does fixing a broken module get the pipeline a flush on its
        // own, or does the edit land on a path only a service restart can absorb?
        expect(p.flushes).toBeGreaterThan(afterBreak);
        expect(p.fullReloads).toEqual([]);
    });
});
