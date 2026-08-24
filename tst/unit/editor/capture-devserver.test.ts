import { createDevServer, type Fs } from 'shakeup';
import { describe, expect, it } from 'vitest';
import { capturePlugin } from '../../../build/capture/capture-plugin';

// Stage-2 gate: the capture plugin composes into shakeup's dev-server transform pipeline. A
// fetched consumer module comes back with BOTH the __bongle.deps(...) wrap (from the capture
// plugin) AND the native runner-format rewrite (from the dev server's devTransform), with its
// cross-module producer edge resolved through ctx.resolve.
describe('capture plugin in the shakeup dev server', () => {
    it('wraps + rewrites a consumer; resolves the producer module', async () => {
        const files: Record<string, string> = {
            '/traits.ts': `import { trait } from 'bongle';\nexport const Enemy = trait('enemy');`,
            '/consumer.ts': `import { script } from 'bongle';\nimport { Enemy } from './traits';\nscript(Enemy, 'tick', (c) => { Enemy; });`,
        };
        const fs: Fs = { read: (id) => files[id] ?? null, exists: (id) => id in files };
        const server = createDevServer({ fs, external: ['bongle'], plugins: [capturePlugin()] });

        // Consumer FIRST — the order a dev server actually reaches them, walking down from an
        // entry. The wrap must not depend on the producer module having been transformed yet.
        const r = await server.fetchModule('/consumer.ts');
        await server.fetchModule('/traits.ts');

        expect(r.errors).toEqual([]);
        expect(r.code).toContain('__bongle.deps('); // capture wrap survived
        expect(r.code).toContain('__shakeup'); // native runner-format rewrite applied
        // The wrapped producer ref is itself rewritten to its runner-format member access
        // (Enemy is an imported binding → `_N.Enemy`), proving capture ∘ devTransform compose.
        expect(r.code).toMatch(/__bongle\.deps\(.*\[\(\) => _\d+\.Enemy\]\)/s);
        expect(r.deps).toContain('/traits.ts'); // cross-module edge resolved
    });

    it('leaves a non-consumer module free of deps wraps', async () => {
        const files: Record<string, string> = { '/plain.ts': `export const x = 1;\nexport const y = x + 1;` };
        const fs: Fs = { read: (id) => files[id] ?? null, exists: (id) => id in files };
        const server = createDevServer({ fs, plugins: [capturePlugin()] });
        const r = await server.fetchModule('/plain.ts');
        expect(r.errors).toEqual([]);
        expect(r.code).not.toContain('__bongle.deps');
    });
});
