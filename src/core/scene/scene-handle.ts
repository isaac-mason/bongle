// scene handle, runtime representation of a scene resource.
//
// `scene('penguin')` declares a scene as authored content and returns
// a stable handle. the handle's `node`, `voxels`, and `version` fields are
// mutated in place by the engine when the authored payload arrives, at
// boot via the codegen `src/generated/scenes.ts` barrel, and live via the
// the `bongle:scenes` HMR events (dev only). user code holds
// the handle reference permanently and reads through it; reference identity
// is stable for the lifetime of the module.
//
// `cloneVoxels(handle.voxels)` to get a writable copy. clone children of
// `handle.node` with `cloneNode()` before attaching them anywhere.

import type { DepKey } from '../capture/dep-graph';
import type { ScenePayload } from '../content/scene-store';
import type { Voxels } from '../voxels/voxels';
import { createNode, type Node, type SerializedNode } from './scene-tree';

/** scene id used as the default landing scene at boot and as the fallback
 *  for editor commands that take an optional sceneId arg. */
export const DEFAULT_SCENE_ID = 'main';

/**
 * On-demand: the DepKeys of every prefab a scene payload embeds (a node
 * carrying `prefab: { prefabId }`). This is deliberately NOT wired into the
 * scenes registry store's `extractDeps`, scenes need no dep edges at runtime
 * (embedded prefab anchors re-tick at the instance level via
 * `markPrefabAnchorsDirty`), and an always-on extractor would fire redundant
 * `scene changed` dispatch on every embedded-prefab edit. Callers that DO want
 * a scene's prefab dependencies, the offline icon pipeline deciding which
 * icons a prefab edit invalidates, call this explicitly, so unused paths pay
 * nothing.
 *
 * Prefab nodes own no serialized children (serializeNode drops them), so the
 * walk just collects ids down the authored tree.
 */
export function extractScenePrefabDeps(payload: ScenePayload): DepKey[] {
    const out: DepKey[] = [];
    const seen = new Set<string>();
    const walk = (node: SerializedNode): void => {
        const prefabId = node.prefab?.prefabId;
        if (prefabId && !seen.has(prefabId)) {
            seen.add(prefabId);
            out.push({ registry: 'prefabs', id: prefabId });
        }
        for (const child of node.children) walk(child);
    };
    walk(payload.nodes.root);
    return out;
}

export type SceneOptions = {
    /** human-readable display name for editor UIs. falls back to the
     *  string id when omitted. purely cosmetic, IDs remain the lookup
     *  key everywhere else. */
    name?: string;
    /** push to clients. default: true. set false for server-only scenes (navmeshes, AI lookups). */
    client?: boolean;
    /** load on server. default: true. set false for client-only scenes. */
    server?: boolean;
};

export type SceneHandle = {
    readonly id: string;
    /** human-readable display name for editor UIs. always set,
     *  defaults to `id` when the author didn't supply one. */
    name: string;
    /**
     * DepGraph dependency, `{ registry: 'scenes', id }`. Consumed by
     * the unified `deps:` API on `prefab()` / `script()`: any handle in
     * that array contributes a DepGraph edge keyed off `dependency`. Stamped
     * by `createSceneHandle`; never mutated.
     */
    dependency: { registry: 'scenes'; id: string };
    /** does this scene reach the client? */
    readonly client: boolean;
    /** does this scene get loaded on the server? */
    readonly server: boolean;
    /**
     * deserialized root node. mutated in place on hot reload.
     * empty placeholder until the engine populates it.
     * clone children with `cloneNode()` before attaching.
     */
    node: Node;
    /**
     * deserialized voxels. mutated in place on hot reload.
     * null if the scene has no voxels file, or until the engine populates it.
     * call `cloneVoxels(handle.voxels)` for a writable copy.
     */
    voxels: Voxels | null;
    /**
     * monotonic counter bumped every time this scene reloads.
     * starts at 0; first populate bumps to 1.
     */
    version: number;
    /**
     * authored payload (parsed `.scene.json`, nodes + optional chunks).
     * stamped by `scene()` from the codegen barrel's `_registerScenePayload`
     * write. engine `load()` reads this to seed `node`/`voxels` via
     * `populateScene` on both sides. live HMR updates and registry-dispatch
     * scene branches rewrite this field then re-`populateScene`. null when
     * the scene is declared but no file is on disk yet.
     */
    _payload: ScenePayload | null;
};

/**
 * create a fresh empty handle. the engine populates `node`/`voxels` and
 * bumps `version` once the scene is loaded (or arrives from the server).
 *
 * caller owns capture/registration, this just shapes the object.
 */
export function createSceneHandle(id: string, options?: SceneOptions): SceneHandle {
    return {
        id,
        name: options?.name ?? id,
        dependency: { registry: 'scenes', id },
        client: options?.client !== false,
        server: options?.server !== false,
        node: createNode({ name: `__scene_handle:${id}` }),
        voxels: null,
        version: 0,
        _payload: null,
    };
}
