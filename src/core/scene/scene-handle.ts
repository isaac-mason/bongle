import { type AssetMeta, resolveAssetMeta } from '../asset-meta';
import type { DepKey } from '../capture/dep-graph';
import type { ScenePayload } from '../content/scene-store';
import type { Voxels } from '../voxels/voxels';
import { createNode, type Node, type SerializedNode } from './scene-tree';

/** Scene id used as the default landing scene at boot and as the fallback for editor commands that take an optional sceneId arg. */
export const DEFAULT_SCENE_ID = 'main';

/**
 * On-demand: the DepKeys of every prefab a scene payload embeds. Deliberately not wired
 * into the scenes registry store's `extractDeps`, since scenes need no dep edges at runtime
 * and an always-on extractor would fire redundant dispatch on every embedded-prefab edit.
 * Callers that want a scene's prefab dependencies (e.g. the offline icon pipeline deciding
 * which icons a prefab edit invalidates) call this explicitly.
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

export type SceneOptions = AssetMeta & {
    /** Push to clients. Default true; set false for server-only scenes (navmeshes, AI lookups). */
    client?: boolean;
    /** Load on server. Default true; set false for client-only scenes. */
    server?: boolean;
};

/** The declared and authored data for one scene. Pure data: hashed for change detection, swapped wholesale on re-declaration. */
export type SceneDef = {
    readonly id: string;
    /** Display name for editor UIs; defaults to `id` when the author didn't supply one. */
    name: string;
    /** Search words for editor UIs, normalised. */
    tags: readonly string[];
    readonly client: boolean;
    readonly server: boolean;
    /** Authored payload; engine `load()` reads this to seed `node`/`voxels`. Null when the scene is declared but no file is on disk yet. */
    _payload: ScenePayload | null;
};

/**
 * Stable wrapper around a `SceneDef`. Beyond identity and the live def, it also carries
 * the engine-populated runtime state: the deserialized node tree and voxels. Those aren't
 * declared data, so they live here rather than on the def, which is re-pointed on
 * re-declaration.
 */
export type SceneHandle = {
    readonly id: string;
    /** DepGraph dependency. Consumed by the unified `deps:` API on `prefab()`/`script()`. Stamped by `createSceneHandle`; never mutated. */
    dependency: { registry: 'scenes'; id: string };
    /** The declared data; re-pointed on every re-declaration. */
    def: SceneDef;
    /** Deserialized root node, mutated in place on hot reload. Clone children with `cloneNode()` before attaching. */
    node: Node;
    /** Deserialized voxels, mutated in place on hot reload. Call `cloneVoxels(handle.voxels)` for a writable copy. */
    voxels: Voxels | null;
    /** Monotonic counter bumped every time this scene reloads; starts at 0, first populate bumps to 1. */
    version: number;
};

/** Creates a fresh empty handle. The engine populates `node`/`voxels` and bumps `version` once the scene is loaded. Caller owns capture/registration; this just shapes the object. */
export function createSceneDef(id: string, options?: SceneOptions): SceneDef {
    return {
        id,
        ...resolveAssetMeta(id, options),
        client: options?.client !== false,
        server: options?.server !== false,
        _payload: null,
    };
}

/** The empty container for `id`. `node`, `voxels` and `version` are filled in by `Content.populateScene` off the def's `_payload`, established once here and never rewritten by a re-declaration. */
export function createSceneHandle(id: string): Omit<SceneHandle, 'def'> {
    return {
        id,
        dependency: { registry: 'scenes', id },
        node: createNode({ name: `__scene_handle:${id}` }),
        voxels: null,
        version: 0,
    };
}
