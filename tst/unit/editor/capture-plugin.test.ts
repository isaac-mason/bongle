import { compilePipeline, type PluginCtx, runTransform } from 'shakeup';
import { describe, expect, it } from 'vitest';
import { capturePlugin } from '../../../build/capture/capture-plugin';

// Drive the capture plugin through shakeup's real plugin pipeline (compilePipeline + runTransform),
// with a minimal ctx that only implements the `resolve` the plugin uses. One pipeline instance per
// scenario = one shared registry, so modules run in order populate it for cross-module resolution.
function makeRunner(resolveMap: Record<string, string> = {}) {
    const pipeline = compilePipeline([capturePlugin()]);
    const ctx = { resolve: async (spec: string) => ({ id: resolveMap[spec] ?? spec }) } as unknown as PluginCtx;
    return async (id: string, code: string): Promise<string> => (await runTransform(pipeline, ctx, code, id)).code;
}

const L = (...lines: string[]) => lines.join('\n');

describe('capturePlugin (through shakeup pipeline)', () => {
    it('wraps a same-module script consumer', async () => {
        const run = makeRunner();
        const out = await run(
            'game.ts',
            L(`import { trait, script } from 'bongle';`, `const E = trait('e');`, `script(E, 'tick', (c) => { E; });`),
        );
        expect(out).toContain('__bongle.deps(script(');
        expect(out).toContain('[() => E])');
    });

    it('offers a cross-module producer without the producer module being seen first', async () => {
        const run = makeRunner();
        const out = await run(
            'scripts.ts',
            L(
                `import { script } from 'bongle';`,
                `import { Enemy } from './traits';`,
                `script(Enemy, 'tick', (c) => { Enemy; });`,
            ),
        );
        expect(out).toContain('__bongle.deps(script(');
        expect(out).toContain('[() => Enemy])');
    });

    it('brackets a module with no producer refs (rung-1 only: __bongle import + push/pop, no dep-wrap)', async () => {
        const run = makeRunner();
        const code = L(`import { script } from 'bongle';`, `script(Foo, 'tick', (c) => { c.log('x'); });`);
        const out = await run('plain.ts', code);
        expect(out).toContain(`import { __bongle } from 'bongle/internal';`); // rung-1 bracket applied
        expect(out).toContain('__bongle.push(import.meta.url)');
        expect(out).toContain(code); // original body preserved
        expect(out).not.toContain('__bongle.deps'); // no consumer → no dep-wrap
    });

    it('brackets even on a parse error (dep-wrap is a no-op, body preserved inside the bracket)', async () => {
        const run = makeRunner();
        const broken = `const x = (;`;
        const out = await run('broken.ts', broken);
        expect(out).toContain(`import { __bongle } from 'bongle/internal';`);
        expect(out).toContain(broken);
    });
});
