import { type Quat, quat } from 'math';
import { markTransformDirty, TransformTrait } from '../../builtins/transform';
import { VoxelMeshTrait, VoxelModel } from '../../builtins/voxel-mesh';
import { registry as kindRegistry } from '../../core/registry';
import { prefabHasVoxels } from '../../core/scene/prefab';
import { addChild, addTrait, createNode, destroyNode, getTrait, type Node, type SceneTree } from '../../core/scene/scene-tree';
import type { SceneTreeContext } from '../../core/scene/scripts';
import type { Blocks } from '../../core/voxels/block-registry';
import { rotateVoxelsByQuat } from '../../core/voxels/voxel-rotate';

const GHOST_NAME = '\0prefab-voxels';

export type PrefabVisuals = {
    // maps each prefab node to the cache key of its last bake:
    // `${generation}|${qx},${qy},${qz},${qw}`. rotation is included since
    // voxels are pre-rotated into world axes.
    builtKeys: Map<Node, string>;
};

export function init(): PrefabVisuals {
    return { builtKeys: new Map() };
}

export function dispose(state: PrefabVisuals): void {
    state.builtKeys.clear();
}

export function update(state: PrefabVisuals, sceneTree: SceneTree, runtime: SceneTreeContext, registry: Blocks): void {
    if (runtime.roomMode !== 'edit') return;

    for (const node of sceneTree.nodes) {
        const config = node.prefab;

        // ghost child whose parent no longer wants voxels
        if (node.name === GHOST_NAME) {
            const parentConfig = node.parent?.prefab;
            const parentDef = parentConfig ? kindRegistry.prefabs.byId.get(parentConfig.prefabId) : null;
            if (!parentDef || !prefabHasVoxels(parentDef)) {
                destroyNode(sceneTree, node);
            }
            continue;
        }

        if (!config) continue;
        const def = kindRegistry.prefabs.byId.get(config.prefabId);
        if (!def || !prefabHasVoxels(def)) continue;

        const prefabState = node.scene?.prefabs.state.get(node);
        const generation = prefabState?.generation ?? 0;
        const parentTransform = getTrait(node, TransformTrait);
        const q: Quat = parentTransform ? ([...parentTransform.quaternion] as Quat) : [0, 0, 0, 1];
        const builtKey = `${generation}|${q[0]},${q[1]},${q[2]},${q[3]}`;

        let ghost = node.children.find((c) => c.name === GHOST_NAME) ?? null;

        if (!ghost) {
            ghost = createNode({ name: GHOST_NAME, persist: false });
            addChild(node, ghost);
            addTrait(ghost, TransformTrait);
            addTrait(ghost, VoxelMeshTrait, { unlit: true });
            state.builtKeys.delete(node);
        }

        if (state.builtKeys.get(node) === builtKey) continue;

        // reconcilePrefabNode runs before this in tick order and caches
        // post-apply voxels on the prefab node, so this read is fresh.
        const vmt = getTrait(ghost, VoxelMeshTrait);
        if (!vmt) continue;

        const prepared = prefabState?.voxels ?? null;

        if (!prepared) {
            vmt.model = null;
            state.builtKeys.set(node, builtKey);
            continue;
        }

        const rotated = rotateVoxelsByQuat(prepared, q, registry);

        const model = new VoxelModel(rotated);
        // voxels are pre-rotated, and the ghost is a child of the prefab
        // node, so its local quaternion is set to the inverse of the
        // parent's below to cancel the double rotation.
        model.origin = [0, 0, 0];
        vmt.model = model;
        vmt.flash = [0.5, 0.6, 0.75, 0.4];

        const ghostT = getTrait(ghost, TransformTrait);
        if (ghostT) {
            quat.invert(ghostT.quaternion, q);
            markTransformDirty(ghostT);
        }

        state.builtKeys.set(node, builtKey);
    }
}
