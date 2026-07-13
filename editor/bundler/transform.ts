// In-browser transform: oxc TS-strip -> Vite module-runner (SSR) transform,
// both from @rolldown/browser's wasm build. Produces __vite_ssr_* code the
// ModuleRunner evaluates one module at a time.
//
// Every user module gets the bongle capture wrapper injected as a string
// BEFORE the SSR transform, so `import.meta.hot` / `import.meta.url` / the
// `bongle/internal` import all get rewritten into the module-runner form. The
// wrapper is the SAME contract the kit Vite plugin injects (kit/vite/plugin.ts):
// push/pop bracket the body so registry upserts stamp the owning module; the
// self-accept runs __kit.reload → invalidate-or-flush.

import { moduleRunnerTransform, transform } from '@rolldown/browser/experimental';

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

/** Transform one user module: inject the capture wrapper, strip TS, rewrite to
 *  module-runner form. `id` is the module id (a project-relative path). */
export async function transformUserModule(id: string, source: string): Promise<TransformResult> {
    const wrapped = PRELUDE + source + POSTLUDE;
    // oxc needs a filename with a known extension.
    const fname = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(id) ? id : `${id}.ts`;
    // Pass 1: strip TS types. onlyRemoveTypeImports is MANDATORY — otherwise oxc
    // elides "unused" value imports, breaking side-effect imports and the HMR
    // graph (a module imported only for its registration side effects).
    // biome-ignore lint/suspicious/noExplicitAny: rolldown experimental types are loose.
    const stripped = await transform(fname, wrapped, { lang: 'ts', typescript: { onlyRemoveTypeImports: true } } as any);
    if (stripped.errors?.length) {
        // biome-ignore lint/suspicious/noExplicitAny: error shape is loose.
        throw new Error(`[transform] ${id}: ${stripped.errors.map((e: any) => e.message).join('\n')}`);
    }
    // Pass 2: module-runner (SSR) rewrite: imports -> __vite_ssr_import__, etc.
    const r = await moduleRunnerTransform(fname, stripped.code, { sourcemap: false });
    if (r.errors?.length) {
        // biome-ignore lint/suspicious/noExplicitAny: error shape is loose.
        throw new Error(`[moduleRunnerTransform] ${id}: ${r.errors.map((e: any) => e.message).join('\n')}`);
    }
    return { code: r.code, deps: [...r.deps], dynamicDeps: [...r.dynamicDeps] };
}
