/**
 * api/prefabs.ts, user-facing prefab API.
 *
 * usage:
 *   const PenguinScene = scene('penguin');
 *   const Penguin = prefab('penguin', {
 *       type: 'nodes',
 *       deps: [PenguinScene],
 *       fn: (ctx) => {
 *           for (const child of PenguinScene.node.children) {
 *               addChild(ctx.scene, cloneNode(child));
 *           }
 *       },
 *   });
 *
 *   // args is { schema, default }, default is required when args is set.
 *   // it's used: (1) when callers omit args, (2) for inspector pre-fill,
 *   // (3) for the asset-pipeline prefab preview tiles.
 *   const Mage = prefab('mage', {
 *       type: 'nodes',
 *       deps: [MageScene],
 *       args: {
 *           schema: prop.object({ color: prop.string() }),
 *           default: { color: 'red' },
 *       },
 *       fn(ctx, args) { ctx.scene.name = args.color }
 *   })
 *
 *   const penguin = createPrefab(ctx, Penguin)         // detached
 *   addChild(node, penguin)                            // attach explicitly
 *
 *   const mage = createPrefab(ctx, Mage)               // uses default { color: 'red' }
 *   const blueMage = createPrefab(ctx, Mage, { args: { color: 'blue' } })
 */

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

/* ── PrefabHandle ── */

/**
 * what a prefab produces when instantiated.
 *   - 'voxels', voxel content only (`fn` populates the empty `ctx.voxels` canvas)
 *   - 'nodes', node children only (`fn` attaches children under `ctx.scene`)
 *   - 'composite', both voxels and nodes
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
    /**
     * producer handles whose changes trigger re-instantiation in edit mode.
     * accepts anything with a DepGraph `dependency` stamp, scene, model,
     * block, trait, command, prefab handles, etc. usually injected by the
     * AST rewriter from identifiers the body closes over; list manually
     * for procedural cases the rewriter can't see.
     */
    deps?: ReadonlyArray<DepHandle>;
    /**
     * args schema + default value. `default` is required when present,
     * it's used for caller-omitted args, inspector pre-fill, and preview rendering.
     */
    args?: { schema: S; default: SchemaType<S> };
    fn?: (ctx: PrefabApplyContext<T>, args: SchemaType<S>) => void;
    /** authored anchor defaults, applied to the node createPrefab returns when the caller doesn't override. */
    node?: { realm?: Realm };
};

export const emptyArgsSchema = prop.object({});
export const noopApply = () => {};

/* ── createPrefab ── */

/**
 * create a **detached** prefab node, sets `node.prefab` with the given config
 * but does NOT attach it to the scene graph. attach explicitly with
 * `addChild(parent, node)`; instantiation happens on the next prefab tick.
 *
 * use `addChild` then read `node.children` after a tick to inspect the result.
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
    // caller's args win; otherwise use the def's default (deep-cloned so the
    // shared default object isn't mutated by per-instance edits).
    const args = opts?.args !== undefined ? opts.args : structuredClone(handle.def.args?.default as Args);
    node.prefab = createPrefabConfig(handle.id, { args });
    return node;
}
