import type { AssetMeta } from '../core/asset-meta';
import type { DepHandle } from '../core/capture/dep-graph';
import type { PrefabHandle } from '../core/registry';

export type { PrefabHandle } from '../core/registry';
export { prefab } from '../core/registry';

import type { PrefabApplyContext } from '../core/scene/prefab';
import type { Schema, SchemaType } from '../core/scene/prop/prop';
import type { Node, Realm } from '../core/scene/scene-tree';
import * as SceneTree from '../core/scene/scene-tree';
import { createPrefabConfig } from '../core/scene/scene-tree';
import type { ScriptContext } from '../core/scene/scripts';
import { prop } from './prop';

export type { PrefabApplyContext };

/**
 * what a prefab produces when instantiated: `'voxels'` populates `ctx.voxels`,
 * `'nodes'` attaches children under `ctx.scene`, `'composite'` does both.
 */
export type PrefabType = 'voxels' | 'nodes' | 'composite';

export type PrefabDef<Args = unknown> = {
    id: string;
    /** human-readable display name for editor UIs. always set,
     *  defaults to `id` when the author didn't supply one. */
    name: string;
    type: PrefabType;
    deps: ReadonlyArray<DepHandle>;
    argsSchema: Schema;
    /** default args value, used when callers omit args. `{}` when args isn't set. */
    defaultArgs: Args;
    node?: { realm?: Realm };
    apply: (ctx: PrefabApplyContext, args: Args) => void;
};

export type PrefabOptions<T extends PrefabType, S extends Schema> = AssetMeta & {
    /** what this prefab produces, voxels, nodes, or both. required. */
    type: T;
    /** producer handles whose changes trigger re-instantiation in edit mode. */
    deps?: ReadonlyArray<DepHandle>;
    /** args schema + default value; default is required when args is set. */
    args?: { schema: S; default: SchemaType<S> };
    fn?: (ctx: PrefabApplyContext<T>, args: SchemaType<S>) => void;
    /** authored anchor defaults, applied to the node createPrefab returns when the caller doesn't override. */
    node?: { realm?: Realm };
};

export const emptyArgsSchema = prop.object({});
export const noopApply = () => {};

/**
 * create a detached prefab node; attach explicitly with `addChild(parent, node)`.
 * instantiation happens on the next prefab tick.
 */
export function createPrefab<Args = unknown>(
    _ctx: ScriptContext,
    handle: PrefabHandle<Args>,
    opts?: {
        name?: string;
        args?: Args;
        /** override the prefab's authored anchor realm. cascade: opts.realm > def.node.realm > 'inherit'. */
        realm?: Realm;
    },
): Node {
    const realm = opts?.realm ?? handle.def.node?.realm ?? 'inherit';
    const node = SceneTree.createNode({
        name: opts?.name,
        realm,
    });
    // deep-clone the default so the shared default object isn't mutated by per-instance edits
    const args = opts?.args !== undefined ? opts.args : structuredClone(handle.def.args?.default as Args);
    node.prefab = createPrefabConfig(handle.id, { args });
    return node;
}
