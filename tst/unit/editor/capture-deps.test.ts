import { describe, expect, it } from 'vitest';
import { initSymbolTables, wrapModuleDeps } from '../../../build/capture-deps';

// identity resolver: specs already ARE the module ids we key the registry by.
const idResolve = async (spec: string) => spec;

describe('wrapModuleDeps', () => {
    it('wraps a script whose body references a same-module producer', async () => {
        const reg = initSymbolTables();
        const code = [
            `import { trait, script } from 'bongle';`,
            `const Enemy = trait('enemy');`,
            `script(Enemy, (ctx) => { const t = Enemy; return t; });`,
        ].join('\n');
        const out = await wrapModuleDeps('src/game.ts', code, reg, idResolve);
        expect(out).toContain('__kit.deps(script(');
        expect(out).toContain('[Enemy])');
    });

    it('resolves a producer imported from another module (cross-module edge)', async () => {
        const reg = initSymbolTables();
        // parse the producer module first so its table is in the registry.
        await wrapModuleDeps('src/traits.ts', `import { trait } from 'bongle';\nexport const Enemy = trait('enemy');`, reg, idResolve);

        const consumer = [
            `import { script } from 'bongle';`,
            `import { Enemy } from './traits';`,
            `import { Player } from './player';`,
            `script(Player, (ctx) => { getTrait(ctx.node, Enemy); });`,
        ].join('\n');
        // './traits' → 'src/traits.ts' (in registry); './player' → opaque (no table).
        const resolve = async (spec: string) => (spec === './traits' ? 'src/traits.ts' : spec === './player' ? 'src/player.ts' : spec);
        const out = await wrapModuleDeps('src/scripts.ts', consumer, reg, resolve);
        expect(out).toContain('__kit.deps(script(');
        expect(out).toContain('[Enemy])');
    });

    it('leaves a consumer with no producer refs untouched', async () => {
        const reg = initSymbolTables();
        const code = `import { script } from 'bongle';\nscript(SomeTrait, (ctx) => { ctx.log('hi'); });`;
        const out = await wrapModuleDeps('src/plain.ts', code, reg, idResolve);
        expect(out).not.toContain('__kit.deps');
        expect(out).toBe(code);
    });

    it('returns source unchanged on a parse error (best-effort)', async () => {
        const reg = initSymbolTables();
        const broken = `const x = (;`;
        const out = await wrapModuleDeps('src/broken.ts', broken, reg, idResolve);
        expect(out).toBe(broken);
    });
});
