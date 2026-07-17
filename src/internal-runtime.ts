/**
 * `__bongle`, the runtime namespace injected into bongle-generated code.
 *
 * Three injection sites:
 *   1. The dev-path transform (build/dev/transform.ts + cli/dev/plugin.ts) and
 *      the publish-build prelude (build/bundle/bundle.ts) bracket every user
 *      module. `push` / `pop` bracket the body so registry upserts stamp the
 *      right owning module; `reload` returns the patch-vs-invalidate verdict in
 *      the hot.accept callback; `deps` wraps prefab() / script() calls with
 *      AST-detected producer refs; `flush` schedules the drain.
 *   2. Codegen barrels (src/asset-pipeline/bake/{models,scenes,audio}.ts),
 *      `registerModel` / `registerScene` / `registerSound` stamp per-entry
 *      handles + payloads from the generated barrel files.
 *   3. Realm boot entries (cli/realms/* and editor/realms/*), `registerFlush`
 *      once at boot to wire `applyRegistryChanges` to the flush event; `flush`
 *      to kick the initial drain.
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

import { _registerScenePayload } from './api/scenes';
import { __addDeps } from './core/capture/dep-wrap';
import { registerFlushHandler, requestFlush } from './core/capture/flush';
import { __decideReload, __popModule, __pushModule } from './core/capture/module-scope';
import { _registerModelHandle } from './core/models/models';
import { _registerSoundHandle } from './core/sounds/sounds';

export const __bongle = {
    push: __pushModule,
    pop: __popModule,
    reload: __decideReload,
    deps: __addDeps,
    flush: requestFlush,
    registerFlush: registerFlushHandler,
    registerModel: _registerModelHandle,
    registerScene: _registerScenePayload,
    registerSound: _registerSoundHandle,
};
