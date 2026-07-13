// In-browser transform: the per-env plugin pipeline. Runs entirely in
// @rolldown/browser (no node):
//   1. envPlugin — replaceEnv(source, envValues): env.<key> → literal, per realm
//      (the extensible first slot; future per-env plugins chain here).
//   2. capture wrapper — bongle push/pop + self-accept, for USER project modules
//      only (NOT the prebundled lib chunks — they'd import bongle/internal as
//      themselves and don't need per-module HMR ownership).
//   3. oxc TS-strip (ts sources only).
//   4. moduleRunnerTransform (SSR rewrite) — the form the ModuleRunner evals.
//
// The capture wrapper is the SAME contract the kit Vite plugin injects: push/pop
// bracket the body so registry upserts stamp the owning module; the self-accept
// runs __kit.reload → invalidate-or-flush.

import { moduleRunnerTransform, transform } from '@rolldown/browser/experimental';
import { type EnvValues, replaceEnv } from './env-replace';

const PRELUDE = `import { __kit } from 'bongle/internal';
const __kit_prev = __kit.push(import.meta.url);
`;

const POSTLUDE = `
;__kit.pop(__kit_prev);
if (import.meta.hot) {
  import.meta.hot.accept((__kit_next) => {
    if (__kit.reload(import.meta.url, __kit_next) === 'invalidate') {
      import.meta.hot.invalidate();
    }
    __kit.flush();
  });
}
`;

export type TransformResult = {
    code: string;
    deps: string[];
    dynamicDeps: string[];
};

export type TransformOptions = {
    /** env values for this realm's graph — env.<key> → literal (per env). */
    env: EnvValues;
    /** inject the bongle capture wrapper — user project modules only, not the
     *  prebundled lib chunks. */
    capture: boolean;
};

const TS = /\.(ts|tsx|mts|cts)$/;
const KNOWN_EXT = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;

/** Transform one module for a realm: env replacement → (capture wrapper) →
 *  TS-strip → module-runner rewrite. `id` is the module id (a vfs path). */
export async function transformModule(id: string, source: string, opts: TransformOptions): Promise<TransformResult> {
    // 1. per-env replacement (first slot of the per-env pipeline).
    let code = replaceEnv(source, opts.env);
    // 2. capture wrapper (user modules only).
    if (opts.capture) code = PRELUDE + code + POSTLUDE;

    // oxc needs a filename with a known extension.
    const fname = KNOWN_EXT.test(id) ? id : `${id}.ts`;

    // 3. strip TS types (ts sources only; prebundled lib is already js).
    if (TS.test(fname)) {
        // onlyRemoveTypeImports is MANDATORY — otherwise oxc elides "unused"
        // value imports, breaking side-effect imports + the HMR graph.
        // biome-ignore lint/suspicious/noExplicitAny: rolldown experimental types are loose.
        const stripped = await transform(fname, code, { lang: 'ts', typescript: { onlyRemoveTypeImports: true } } as any);
        if (stripped.errors?.length) {
            // biome-ignore lint/suspicious/noExplicitAny: error shape is loose.
            throw new Error(`[transform] ${id}: ${stripped.errors.map((e: any) => e.message).join('\n')}`);
        }
        code = stripped.code;
    }

    // 4. module-runner (SSR) rewrite: imports → __vite_ssr_import__, etc.
    const r = await moduleRunnerTransform(fname, code, { sourcemap: false });
    if (r.errors?.length) {
        // biome-ignore lint/suspicious/noExplicitAny: error shape is loose.
        throw new Error(`[moduleRunnerTransform] ${id}: ${r.errors.map((e: any) => e.message).join('\n')}`);
    }
    return { code: r.code, deps: [...r.deps], dynamicDeps: [...r.dynamicDeps] };
}
