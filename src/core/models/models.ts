// model registration, module-scope api for declaring gltf models.
//
// follows the same pattern as block() / tile(): called at module
// scope, returns a typed ModelHandle. parallels how tiles → atlas
// works (the atlas is downstream-derived state, not its own registry).
// `modelsRegistry` is the single source of truth, the user module that
// called `model('id', ...)` owns the entry, and the codegen barrel
// (`src/generated/models.ts`) mutates the payload in place via
// `_registerModelHandle` to populate the runtime fields (bin urls,
// scene, nodes, meshes, animations).
//
// `model('wizard', { src })` is opt-in (no filesystem auto-discovery)
// and declaration-merges via `ModelHandleMap` so the literal id arg
// returns the precise handle type when codegen has emitted the barrel.
//
// Ownership story
// ---------------
//   - user module owns the registry entry. driving rationale: when the
//     user deletes a `model('penguin', ...)` line, their module re-eval
//     should propagate as a registry `removed` event so the cli can GC
//     the sidecar + bin + barrel import, and the runtime can release
//     the resource. that only happens if the entry is owned by the
//     user module (passive removal walks `byModule[owner]`).
//   - barrel does NOT own. it only mutates existing payloads in place
//     and calls `touch()` so the registry fires `changed`. user code
//     refs (`const Wizard = model('wizard', ...)`) stay valid across
//     codegen swaps because the same payload object is mutated, never
//     replaced.
//   - if the barrel runs before any user `model()` call (cold start,
//     codegen output cached but no user-eval yet), it writes a
//     `PLACEHOLDER_OWNER`-owned entry via `upsertPlaceholder`. The
//     first user `model()` call promotes ownership via `claimOwnership`.

import type { AssetMeta, ResolvedAssetMeta } from '../asset-meta';
import { createNode } from '../scene/scene-tree';
import type { ModelDef } from './handle';

/* ── types ── */

export type ModelOptions = AssetMeta & {
    /**
     * source .gltf/.glb: either a string path relative to project root, or a
     * module-relative `asset('./model.glb', import.meta.url)` ref. The `asset()`
     * form lets 3rd-party packs ship gltf alongside their modules — it resolves
     * relative to the calling module wherever it's installed, and the pipeline
     * reads the resolved path.
     */
    src: string;
};

/**
 * Empty base interface, augmented by the codegen'd registry barrel
 * (`src/generated/models.ts`) via declaration merging to map model ids
 * to their precise handle types.
 *
 * @example codegen output:
 * ```ts
 * declare module 'bongle' {
 *     interface ModelHandleMap {
 *         wizard: typeof wizard;
 *         dragon: typeof dragon;
 *     }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by codegen
export interface ModelHandleMap {}

/* ── codegen-seeded registry ── */

/**
 * Build a per-id placeholder handle. Used by `model()` when the user
 * declares a model before codegen has run for it, the placeholder sits
 * in the registry so the cli can discover the declaration (`.src` is
 * the cli's codegen input). `_registerModelHandle` mutates this payload
 * in place once codegen catches up, preserving the user-held reference. No
 * scene graph/tree dependencies.
 */
export function createModelPlaceholderDef(id: string, src: string, meta: ResolvedAssetMeta): ModelDef {
    return {
        modelId: id,
        name: meta.name,
        tags: meta.tags,
        src,
        bin: { client: '', server: '' },
        scene: createNode({ name: `__placeholder_${id}__` }),
        aabb: [0, 0, 0, 0, 0, 0],
        nodes: {},
        meshes: {},
        animations: {},
        version: 0,
    };
}

/* ── registration ── */
