import { describe, expect, it } from 'vitest';
import { wrapModuleDeps } from '../../../build/capture/capture-native';

// Exercises the shakeup-native capture port (no injected ESTree parser — capture-native uses
// shakeup's parse directly).
//
// The pass emits CANDIDATE refs as thunks; `__addDeps` decides at runtime which are really
// producers (see capture-native.ts's header and dep-wrap.ts). So the assertions here are about
// which refs get offered, not about proving handle-ness statically.
describe('wrapModuleDeps (shakeup-native)', () => {
    it('wraps a script whose body references a same-module producer', async () => {
        const code = [
            `import { trait, script } from 'bongle';`,
            `const Enemy = trait('enemy');`,
            `script(Enemy, 'tick', (ctx) => { const t = Enemy; return t; });`,
        ].join('\n');
        const out = wrapModuleDeps('src/game.ts', code);
        expect(out).toContain('__bongle.deps(script(');
        expect(out).toContain('[() => Enemy])');
    });

    it('offers a producer imported from another module (cross-module edge)', async () => {
        const consumer = [
            `import { script } from 'bongle';`,
            `import { Enemy } from './traits';`,
            `import { Player } from './player';`,
            `script(Player, 'tick', (ctx) => { getTrait(ctx.node, Enemy); });`,
        ].join('\n');
        const out = wrapModuleDeps('src/scripts.ts', consumer);
        expect(out).toContain('__bongle.deps(script(');
        expect(out).toContain('() => Enemy');
    });

    // The regression that motivated moving the decision to runtime: the producer module's symbol
    // table used to be required here, and a dev server transforming top-down never has it yet.
    it('does not depend on the producer module having been transformed first', async () => {
        const consumer = [
            `import { script } from 'bongle';`,
            `import { Enemy } from './traits';`,
            `import { Player } from './player';`,
            `script(Player, 'tick', (ctx) => { getTrait(ctx.node, Enemy); });`,
        ].join('\n');
        // no shared state to seed, and nothing to seed it from — the same input always wraps.
        expect(wrapModuleDeps('src/scripts.ts', consumer)).toBe(wrapModuleDeps('src/scripts.ts', consumer));
        expect(wrapModuleDeps('src/scripts.ts', consumer)).toContain('() => Enemy');
    });

    it('offers a namespace-import member, not the bare namespace', async () => {
        const code = [
            `import { script } from 'bongle';`,
            `import * as T from './traits';`,
            `const Player = T.Player;`,
            `script(Player, 'tick', (ctx) => { getTrait(ctx.node, T.Enemy); });`,
        ].join('\n');
        const out = wrapModuleDeps('src/game.ts', code);
        expect(out).toContain('() => T.Enemy');
        expect(out).not.toContain('() => T,');
    });

    it('leaves a consumer with no candidate refs untouched', async () => {
        const code = `import { script } from 'bongle';\nscript(SomeTrait, 'tick', (ctx) => { ctx.log('hi'); });`;
        const out = wrapModuleDeps('src/plain.ts', code);
        expect(out).not.toContain('__bongle.deps');
        expect(out).toBe(code);
    });

    // The engine signature is `script(handle, scriptId, factory, opts?)` — the factory is the THIRD
    // argument. Reading it from the second silently matches nothing at every real call site, so the
    // producer edges scripts depend on never get wired and a producer edit can't reach them.
    it('finds the factory at arg 3, past the required scriptId', async () => {
        const code = [
            `import { trait, script } from 'bongle';`,
            `const Enemy = trait('enemy');`,
            `script(Enemy, 'tick', (ctx) => { Enemy; }, { editor: true });`,
        ].join('\n');
        const out = wrapModuleDeps('src/game.ts', code);
        // a trailing opts object must not displace the factory.
        expect(out).toContain('__bongle.deps(script(');
        expect(out).toContain('[() => Enemy])');
    });

    it('does not wrap when the factory slot holds a non-function', async () => {
        const code = [
            `import { trait, script } from 'bongle';`,
            `const Enemy = trait('enemy');`,
            `script(Enemy, 'tick', someFactoryRef);`,
        ].join('\n');
        const out = wrapModuleDeps('src/game.ts', code);
        // an indirect factory has no body to scan here — leave it alone rather than guess.
        expect(out).not.toContain('__bongle.deps');
    });

    it('returns source unchanged on a parse error (best-effort)', async () => {
        const broken = `const x = (;`;
        const out = wrapModuleDeps('src/broken.ts', broken);
        expect(out).toBe(broken);
    });
});
