// build/transform.ts — host-neutral module transform for the dev path.
//
//   1. capture wrapper — bongle push/pop + self-accept, for USER project modules
//      only (NOT the seeded lib source — it imports bongle/internal as itself and
//      doesn't need per-module HMR ownership).
//   2. oxc TS-strip (ts/tsx sources only).
//   3. moduleRunnerTransform (SSR rewrite) — the form the ModuleRunner evals.
//
// The oxc `transform` + `moduleRunnerTransform` are INJECTED: the browser editor
// wires `@rolldown/browser/experimental`, `bongle dev` wires `rolldown/experimental`
// — identical API, DOM-free logic, so this runs in both with ZERO fork.
//
// ENV-NEUTRAL: dev does NOT do compile-time `replaceEnv`. Each realm sets the
// runtime `env` object at boot, so ONE transform result is shared across all realms
// (no per-env cache; the engine is compiled once, not 3×). The publish BUILD keeps
// per-env `replaceEnv` (bundle.ts) since DCE still matters for the shipped bundle.
//
// The capture wrapper is the SAME contract the kit Vite plugin injects: push/pop
// bracket the body so registry upserts stamp the owning module; the self-accept
// runs __kit.reload → invalidate-or-flush.

import type { TransformModule, TransformResult } from './dev-server';

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

const TS = /\.(ts|tsx|mts|cts)$/;
const KNOWN_EXT = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;

/** the injected oxc/rolldown transforms — `@rolldown/browser/experimental` or
 *  node `rolldown/experimental`; the same two functions in both. */
export type OxcTransforms = {
    transform: (filename: string, code: string, options: unknown) => Promise<{ code: string; errors?: { message: string }[] }>;
    moduleRunnerTransform: (
        filename: string,
        code: string,
        options: { sourcemap: boolean },
    ) => Promise<{ code: string; deps: Iterable<string>; dynamicDeps: Iterable<string>; errors?: { message: string }[] }>;
};

/** build a `TransformModule` over the injected oxc/rolldown transforms. */
export function createTransformModule({ transform, moduleRunnerTransform }: OxcTransforms): TransformModule {
    return async function transformModule(id, source, opts): Promise<TransformResult> {
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
            const stripped = await transform(fname, code, { lang, typescript: { onlyRemoveTypeImports: true } });
            if (stripped.errors?.length) {
                throw new Error(`[transform] ${id}: ${stripped.errors.map((e) => e.message).join('\n')}`);
            }
            code = stripped.code;
        }

        // 4. module-runner (SSR) rewrite: imports → __vite_ssr_import__, etc.
        const r = await moduleRunnerTransform(fname, code, { sourcemap: false });
        if (r.errors?.length) {
            throw new Error(`[moduleRunnerTransform] ${id}: ${r.errors.map((e) => e.message).join('\n')}`);
        }
        return { code: r.code, deps: [...r.deps], dynamicDeps: [...r.dynamicDeps] };
    };
}
