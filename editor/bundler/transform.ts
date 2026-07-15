// In-browser transform. Runs entirely in @rolldown/browser (no node):
//   1. capture wrapper — bongle push/pop + self-accept, for USER project modules
//      only (NOT the seeded lib source — it imports bongle/internal as itself and
//      doesn't need per-module HMR ownership).
//   2. oxc TS-strip (ts/tsx sources only).
//   3. moduleRunnerTransform (SSR rewrite) — the form the ModuleRunner evals.
//
// ENV-NEUTRAL (see "B" in llm/plan-in-browser-editor.md): dev does NOT do
// compile-time `replaceEnv` any more. Each realm sets the runtime `env` object
// at boot (client-main / server-worker / pipeline-worker), so env-gated branches
// read the right values at runtime — and nothing here depends on the realm, so
// ONE transform result is shared across all realms (no per-env cache; the engine
// is compiled once, not 3×). DCE still matters for the shipped bundle, so the
// publish BUILD keeps per-env `replaceEnv` (build.ts).
//
// The capture wrapper is the SAME contract the kit Vite plugin injects: push/pop
// bracket the body so registry upserts stamp the owning module; the self-accept
// runs __kit.reload → invalidate-or-flush.

import { moduleRunnerTransform, transform } from '@rolldown/browser/experimental';
import type { TransformResult } from '../../build';

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

export type TransformOptions = {
    /** inject the bongle capture wrapper — user project modules only, not the
     *  seeded lib source. */
    capture: boolean;
};

const TS = /\.(ts|tsx|mts|cts)$/;
const KNOWN_EXT = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;

/** Transform one module for a realm: env replacement → (capture wrapper) →
 *  TS-strip → module-runner rewrite. `id` is the module id (a vfs path). */
export async function transformModule(id: string, source: string, opts: TransformOptions): Promise<TransformResult> {
    // 1. capture wrapper (user modules only). No env replacement — see the header.
    let code = opts.capture ? PRELUDE + source + POSTLUDE : source;

    // oxc needs a filename with a known extension.
    const fname = KNOWN_EXT.test(id) ? id : `${id}.ts`;

    // 3. strip TS types (ts sources only; prebundled lib is already js).
    if (TS.test(fname)) {
        // lang must match the source: `.tsx` carries JSX, and forcing `ts`
        // parses `<div>` as a type/comparison → PARSE_ERROR. onlyRemoveTypeImports
        // is MANDATORY — otherwise oxc elides "unused" value imports, breaking
        // side-effect imports + the HMR graph.
        const lang = /\.tsx$/.test(fname) ? 'tsx' : 'ts';
        // biome-ignore lint/suspicious/noExplicitAny: rolldown experimental types are loose.
        const stripped = await transform(fname, code, { lang, typescript: { onlyRemoveTypeImports: true } } as any);
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
