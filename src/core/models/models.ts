import type { AssetMeta, ResolvedAssetMeta } from '../asset-meta';
import { createNode } from '../scene/scene-tree';
import type { ModelDef } from './handle';

export type ModelOptions = AssetMeta & {
    /**
     * source .gltf/.glb: a string path relative to project root, or a module-relative
     * `asset('./model.glb', import.meta.url)` ref so 3rd-party packs can ship gltf alongside their modules.
     */
    src: string;
};

/**
 * Empty base interface, augmented by the codegen'd registry barrel (`src/generated/models.ts`)
 * via declaration merging to map model ids to their precise handle types.
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

/**
 * Per-id placeholder handle used by `model()` when the user declares a model before codegen has
 * run for it. `_registerModelHandle` mutates this payload in place once codegen catches up,
 * preserving the user-held reference.
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
