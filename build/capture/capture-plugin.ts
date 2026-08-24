// build/capture/capture-plugin.ts — the DepGraph capture pass as a shakeup `transform` plugin.
//
// Brackets every USER-src module with the __bongle capture runtime (rung 1) AND runs the dep-wrap
// (rung 2, `capture-native.ts`) inside shakeup's dev-server pipeline:
//   - rung 1 (PRELUDE/POSTLUDE): import `__bongle` (so shakeup's transform binds every `__bongle`
//     reference to the linked `bongle/internal` namespace), push/pop the module on the capture
//     stack, and self-accept via `import.meta.hot` (shakeup provides it → auto-detected selfAccept).
//   - rung 2: inject `__bongle.deps(...)` around prefab()/script() consumers, passing the producer
//     refs their bodies close over as thunks. Which refs are really producers is settled at runtime
//     by `__addDeps`, so the wrap is per-module and order-independent (see capture-native.ts).

import type { Plugin, PluginCtx } from 'shakeup';
import { wrapModuleDeps } from './capture-native';

/** The capture module bracket, shared verbatim with the node CLI plugin (cli/dev/plugin.ts) so the
 *  runtime contract can't drift. Format-agnostic (plain ESM + standard `import.meta.hot`), so it runs
 *  unchanged under both shakeup's runner and Vite's ModuleRunner. */
export const CAPTURE_PRELUDE = `import { __bongle } from 'bongle/internal';
const __bongle_prev = __bongle.push(import.meta.url);
`;

export const CAPTURE_POSTLUDE = `
;__bongle.pop(__bongle_prev);
if (import.meta.hot) {
  import.meta.hot.accept((__bongle_next) => {
    if (__bongle.reload(import.meta.url, __bongle_next) === 'invalidate') {
      import.meta.hot.invalidate();
    }
    __bongle.flush();
  });
}
`;

export type CapturePluginOptions = {
    /** Restrict capture to user project modules (seeded lib / node_modules skip it). Default: all. */
    isUserModule?: (id: string) => boolean;
};

export function capturePlugin(options: CapturePluginOptions = {}): Plugin {
    const isUserModule = options.isUserModule ?? (() => true);
    return {
        name: 'bongle:capture',
        transform: (_ctx: PluginCtx, code: string, id: string) => {
            if (!isUserModule(id)) return null;
            // rung 2 (dep-wrap) inside the rung-1 bracket. wrapModuleDeps swallows a parse error
            // (returns code unchanged); the bracket is still applied so `__bongle` resolves and the
            // syntax error surfaces cleanly downstream.
            return CAPTURE_PRELUDE + wrapModuleDeps(id, code) + CAPTURE_POSTLUDE;
        },
    };
}
