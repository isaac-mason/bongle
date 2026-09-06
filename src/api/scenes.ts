// api/scenes.ts, user-facing scene resource api.
//
// `scene('penguin')` declares a scene resource at module scope. returns a
// stable `SceneHandle` whose `node`/`voxels`/`version` fields are mutated
// in place by the engine when the scene loads or reloads. user code holds
// the handle reference permanently and reads through it; closures over
// `EnemyScene.node` are valid forever, readers compare `version` to detect
// change.
//
// scene options control which side(s) load the resource:
//   scene('penguin')                          // both sides (default)
//   scene('navmesh', { client: false })       // server-only
//   scene('hud_overlay', { server: false })   // client-only
//
// the file is read on the server when `server: true`; the server pushes
// the scene to clients when `client: true`. on the side that doesn't load
// the scene, the handle stays empty (`version: 0`, empty node, null voxels).

import { recordScene } from '../core/capture/module-scope';
import type { ScenePayload } from '../core/content/scene-store';
import { declare, get, registry, touch, upsertPlaceholder } from '../core/registry';
import {
    createSceneDef,
    createSceneHandle,
    type SceneDef,
    type SceneHandle,
    type SceneOptions,
} from '../core/scene/scene-handle';

export { cloneVoxels, copyVoxels } from '../core/voxels/voxels';
export type { SceneHandle, SceneOptions };

/**
 * declare a scene resource at module scope. returns a stable handle whose
 * fields the engine populates once the scene is loaded (or arrives from the
 * server). reference identity is permanent for the lifetime of this module
 * load, closures over `handle.node` survive any number of hot reloads.
 *
 * idempotent within a single module load: a second `scene('id', ...)` call
 * returns the same handle (options on later calls are ignored, declare the
 * options on the first call).
 *
 * @example
 * ```ts
 * const PenguinScene = scene('penguin');
 * const Navmesh = scene('navmesh', { client: false });
 *
 * // read directly:
 * const blocks = PenguinScene.voxels;
 * const nodes = PenguinScene.node.children;
 *
 * // observe changes:
 * onTick(ctx, () => {
 *     if (PenguinScene.version > lastSeen) {
 *         lastSeen = PenguinScene.version;
 *         // rebuild whatever depends on it
 *     }
 * });
 * ```
 */
export function scene(id: string, options?: SceneOptions): SceneHandle {
    // identity-stable: the handle is referenced by user code across hot
    // reloads, so we keep the same object and let the engine mutate its
    // fields in place. only first call decides `options` for client/server
    // (those affect transport routing, flipping them mid-session would
    // require a reload anyway). `name` is patched in place so authors
    // can rename without restarting.
    const handle = declare(
        registry.scenes,
        id,
        // only the first call decides client/server (they affect transport routing;
        // flipping them mid-session needs a reload anyway). `name` follows the latest
        // declaration so authors can rename without restarting, and `_payload` is
        // owned by the codegen barrel, so both ride the previous def.
        (previous): SceneDef => (previous ? { ...previous, name: options?.name ?? id } : createSceneDef(id, options)),
        createSceneHandle,
    );
    recordScene(id);
    return handle;
}

/* ── codegen barrel surface ─────────────────────────────────────────── */

/**
 * called at module-eval by the per-project codegen barrel
 * `src/generated/scenes.ts` (one call per discovered scene file).
 *
 *   - existing handle → mutate `_payload` in place so user-held refs stay
 *     valid.
 *   - no handle yet → register one under `PLACEHOLDER_OWNER` so it's
 *     visible through `registry.scenes` (icon renderer, editor inventory).
 *     If the user later declares the id via `scene()`, `claimOwnership`
 *     promotes the placeholder to the user module. Edit mode's filesystem
 *     walk surfaces every `.scene.json` (including blueprints), so many
 *     ids never get a user-side `scene()` and stay as placeholders, fine.
 *
 * Exposed via `bongle/internal`.
 */
export function _registerScenePayload(id: string, payload: ScenePayload): void {
    const existing = get(registry.scenes, id);
    if (existing) {
        existing._payload = payload;
        // sceneHash covers `_payload`, so touch detects the hash change
        // and fires a `changed` event. registry-dispatch's scenes branch
        // then runs `Content.populateScene`, bumping `SceneHandle.version`
        // so prefab deps unblock. Without this, a barrel re-eval that
        // arrives after `EngineServer.load()` (asset-pipeline regenerates
        // the codegen file → HMR re-imports) silently stamps `_payload`
        // and never triggers populate, leaving prefabs deferring forever.
        touch(registry.scenes, id);
        return;
    }
    const def = createSceneDef(id);
    def._payload = payload;
    upsertPlaceholder(registry.scenes, id, def);
    // no handle yet: `scene()` mints one against this def when user code declares it.
}
