/**
 * __kit — runtime namespace injected into kit-generated code.
 *
 * Three injection sites:
 *   1. Vite transform (kit/vite/plugin.ts) — prelude/postlude of every
 *      user file. `push` / `pop` bracket the body so registry upserts stamp
 *      the right owning module; `reload` returns the patch-vs-invalidate
 *      verdict in the hot.accept callback; `deps` wraps prefab() / script()
 *      calls with AST-detected producer refs; `flush` schedules the drain.
 *   2. Codegen barrels (kit/asset-pipeline/{models,scenes}.ts) —
 *      `registerModel` / `registerScene` stamp per-entry handles + payloads
 *      from the generated barrel files.
 *   3. Boot entries (kit/runtime/*.ts, served via kit/vite/virtual-entries.ts)
 *      — `registerFlush` once at boot to wire `applyRegistryChanges` to
 *      the flush event; `flush` to kick the initial drain.
 *
 * This is a single object (not a namespace import) so the kit transform
 * can inject one identifier per file. User code can't shadow it because
 * the leading `__` flags it as engine-internal.
 *
 * The engine-side SDK exports (typed registry instances, types,
 * buildBlockRegistry, model-bin codec, detached-node primitives) live on
 * `bongle/internal` directly — they're consumed by hand-authored tooling
 * (asset-pipeline, CLI), not by generated/injected code, so the namespace
 * layer would just be noise.
 */

import { __addDeps } from './core/capture/dep-wrap';
import { registerFlushHandler, requestFlush } from './core/capture/flush';
import { __decideReload, __popModule, __pushModule } from './core/capture/module-scope';
import { _registerModelHandle } from './core/models/models';
import { _registerScenePayload } from './api/scenes';
import { _registerSoundHandle } from './core/sounds/sounds';

export const __kit = {
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
