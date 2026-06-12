// editor/prefab-visuals.ts — ghost voxel rendering for prefab nodes.
//
// in edit mode, prefab nodes whose def produces voxels get a transient
// child node that shows a tinted ghost of the prefab's voxel data.
// the ghost updates whenever the source scene's resource version advances.
//
// ownership: this module owns the ghost entirely. prefab.ts has no
// rendering concern and is not modified.
//
// usage: import * as PrefabVisuals from './prefab-visuals'

import { quat, type Quat } from 'mathcat';
import { TransformTrait } from '../../builtins/transform';
import { VoxelModel, VoxelMeshTrait } from '../../builtins/voxel-mesh';
import { registry as kindRegistry } from '../../core/registry';
import { addChild, addTrait, createNode, destroyNode, getTrait, type Node, type Nodes } from '../../core/scene/nodes';
import { prefabHasVoxels } from '../../core/scene/prefab';
import type { NodesContext } from '../../core/scene/scripts';
import { markTransformDirty } from '../../builtins/transform';
import type { BlockRegistry } from '../../core/voxels/block-registry';
import { rotateVoxelsByQuat } from '../../core/voxels/voxel-rotate';

// ── sentinel name ─────────────────────────────────────────────────

const GHOST_NAME = '\0prefab-voxels';

// ── state ─────────────────────────────────────────────────────────

export type PrefabVisuals = {
    // maps each prefab node → cache key of the last bake.
    // key = `${generation}|${qx},${qy},${qz},${qw}` — the prefab's
    // generation counter is the source of truth for "content changed" (any
    // dep version bump rebuilds), and rotation invalidates the ghost since
    // voxels are pre-rotated into world axes.
    builtKeys: Map<Node, string>;
};

export function init(): PrefabVisuals {
    return { builtKeys: new Map() };
}

export function dispose(state: PrefabVisuals): void {
    state.builtKeys.clear();
}

// ── per-frame update ──────────────────────────────────────────────

export function update(
    state: PrefabVisuals,
    sg: Nodes,
    runtime: NodesContext,
    registry: BlockRegistry,
): void {
    if (sg.roomMode !== 'edit') return;

    for (const node of sg.nodes) {
        const config = node.prefab;

        // clean up: ghost child whose parent no longer wants voxels
        if (node.name === GHOST_NAME) {
            const parentConfig = node.parent?.prefab;
            const parentDef = parentConfig ? kindRegistry.prefabs.byId.get(parentConfig.prefabId)?.payload : null;
            if (!parentDef || !prefabHasVoxels(parentDef)) {
                destroyNode(sg, node);
            }
            continue;
        }

        if (!config) continue;
        const def = kindRegistry.prefabs.byId.get(config.prefabId)?.payload;
        if (!def || !prefabHasVoxels(def)) continue;

        const generation = node._prefabState?.generation ?? 0;
        const parentTransform = getTrait(node, TransformTrait);
        const q: Quat = parentTransform ? ([...parentTransform.quaternion] as Quat) : [0, 0, 0, 1];
        const builtKey = `${generation}|${q[0]},${q[1]},${q[2]},${q[3]}`;

        // find or create ghost child
        let ghost = node.children.find((c) => c.name === GHOST_NAME) ?? null;

        if (!ghost) {
            ghost = createNode({ name: GHOST_NAME, persist: false });
            addChild(node, ghost);
            addTrait(ghost, TransformTrait);
            addTrait(ghost, VoxelMeshTrait, { unlit: true });
            // force rebuild on creation
            state.builtKeys.delete(node);
        }

        if (state.builtKeys.get(node) === builtKey) continue;

        // read post-apply voxels cached on the prefab node by the runtime
        // tick (reconcilePrefabNode). reconcile runs before this in tick
        // order, so the cache is fresh on the same generation bump.
        const vmt = getTrait(ghost, VoxelMeshTrait);
        if (!vmt) continue;

        const prepared = node._prefabState?.voxels ?? null;

        if (!prepared) {
            vmt.model = null;
            state.builtKeys.set(node, builtKey);
            continue;
        }

        const rotated = rotateVoxelsByQuat(prepared, q, registry);

        const model = new VoxelModel(rotated);
        // voxels are pre-rotated (block-state aware) so they reflect the
        // exact stamp play mode will produce. but the ghost is a child of
        // the prefab node, so without cancelling, it inherits the parent's
        // rotation a second time → double-rotation. set ghost.localQuat =
        // inverse(parent.quat) so its world rotation under the parent is
        // identity, and origin=0 so vertices render at raw local coords +
        // parent.position. matches play mode (prefab.ts stamps rotated
        // voxels at +Math.round(t.position)).
        model.origin = [0, 0, 0];
        vmt.model = model;
        vmt.tint = [0.5, 0.6, 0.75, 0.4];

        const ghostT = getTrait(ghost, TransformTrait);
        if (ghostT) {
            quat.invert(ghostT.quaternion, q);
            markTransformDirty(ghostT);
        }

        state.builtKeys.set(node, builtKey);
    }
}
