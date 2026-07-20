/**
 * `__bongle`, the runtime namespace injected into bongle-generated code.
 *
 * Two injection sites:
 *   1. The dev-path transform (build/dev/transform.ts + cli/dev/plugin.ts)
 *      brackets every user module. `push` / `pop` bracket the body so registry
 *      upserts stamp the right owning module; `reload` returns the
 *      patch-vs-invalidate verdict in the hot.accept callback; `deps` wraps
 *      prefab() / script() calls with AST-detected producer refs; `flush`
 *      schedules the drain.
 *   2. Realm boot entries (cli/realms/* and editor/realms/*), `registerFlush`
 *      once at boot to wire `applyRegistryChanges` to the flush event; `flush`
 *      to kick the initial drain.
 *
 * The codegen barrels (src/asset-pipeline/bake/{models,scenes,audio}.ts) do NOT
 * go through here: they import `registerModel` / `registerScene` / `registerSound`
 * from `bongle/internal` directly (real imports, tree-shakeable, no free var).
 *
 * This is a single object (not a namespace import) so the transform can inject
 * one identifier per file. User code can't shadow it because the leading `__`
 * flags it as engine-internal.
 *
 * The engine-side SDK exports (typed registry instances, types,
 * buildBlockRegistry, model-bin codec, detached-node primitives) live on
 * `bongle/internal` directly, they're consumed by hand-authored tooling
 * (asset-pipeline, CLI), not by generated/injected code, so the namespace
 * layer would just be noise.
 */

import { __addDeps } from './core/capture/dep-wrap';
import { registerFlushHandler, requestFlush } from './core/capture/flush';
import { __decideReload, __popModule, __pushModule } from './core/capture/module-scope';

export const __bongle = {
    push: __pushModule,
    pop: __popModule,
    reload: __decideReload,
    deps: __addDeps,
    flush: requestFlush,
    registerFlush: registerFlushHandler,
};
