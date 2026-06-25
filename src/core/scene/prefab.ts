// core/scene/prefab.ts — prefab instantiation tick driver.
//
// called every tick for every room (server and client, edit and play).
// drains the `_prefabsDirty` set, reconciling each anchor by re-running its
// def's `apply`. dirty entries arrive from three sources:
//   - `registerSubtree` / `setPrefab` — first-time init + args/config edits
//   - `markPrefabAnchorsDirty` — DepGraph propagation from
//     `applyRegistryChanges*` (a dep producer changed, transitively reaches
//     this prefab id)
// no version comparisons here — membership in `_prefabsDirty` *is* the
// staleness signal. resource reads happen entirely through the dep handles
// closed over by `def.apply`.
//
// no server/client imports — same struct on both.

import type { Quat } from 'mathcat';
import { collapseTransformIntoChildren, getWorldPosition, getWorldQuaternion, TransformTrait } from '../../builtins/transform';
import { registry, type PrefabDef, type PrefabType } from '../registry';
import type { Resources } from '../resources';
import { rotateVoxelsByQuat } from '../voxels/voxel-rotate';
import { SetBlockFlags } from '../voxels/block-flags';
import { BLOCK_AIR, CHUNK_BITS, CHUNK_SIZE, createVoxels, setBlock, type Voxels } from '../voxels/voxels';
import {
    bumpNodeVersion,
    destroyNode,
    getTrait,
    removeTrait,
    reorderChild,
    reparent,
    setPrefab,
    type Node,
    type Nodes,
    type Realm,
} from './nodes';
import { logScriptError } from './script-errors';
import type { NodesContext } from './scripts';

/**
 * resolve a node's *effective* realm by walking up parent pointers until
 * a non-`'inherit'` ancestor is found. roots are explicitly `'shared'`,
 * so this terminates without a sentinel. cheap — typical chains are a
 * few links deep — and runs only over the tracked prefab set, not the
 * full tree.
 */
function effectiveRealm(node: Node): Realm {
    let cur: Node | null = node;
    while (cur) {
        if (cur.realm !== 'inherit') return cur.realm;
        cur = cur.parent;
    }
    return 'shared';
}

/* ── def → has voxels / has nodes ── */

/** does a prefab def produce voxel content? */
export function prefabHasVoxels(def: PrefabDef): boolean {
    return def.type !== 'nodes';
}

/** does a prefab def produce node children? */
export function prefabHasNodes(def: PrefabDef): boolean {
    return def.type !== 'voxels';
}

/* ── deps ready gate ── */

/**
 * are all of `def.deps` populated? handles start at `version: 0` with empty
 * content; the engine bumps to ≥1 once the resource arrives (codegen barrel
 * at boot, bongle:scene-update HMR event in dev). gating reconcile on this
 * lets `fn` assume every version-bearing dep handle has real content — no
 * null guards. nodes whose deps aren't ready stay in `_prefabsDirty`; the
 * dispatch flush that populates the dep also re-marks the anchor dirty,
 * giving the next tick another shot.
 *
 * also doubles as "this side won't ever populate this dep": e.g. a
 * `client: false` scene used in a prefab whose realm runs on the client
 * stays at version 0 forever, so apply just never fires there.
 *
 * versionless handles (blocks, traits, commands, …) carry no unpopulated
 * state — they're ready immediately and skip the gate.
 */
function depsReady(def: PrefabDef): boolean {
    for (const dep of def.deps) {
        const v = (dep as { version?: number }).version;
        if (v === 0) return false;
    }
    return true;
}

/* ── instantiate one prefab node ── */

function collectInstantiatedNodes(children: Node[]): Node[] {
    const out: Node[] = [];
    const stack = [...children];
    while (stack.length > 0) {
        const node = stack.pop()!;
        out.push(node);
        for (const child of node.children) {
            stack.push(child);
        }
    }
    return out;
}

/**
 * `voxels` field type tracks the prefab's `type`:
 *   - `type: 'voxels'` or `'composite'` → `voxels: Voxels` (fresh canvas)
 *   - `type: 'nodes'`                   → `voxels: null`
 * the default (no generic) widens to `Voxels | null` so engine internals
 * that don't know the prefab type still typecheck.
 */
export type PrefabApplyContext<T extends PrefabType = PrefabType> = {
    /**
     * the prefab anchor. by convention, `ctx.root` carries only identity
     * (uuid + scene-level transform + prefab config) — attach content as
     * children via `addChild(ctx.root, …)`, do NOT `addTrait(ctx.root, …)`.
     * children added here are marked `persist: false` automatically so the
     * destroy/re-instantiate cycle cleans them up.
     *
     * play-mode bake (after first successful expand): the anchor's
     * `TransformTrait` is collapsed into the first-encountered
     * `TransformTrait` in each child subtree, then removed from the anchor,
     * and `node.prefab` is nulled — the anchor becomes a transformless
     * container and no further reconcile fires. edit mode keeps the live
     * link for HMR.
     */
    root: Node;
    all: () => Node[];
    /**
     * fresh empty voxel canvas for `fn` to populate (for `type: 'voxels'`
     * or `'composite'`). null when the def's `type` is `'nodes'`.
     * after `fn` returns, voxels are stamped into the world (play mode)
     * or cached for the editor ghost (edit mode).
     */
    voxels: T extends 'nodes' ? null : Voxels;
};

export function buildPrefabApplyContext(root: Node, voxels: Voxels | null): PrefabApplyContext {
    // snapshot existing children before user fn runs — `all` reflects whatever
    // was there pre-fn. (today this is empty since reconcile tears down before
    // expand; kept for forward compat.)
    const snapshot = collectInstantiatedNodes(root.children);
    return {
        root,
        all: () => snapshot,
        voxels,
    };
}

/**
 * pure: expand a prefab def + config into `node`. allocates a fresh empty
 * voxel canvas (when applicable) and runs the def's `apply` once. returns
 * the post-apply voxels for voxel-bearing prefabs (for the world stamp +
 * editor ghost cache), or null otherwise.
 *
 * does NOT touch existing children, persist flags, _prefabState, or world
 * voxels — those are reconciliation concerns layered on top by
 * `reconcilePrefabNode`. callers that just need the content (the editor's
 * blueprint bake) call this directly.
 */
export function expandPrefab(
    node: Node,
    _runtime: NodesContext,
    blockRegistry: import('../voxels/block-registry').BlockRegistry | null,
): Voxels | null {
    const config = node.prefab;
    if (!config) return null;
    const def = registry.prefabs.byId.get(config.prefabId)?.payload;
    if (!def) return null;

    // fresh empty canvas for fn to populate. `fn` reads dep handles
    // (e.g. `MyScene.voxels`) and copies/transforms into this canvas.
    let voxels: Voxels | null = null;
    if (blockRegistry && prefabHasVoxels(def)) {
        voxels = createVoxels(blockRegistry);
    }

    // single def.apply call — fn does all the work
    try {
        def.apply(buildPrefabApplyContext(node, voxels), config.args);
    } catch (err) {
        logScriptError(`prefab '${def.id}'.apply @${node.id}`, err);
    }

    return voxels;
}

/**
 * runtime tick driver: ensure `node`'s children match its current prefab
 * config. tears down stale (non-persistent) children, expands the def fresh,
 * marks new children non-persistent so the next tick can clean them up, and
 * (in play mode) stamps voxel content into the world. idempotent — safe to
 * call repeatedly; only does work when the node is stale.
 */
export function reconcilePrefabNode(nodes: Nodes, node: Node, runtime: NodesContext, worldVoxels: Voxels | null): void {
    const config = node.prefab!;
    const def = registry.prefabs.byId.get(config.prefabId)?.payload;

    // destroy existing prefab children (non-persistent children we placed before)
    const toDestroy = node.children.filter((c) => !c.persist);
    for (const child of toDestroy) {
        destroyNode(nodes, child);
    }

    // snapshot before expand so anything it attaches gets persist:false
    const beforeApply = new Set(node.children);

    const preparedVoxels = expandPrefab(node, runtime, worldVoxels?.registry ?? null);

    // children added during apply are prefab outputs — mark non-persistent so
    // the next instantiation tick destroys them before re-running the fn.
    for (const child of node.children) {
        if (!beforeApply.has(child)) child.persist = false;
    }

    // stamp rotated voxels into the world.
    // only in play mode — edit mode uses the ghost visual from prefab-visuals.ts.
    if (def && prefabHasVoxels(def) && worldVoxels && nodes.roomMode === 'play' && preparedVoxels) {
        const t = getTrait(node, TransformTrait);

        // anchor's world pose — local is wrong when the anchor has a
        // transformed ancestor (the bake's collapseTransformIntoChildren
        // resolves children to world space, voxels must match).
        const wp = t ? getWorldPosition(t) : null;
        const wq = t ? getWorldQuaternion(t) : null;

        const ox = wp ? Math.round(wp[0]) : 0;
        const oy = wp ? Math.round(wp[1]) : 0;
        const oz = wp ? Math.round(wp[2]) : 0;
        const q: Quat = wq ? [wq[0], wq[1], wq[2], wq[3]] : [0, 0, 0, 1];

        const rotated = rotateVoxelsByQuat(preparedVoxels, q, worldVoxels.registry);

        for (const chunk of rotated.chunks.values()) {
            if (chunk.aggregate === 0) continue;
            for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                        const paletteIdx = chunk.data[(ly << (CHUNK_BITS + CHUNK_BITS)) | (lz << CHUNK_BITS) | lx]!;
                        const key = chunk.paletteKeys[paletteIdx];
                        if (!key || key === BLOCK_AIR) continue;
                        // BULK — prefab paste writes potentially thousands of cells;
                        // server end-of-tick runBlockEventHooks drains them in one pass.
                        setBlock(
                            worldVoxels,
                            chunk.wx + lx + ox,
                            chunk.wy + ly + oy,
                            chunk.wz + lz + oz,
                            key,
                            SetBlockFlags.BULK,
                        );
                    }
                }
            }
        }
    }

    const prevGeneration = node._prefabState?.generation ?? 0;
    node._prefabState = {
        // edit mode: cache for prefab-visuals ghost rendering. play mode:
        // already stamped into worldVoxels above, no need to retain.
        voxels: nodes.roomMode === 'edit' ? preparedVoxels : null,
        generation: prevGeneration + 1,
    };

    bumpNodeVersion(nodes, node);
}

/* ── cycle detection ── */

const MAX_PREFAB_DEPTH = 16;

/**
 * walk up the parent chain looking for the same prefabId. also bail
 * if the nesting depth exceeds MAX_PREFAB_DEPTH as a safety net.
 */
function hasPrefabCycle(node: Node): boolean {
    const config = node.prefab;
    if (!config) return false;

    let depth = 0;
    let current = node.parent;
    while (current) {
        if (current.prefab) {
            depth++;
            if (depth >= MAX_PREFAB_DEPTH) return true;
            if (current.prefab.prefabId === config.prefabId) return true;
        }
        current = current.parent;
    }
    return false;
}

/**
 * splice `anchor`'s children into `anchor.parent` at the anchor's slot,
 * then destroy the anchor. preserves sibling order. no-op for the room
 * root or detached anchors. used by the play-mode bake.
 */
function dissolveAnchor(sg: Nodes, anchor: Node): void {
    const parent = anchor.parent;
    if (!parent) return; // detached or root — leave it
    const anchorIdx = parent.children.indexOf(anchor);
    const childrenSnapshot = anchor.children.slice();
    for (const child of childrenSnapshot) {
        reparent(child, parent); // appends to parent.children
    }
    destroyNode(sg, anchor); // shrinks parent.children, frees the slot
    // anchor is gone; reposition the spliced children into anchorIdx..
    for (let i = 0; i < childrenSnapshot.length; i++) {
        reorderChild(parent, childrenSnapshot[i], anchorIdx + i);
    }
}

/* ── tick ── */

/**
 * tick the prefab system for a room. call once per fixed timestep tick,
 * after scripts have run. drains `_prefabsDirty` — handles first-time
 * init, args / config edits (via `setPrefab`), and edit-mode dep changes
 * (via `markPrefabAnchorsDirty` driven by the dispatch DepGraph) uniformly
 * on both server and client.
 *
 * worldVoxels is the room's live voxel state — needed to stamp prefab
 * voxels into the world when the def's `type` includes voxels. pass null
 * if the room has no voxels (shouldn't happen in practice).
 *
 * side: 'server' — process nodes that live on the server (`shared`, `server`, `each`)
 *       'client' — process nodes that live on the client (`shared`, `client`, `each`)
 *
 * `each` runs on both sides (independent copies), `shared` runs everywhere
 * (replicated copy), `server`/`client` run only on their respective side.
 */
export function tick(
    sg: Nodes,
    runtime: NodesContext,
    _resources: Resources,
    worldVoxels: Voxels | null,
    side: 'server' | 'client',
): void {
    // edit rooms bypass realm gating — the editor instantiates everything
    // regardless of where it would run at play time, so it can render and
    // mutate every node. play rooms still bake voxels even when an edit
    // Player is observing.
    //
    // both modes drain the same `_prefabsDirty` set. registerSubtree /
    // setPrefab feeds first-time + config edits; `markPrefabAnchorsDirty`
    // (driven by the dispatch DepGraph propagation) feeds dep-content
    // changes. steady state is empty in both modes → tick is O(churn).
    const isEdit = sg.roomMode === 'edit';
    // snapshot so we can mutate the dirty set during iteration —
    // reconcilePrefabNode destroys nested prefab outputs which can also be
    // anchors (nested prefabs), and the drain mutates `_prefabsDirty`.
    const work = Array.from(sg._prefabsDirty);

    for (const node of work) {
        // node may have been destroyed by an earlier iteration's reconcile
        // (nested-prefab teardown). detached nodes are already off the sets.
        if (node.scene !== sg) continue;
        if (!node.prefab) {
            sg._prefabsDirty.delete(node);
            continue;
        }
        const def = registry.prefabs.byId.get(node.prefab.prefabId)?.payload;
        if (!def) {
            sg._prefabsDirty.delete(node);
            continue;
        }
        // skip nodes not owned by this side (play mode only)
        if (!isEdit) {
            const effective = effectiveRealm(node);
            if (side === 'server' && effective === 'client') {
                sg._prefabsDirty.delete(node);
                continue;
            }
            if (side === 'client' && effective === 'server') {
                sg._prefabsDirty.delete(node);
                continue;
            }
        }
        // wait for deps to be populated — apply expects real content.
        // leave the node in the dirty set so we retry next tick.
        if (!depsReady(def)) continue;
        if (hasPrefabCycle(node)) {
            console.warn(`[bongle] prefab cycle detected for "${node.prefab.prefabId}" — skipping`);
            sg._prefabsDirty.delete(node);
            continue;
        }
        reconcilePrefabNode(sg, node, runtime, worldVoxels);
        sg._prefabsDirty.delete(node);

        // play-mode bake: sever the prefab link, collapse the anchor's
        // transform into its children's first TransformTrait, then dissolve
        // the anchor — splice its children into its parent's slot and
        // destroy it. spawned bodies become top-level (no perma parent
        // matmul; top-level interpolation branch handles prediction blend)
        // and the anchor leaves no trace in the live tree. both sides bake
        // deterministically from the same initial state, so this stays
        // local — no replication. edit mode keeps the live link for HMR.
        if (!isEdit) {
            collapseTransformIntoChildren(node);
            removeTrait(node, TransformTrait);
            setPrefab(node, null);
            dissolveAnchor(sg, node);
        }
    }
}
