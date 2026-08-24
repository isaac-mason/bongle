import type { Fs } from 'shakeup';
import { beforeEach, describe, expect, it } from 'vitest';
import { createShakeupBundlerHost } from '../../../build/dev/shakeup-host';
import { connectRealmPort, type RealmPort } from '../../../build/dev/shakeup-port';
import { browserEvaluator, makeImportMeta } from '../../../build/dev/shakeup-runner-host';
import { collectDirtyByRegistry } from '../../../src/core/capture/dep-graph';
import { registerFlushHandler } from '../../../src/core/capture/flush';
import { owningModule, _reset as resetModuleScope } from '../../../src/core/capture/module-scope';
import { registry } from '../../../src/core/registry';
import type { ScriptDef } from '../../../src/core/scene/scripts';
import { script } from '../../../src/core/scene/scripts';
import { trait } from '../../../src/core/scene/traits';
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
    const env = connectRealmPort(runnerPort, {
        name: 'client',
        evaluator,
        createImportMeta: makeImportMeta((p) => `${PROJECT}${p}`),
    });

    registerFlushHandler(() => {
        state.flushes++;
    });

    const p: Probe = {
        files,
        host,
        env,
        log,
        get flushes() {
            return state.flushes;
        },
        take: () => log.splice(0, log.length),
        edit: async (path, code) => {
            files[path] = code;
            // onFsChange is fire-and-forget in the editor, so await the underlying change to keep
            // the test deterministic, then drain the flush microtask the POSTLUDE schedules.
            await host.server.handleChange(path);
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
