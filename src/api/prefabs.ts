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
 *               addChild(ctx.root, cloneNode(child));
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
 *       fn(ctx, args) { ctx.root.name = args.color }
 *   })
 *
 *   const penguin = createPrefab(ctx, Penguin)         // detached
 *   addChild(node, penguin)                            // attach explicitly
 *
 *   const mage = createPrefab(ctx, Mage)               // uses default { color: 'red' }
 *   const blueMage = createPrefab(ctx, Mage, { args: { color: 'blue' } })
 */

import { type DepHandle, setDeps } from '../core/capture/dep-graph';
import { recordPrefab } from '../core/capture/module-scope';
import { type PrefabDef as CapturedPrefabDef, registry, upsert } from '../core/registry';
import type { Node, Realm } from '../core/scene/nodes';
import * as Nodes from '../core/scene/nodes';
import { createPrefabConfig } from '../core/scene/nodes';
import type { PrefabApplyContext } from '../core/scene/prefab';
import type { Schema, SchemaType } from '../core/scene/prop/prop';
import type { ScriptContext } from '../core/scene/scripts';
import { prop } from './prop';

export type { PrefabApplyContext };

/* ── PrefabHandle ── */

/**
 * what a prefab produces when instantiated.
 *   - 'voxels', voxel content only (`fn` populates the empty `ctx.voxels` canvas)
 *   - 'nodes', node children only (`fn` attaches children under `ctx.root`)
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

export type PrefabHandle<Args = unknown> = {
    readonly id: string;
    /** human-readable display name for editor UIs. always set,
     *  defaults to `id` when the author didn't supply one. */
    readonly name: string;
    /** DepGraph dependency, see SceneHandle.dependency. */
    dependency: { registry: 'prefabs'; id: string };
    readonly type: PrefabType;
    readonly argsSchema: Schema;
    /** default args value, read by the editor for pre-fill, by the asset-pipeline for preview, and by `createPrefab` when caller omits args. */
    readonly defaultArgs: Args;
    readonly node: { realm?: Realm } | undefined;
    readonly __args: Args;
};

export type PrefabOptions<T extends PrefabType, S extends Schema> = {
    /** human-readable display name for editor UIs (prefab picker,
     *  inventory). falls back to the string id when omitted. */
    name?: string;
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

const emptyArgsSchema = prop.object({});
const noopApply = () => {};

/**
 * declare a prefab def at module scope.
 */
export function prefab<T extends PrefabType>(
    id: string,
    options: {
        type: T;
        deps?: ReadonlyArray<DepHandle>;
        node?: { realm?: Realm };
        fn?: (ctx: PrefabApplyContext<T>, args: Record<string, never>) => void;
    },
): PrefabHandle<Record<string, never>>;
export function prefab<T extends PrefabType, S extends Schema>(
    id: string,
    options: PrefabOptions<T, S>,
): PrefabHandle<SchemaType<S>>;
export function prefab<T extends PrefabType, S extends Schema>(
    id: string,
    options: PrefabOptions<T, S>,
): PrefabHandle<SchemaType<S>> {
    const type = options.type;
    const name = options.name ?? id;
    const deps = options.deps ?? [];
    const argsSchema = (options.args?.schema ?? emptyArgsSchema) as S;
    const defaultArgs = (options.args?.default ?? {}) as SchemaType<S>;
    const apply = options.fn ?? noopApply;
    const node = options.node;

    const def: CapturedPrefabDef = {
        id,
        name,
        type,
        deps,
        args: options.args ? { schema: argsSchema, default: defaultArgs } : undefined,
        node,
        apply: apply as (ctx: unknown, args: unknown) => void,
    };
    upsert(registry.prefabs, id, def);
    recordPrefab(id);
    // wire user-supplied deps into the DepGraph (replace semantics).
    // the AST wrap unions AST-detected deps on top via __addDeps/addDeps,
    // so wipe-and-rewire on re-eval stays correct: factory's setDeps
    // resets, then the wrap re-unions fresh AST-detected refs.
    setDeps(
        { registry: 'prefabs', id },
        deps.map((d) => d.dependency),
    );
    return {
        id,
        name,
        dependency: { registry: 'prefabs', id },
        type,
        argsSchema,
        defaultArgs,
        node,
        __args: null!,
    };
}

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
    const realm = opts?.realm ?? handle.node?.realm ?? 'inherit';
    const node = Nodes.createNode({
        name: opts?.name,
        realm,
    });
    // caller's args win; otherwise use the def's default (deep-cloned so the
    // shared default object isn't mutated by per-instance edits).
    const args = opts?.args !== undefined ? opts.args : structuredClone(handle.defaultArgs);
    node.prefab = createPrefabConfig(handle.id, { args });
    return node;
}
