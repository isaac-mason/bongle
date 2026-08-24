import { describe, expect, it } from 'vitest';
import { browserEvaluator, ensureProcessShim, makeImportMeta } from '../../../build/dev/shakeup-runner-host';

describe('shakeup runner host (browser bits)', () => {
    it('browser evaluator rejects node: builtins (composition leak)', async () => {
        await expect(browserEvaluator.runExternalModule('node:fs')).rejects.toThrow(
            /node builtin 'node:fs' entered a browser realm/,
        );
    });

    it('keeps the default evaluator shape (startOffset + runModule)', () => {
        expect(browserEvaluator.startOffset).toBe(2);
        expect(typeof browserEvaluator.runModule).toBe('function');
    });

    it('makeImportMeta maps a module path to its project url + filename', () => {
        const meta = makeImportMeta((p) => `https://app.test/@project${p}`);
        expect(meta('/src/scene.ts')).toEqual({ url: 'https://app.test/@project/src/scene.ts', filename: '/src/scene.ts' });
    });

    it('ensureProcessShim provides process.env without clobbering an existing one', () => {
        ensureProcessShim();
        expect((globalThis as any).process.env.NODE_ENV).toBeDefined();
    });
});
