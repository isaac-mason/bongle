import type { Quat } from 'math';
import { collapseTransformIntoChildren, getWorldPosition, getWorldQuaternion, TransformTrait } from '../../builtins/transform';
import { type PrefabDef, type PrefabType, registry } from '../registry';
import type { Resources } from '../resources';
import { SetBlockFlags } from '../voxels/block-flags';
import { rotateVoxelsByQuat } from '../voxels/voxel-rotate';
import { BLOCK_AIR, CHUNK_BITS, CHUNK_SIZE, createVoxels, setBlock, type Voxels } from '../voxels/voxels';
import {
    bumpNodeVersion,
    destroyNode,
    getTrait,
    type Node,
    type Realm,
    removeTrait,
    reorderChild,
    reparent,
    type SceneTree,
    setPrefab,
} from './scene-tree';
import { logScriptError } from './script-errors';

/** Runtime-only reconciliation output; not serialized, not replicated. */
export type PrefabState = {
    /** Post-apply voxels from the last reconciliation, used for ghost rendering. */
    voxels: Voxels | null;
    /** Bumped each time this prefab is (re)instantiated. */
    generation: number;
};

import type { SceneTreeContext } from './scripts';

function effectiveRealm(node: Node): Realm {
    let cur: Node | null = node;
    while (cur) {
        if (cur.realm !== 'inherit') return cur.realm;
        cur = cur.parent;
    }
    return 'shared';
}

export function prefabHasVoxels(def: PrefabDef): boolean {
    return def.type !== 'nodes';
}

export function prefabHasNodes(def: PrefabDef): boolean {
    return def.type !== 'voxels';
}

/** True once every version-bearing dep handle in def.deps has been populated (version > 0). */
function depsReady(def: PrefabDef): boolean {
    for (const dep of def.deps) {
        const v = (dep as { version?: number }).version;
        if (v === 0) return false;
    }
    return true;
}

/** Context passed to a prefab def's apply function. */
export type PrefabApplyContext<T extends PrefabType = PrefabType> = {
    /** Anchor node to populate; attach content via addChild, not addTrait. */
    scene: Node;
    /** Fresh empty voxel canvas for fn to populate; null when the def's type is 'nodes'. */
    voxels: T extends 'nodes' ? null : Voxels;
};

export function buildPrefabApplyContext(scene: Node, voxels: Voxels | null): PrefabApplyContext {
    return {
        scene,
        voxels,
    };
}

/** Pure: expands a prefab def and config into node, returning the post-apply voxels or null. */
export function expandPrefab(
    node: Node,
    _runtime: SceneTreeContext,
    blockRegistry: import('../voxels/block-registry').Blocks | null,
): Voxels | null {
    const config = node.prefab;
    if (!config) return null;
    const def = registry.prefabs.byId.get(config.prefabId);
    if (!def) return null;

    let voxels: Voxels | null = null;
    if (blockRegistry && prefabHasVoxels(def)) {
        voxels = createVoxels(blockRegistry);
    }

    // clone the default args and overlay the config's authored args
    const args = def.args ? { ...(structuredClone(def.args.default) as object), ...(config.args as object) } : config.args;

    try {
        def.apply(buildPrefabApplyContext(node, voxels), args);
    } catch (err) {
        logScriptError(`prefab '${def.id}'.apply @${node.id}`, err);
    }

    return voxels;
}

/** Ensures node's children match its current prefab config, restamping voxel content into the world in play mode. */
export function reconcilePrefabNode(
    sceneTree: SceneTree,
    node: Node,
    runtime: SceneTreeContext,
    worldVoxels: Voxels | null,
): void {
    const config = node.prefab!;
    const def = registry.prefabs.byId.get(config.prefabId);

    // destroy previous prefab-produced children
    const toDestroy = node.children.filter((c) => !c.persist);
    for (const child of toDestroy) {
        destroyNode(sceneTree, child);
    }

    // snapshot before expand so anything it attaches gets persist:false
    const beforeApply = new Set(node.children);

    const preparedVoxels = expandPrefab(node, runtime, worldVoxels?.registry ?? null);

    // children added during apply are prefab outputs; mark non-persistent for cleanup next tick
    for (const child of node.children) {
        if (!beforeApply.has(child)) child.persist = false;
    }

    // play mode only; edit mode uses the ghost visual from prefab-visuals.ts
    if (def && prefabHasVoxels(def) && worldVoxels && runtime.roomMode === 'play' && preparedVoxels) {
        const t = getTrait(node, TransformTrait);

        // anchor's world pose; local is wrong when the anchor has a transformed ancestor
        const wp = t ? getWorldPosition(t) : null;
        const wq = t ? getWorldQuaternion(t) : null;

        const ox = wp ? Math.round(wp[0]) : 0;
        const oy = wp ? Math.round(wp[1]) : 0;
        const oz = wp ? Math.round(wp[2]) : 0;
        const q: Quat = wq ? [wq[0], wq[1], wq[2], wq[3]] : [0, 0, 0, 1];

        const rotated = rotateVoxelsByQuat(preparedVoxels, q, worldVoxels.registry);

        for (const chunk of rotated.chunks.values()) {
            if (chunk.nonAirCount === 0) continue;
            for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                        const paletteIdx = chunk.data[(ly << (CHUNK_BITS + CHUNK_BITS)) | (lz << CHUNK_BITS) | lx]!;
                        const key = chunk.paletteKeys[paletteIdx];
                        if (!key || key === BLOCK_AIR) continue;
                        // BULK: settles block-def hooks inline but fires no script events per cell.
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

    const prevGeneration = sceneTree.prefabs.state.get(node)?.generation ?? 0;
    sceneTree.prefabs.state.set(node, {
        // Edit mode caches for ghost rendering; play mode already stamped into worldVoxels above.
        voxels: runtime.roomMode === 'edit' ? preparedVoxels : null,
        generation: prevGeneration + 1,
    });

    bumpNodeVersion(sceneTree, node);
}

const MAX_PREFAB_DEPTH = 16;

/** Walks up the parent chain looking for the same prefabId; also bails if the nesting depth exceeds MAX_PREFAB_DEPTH as a safety net. */
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

/** Splices `anchor`'s children into `anchor.parent` at the anchor's slot, then destroys the anchor, preserving sibling order. No-op for the room root or detached anchors. */
function dissolveAnchor(sceneTree: SceneTree, anchor: Node): void {
    const parent = anchor.parent;
    if (!parent) return;
    const anchorIdx = parent.children.indexOf(anchor);
    const childrenSnapshot = anchor.children.slice();
    for (const child of childrenSnapshot) {
        reparent(child, parent);
    }
    destroyNode(sceneTree, anchor);
    for (let i = 0; i < childrenSnapshot.length; i++) {
        reorderChild(parent, childrenSnapshot[i], anchorIdx + i);
    }
}

/** Ticks the prefab system for a room once per fixed timestep, after scripts have run. */
export function tick(
    sceneTree: SceneTree,
    runtime: SceneTreeContext,
    _resources: Resources,
    worldVoxels: Voxels | null,
    side: 'server' | 'client',
): void {
    // edit rooms bypass realm gating so the editor can render and mutate every node
    const isEdit = runtime.roomMode === 'edit';
    // snapshot since reconcilePrefabNode can destroy nested prefab outputs during iteration
    const work = Array.from(sceneTree.prefabs.dirty);

    for (const node of work) {
        if (node.scene !== sceneTree) continue;
        if (!node.prefab) {
            sceneTree.prefabs.dirty.delete(node);
            continue;
        }
        const def = registry.prefabs.byId.get(node.prefab.prefabId);
        if (!def) {
            sceneTree.prefabs.dirty.delete(node);
            continue;
        }
        if (!isEdit) {
            const effective = effectiveRealm(node);
            if (side === 'server' && effective === 'client') {
                sceneTree.prefabs.dirty.delete(node);
                continue;
            }
            if (side === 'client' && effective === 'server') {
                sceneTree.prefabs.dirty.delete(node);
                continue;
            }
        }
        if (!depsReady(def)) continue;
        if (hasPrefabCycle(node)) {
            console.warn(`[bongle] prefab cycle detected for "${node.prefab.prefabId}" — skipping`);
            sceneTree.prefabs.dirty.delete(node);
            continue;
        }
        reconcilePrefabNode(sceneTree, node, runtime, worldVoxels);
        sceneTree.prefabs.dirty.delete(node);

        // play-mode bake: sever the prefab link and dissolve the anchor so its children become top-level; edit mode keeps the live link for HMR
        if (!isEdit) {
            collapseTransformIntoChildren(node);
            removeTrait(node, TransformTrait);
            setPrefab(node, null);
            dissolveAnchor(sceneTree, node);
        }
    }
}
