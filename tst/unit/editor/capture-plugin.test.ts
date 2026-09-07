import type { PluginCtx } from 'shakeup';
import { describe, expect, it } from 'vitest';
import { capturePlugin } from '../../../build/capture/capture-plugin';

// Drive the capture plugin's transform hook directly with a minimal ctx. The hook is pure
// (parse + rewrite, no `this.resolve`), so a pipeline instance would add nothing here; the
// dev-server composition is covered by capture-devserver.test.ts.
function makeRunner() {
    const hook = capturePlugin().transform;
    const transform = typeof hook === 'function' ? hook : hook!.handler;
    const ctx = {} as PluginCtx;
    return async (id: string, code: string): Promise<string> => {
        const out = await transform.call(ctx, code, id);
        return typeof out === 'string' ? out : (out as { code: string }).code;
    };
}

const L = (...lines: string[]) => lines.join('\n');

describe('capturePlugin', () => {
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
