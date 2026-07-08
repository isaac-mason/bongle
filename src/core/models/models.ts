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
import { claimOwnership, get, registry, touch, upsert, upsertPlaceholder } from '../registry';
import { createNode } from '../scene/scene-tree';
import type { ModelHandle } from './handle';

/* ── types ── */

export type ModelOptions = {
    /** human-readable display name for editor UIs (inventory, picker).
     *  falls back to the string id when omitted. */
    name?: string;
    /**
     * source .gltf/.glb. either:
     *   - a string path relative to project root, or
     *   - a URL (typically `new URL('./model.glb', import.meta.url)`).
     *
     * the URL form lets 3rd-party packs ship gltf bundled alongside
     * their modules: vite statically rewrites the `new URL(...)` call
     * in client bundles, and the asset pipeline (running under bun)
     * resolves the `file://` URL via fileURLToPath to a disk path the
     * gltf loader can read.
     *
     * stored as a string at registration, URLs are normalized to
     * `.href` so downstream consumers (registry hashes, codegen, the
     * pipeline) only deal with one shape.
     */
    src: string | URL;
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

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

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
export function _registerModelHandle(id: string, handle: ModelHandle): void {
    const existing = get(registry.models, id);
    if (existing) {
        const target = existing as Mutable<ModelHandle>;
        target.src = handle.src;
        target.bin = handle.bin;
        target.scene = handle.scene;
        target.aabb = handle.aabb;
        target.nodes = handle.nodes;
        target.meshes = handle.meshes;
        target.animations = handle.animations;
        target.version = handle.version;
        touch(registry.models, id);
    } else {
        upsertPlaceholder(registry.models, id, handle);
    }
}

/**
 * Build a per-id placeholder handle. Used by `model()` when the user
 * declares a model before codegen has run for it, the placeholder sits
 * in the registry so the cli can discover the declaration (`.src` is
 * the cli's codegen input). `_registerModelHandle` mutates this payload
 * in place once codegen catches up, preserving the user-held reference. No
 * scene graph/tree dependencies.
 */
function createPlaceholderHandle(id: string, src: string, name: string): ModelHandle {
    return {
        modelId: id,
        name,
        dependency: { registry: 'models', id },
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
    const src = options.src instanceof URL ? options.src.href : options.src;
    const name = options.name ?? id;
    const existing = get(registry.models, id);
    if (existing) {
        // claim ownership, promotes from PLACEHOLDER_OWNER (barrel-first
        // boot) to this user module, adds id to module's pending set so
        // endModuleRun doesn't fire removed on this run, throws on
        // duplicate declaration from another file.
        claimOwnership(registry.models, id);
        // patch `src` when the user changed the source-string arg so the
        // cli pipeline picks up the new path on its next pass. `touch()`
        // re-hashes and fires `changed`, bumping `revision`.
        let dirty = false;
        if (existing.src !== src) {
            // Guard: don't overwrite a barrel-resolved src with an empty string.
            // The client build plugin strips `new URL('./model.glb', import.meta.url)`
            // to "" so Vite lib mode won't inline raw GLB files; the barrel's path
            // is the correct value and should be preserved.
            if (src !== '') (existing as Mutable<ModelHandle>).src = src;
            dirty = true;
        }
        if (existing.name !== name) {
            (existing as Mutable<ModelHandle>).name = name;
            dirty = true;
        }
        if (dirty) touch(registry.models, id);
        recordModel(id);
        return existing as never;
    }

    // no warning here, placeholder is the normal cold-start state. the
    // user-entry shim wipes `src/generated/models.ts` on every dev start
    // (schema-drift protection in `resetGeneratedBarrels`), so EVERY
    // declared model hits this path before the pipeline's first flush
    // populates the barrel. warning would fire on every cold boot for
    // every model in the project, which isn't actionable.
    const placeholder = createPlaceholderHandle(id, src, name);
    const handle = upsert(registry.models, id, placeholder);
    recordModel(id);
    return handle.payload as never;
}
