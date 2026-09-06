// model registration, module-scope api for declaring gltf models.
//
// follows the same pattern as block() / blockTexture(): called at module
// scope, returns a typed ModelHandle. parallels how blockTextures → atlas
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

import { recordModel } from '../capture/module-scope';
import { declare, registry, touch, upsertPlaceholder } from '../registry';
import { createNode } from '../scene/scene-tree';
import type { ModelDef, ModelHandle } from './handle';

/* ── types ── */

export type ModelOptions = {
    /** human-readable display name for editor UIs (inventory, picker).
     *  falls back to the string id when omitted. */
    name?: string;
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
 * Called by the per-project barrel `src/generated/models.ts` at module-
 * eval to populate each handle's runtime fields. Barrel does not own
 * registry entries, see file header. Mutates the existing payload in
 * place so user code refs stay valid, then `touch()`es so consumers
 * (renderer, animator, prefab deps) react via the dispatch path.
 *
 * If no entry exists (cold start where the barrel ran before any user
 * `model()` call), the payload is registered under `PLACEHOLDER_OWNER`;
 * the first user `model()` call promotes ownership.
 *
 * Re-runs on every barrel re-import (hot reload). Pass through `touch`
 * is what bumps `revision` so the cli's flush handler picks up bin-url
 * changes for codegen.
 */
export function _registerModelDef(id: string, def: ModelDef): void {
    const handle = registry.models.handles.get(id);
    if (registry.models.byId.has(id)) {
        // codegen caught up with a declaration already in the registry: swap the def
        // wholesale and re-point the handle user code is holding.
        registry.models.byId.set(id, def);
        if (handle) handle.def = def;
        touch(registry.models, id);
        return;
    }
    upsertPlaceholder(registry.models, id, def);
    if (handle) handle.def = def;
}

/**
 * Build a per-id placeholder handle. Used by `model()` when the user
 * declares a model before codegen has run for it, the placeholder sits
 * in the registry so the cli can discover the declaration (`.src` is
 * the cli's codegen input). `_registerModelHandle` mutates this payload
 * in place once codegen catches up, preserving the user-held reference. No
 * scene graph/tree dependencies.
 */
function createPlaceholderDef(id: string, src: string, name: string): ModelDef {
    return {
        modelId: id,
        name,
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

/*#__NO_SIDE_EFFECTS__*/
/**
 * Declare a model. Called at module scope.
 *
 * Returns the codegen'd `ModelHandle` (typed via `ModelHandleMap` if the
 * cli has emitted the registry barrel yet, generic `ModelHandle` otherwise).
 *
 * ```ts
 * import { model } from 'bongle';
 * const wizard = model('wizard', { src: 'characters/wizard.glb' });
 * // wizard.scene, wizard.nodes.Body, wizard.meshes.Head, wizard.animations.idle
 * ```
 */
export function model<const Id extends string>(
    id: Id,
    options: ModelOptions,
): Id extends keyof ModelHandleMap ? ModelHandleMap[Id] : ModelHandle {
    const src = options.src;
    const name = options.name ?? id;
    // minting a placeholder is the normal cold-start path, not a warning case: the
    // user-entry shim wipes `src/generated/models.ts` on every dev start
    // (schema-drift protection in `resetGeneratedBarrels`), so EVERY declared model
    // hits it before the pipeline's first flush populates the barrel.
    const handle = declare(
        registry.models,
        id,
        // codegen owns everything but `src` / `name`, so merge onto whatever the
        // barrel already registered rather than replacing it.
        (previous): ModelDef => (previous ? { ...previous, src, name } : createPlaceholderDef(id, src, name)),
        (def): ModelHandle => ({
            id,
            dependency: { registry: 'models', id },
            def,
            // forwarding accessors; see the ModelHandle doc for why these are
            // getters rather than copied fields.
            get name() {
                return this.def.name;
            },
            get src() {
                return this.def.src;
            },
            get scene() {
                return this.def.scene;
            },
            get aabb() {
                return this.def.aabb;
            },
            get nodes() {
                return this.def.nodes;
            },
            get meshes() {
                return this.def.meshes;
            },
            get animations() {
                return this.def.animations;
            },
        }),
    );
    recordModel(id);
    return handle as never;
}
