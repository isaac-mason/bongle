import type { Box3 } from 'math/shapes';
import { MeshTrait } from '../../builtins/mesh';
import { TransformTrait } from '../../builtins/transform';
import { addChild, addTrait, createNode, type Node } from '../scene/scene-tree';
import type { ClipDef, MeshId, ModelDef } from './handle';
import type { Model, ModelNode } from './model';

/** TRS within `TRS_EPS` of identity, gltf bake noise absorbs the slack. */
const TRS_EPS = 1e-6;

/**
 * Hydrates `def` from `model` in place: writes node tree, flat node index, mesh ref index, clip
 * ref index, root-local AABB, and bumps `def.version`. Fresh `Node` objects are created each call,
 * identity isn't preserved across re-hydration.
 */
export function hydrateRuntimeHandle(def: ModelDef, model: Model): void {
    const modelId = def.modelId;

    // any ModelNode that's a target of at least one channel; gates TransformTrait stamping on identity non-mesh nodes
    const animated = new Set<ModelNode>();
    for (const clip of model.clipsByName.values()) {
        for (const ch of clip.channels) animated.add(ch.target);
    }

    // parallel ModelNode -> Node map so addChild() can wire parents while walking the runtime tree in DFS
    const nodeByModel = new Map<ModelNode, Node>();
    const nameIndex: Record<string, Node> = {};

    const visit = (mn: ModelNode, parent: Node | null): void => {
        const node = createNode({ name: mn.name });

        if (mn.mesh !== null || animated.has(mn) || !isIdentityTRS(mn)) {
            addTrait(node, TransformTrait, {
                position: [mn.position[0], mn.position[1], mn.position[2]],
                quaternion: [mn.quaternion[0], mn.quaternion[1], mn.quaternion[2], mn.quaternion[3]],
                scale: [mn.scale[0], mn.scale[1], mn.scale[2]],
            });
        }

        if (mn.mesh !== null) {
            const meshId: MeshId = { modelId, meshName: mn.mesh.name };
            addTrait(node, MeshTrait, { meshId });
        }

        if (parent) addChild(parent, node);
        nodeByModel.set(mn, node);
        nameIndex[mn.name] = node;

        for (const c of mn.children) visit(c, node);
    };
    visit(model.root, null);

    const scene = nodeByModel.get(model.root)!;

    const meshes: Record<string, { id: MeshId; aabb: Box3 }> = {};
    for (const m of model.meshesByName.values()) {
        meshes[m.name] = {
            id: { modelId, meshName: m.name },
            aabb: [m.aabb[0], m.aabb[1], m.aabb[2], m.aabb[3], m.aabb[4], m.aabb[5]],
        };
    }

    const animations: Record<string, ClipDef> = {};
    for (const c of model.clipsByName.values()) {
        animations[c.name] = { name: c.name, modelId };
    }

    // mutate the same def object in place so held refs (including the resources-side entry from setModel) stay valid
    const target = def as {
        -readonly [K in keyof ModelDef]: ModelDef[K];
    };
    target.scene = scene;
    target.aabb = [model.aabb[0], model.aabb[1], model.aabb[2], model.aabb[3], model.aabb[4], model.aabb[5]];
    target.nodes = nameIndex;
    target.meshes = meshes;
    target.animations = animations;
    target.version++;
}

function isIdentityTRS(mn: ModelNode): boolean {
    const [px, py, pz] = mn.position;
    const [qx, qy, qz, qw] = mn.quaternion;
    const [sx, sy, sz] = mn.scale;
    return (
        Math.abs(px) < TRS_EPS &&
        Math.abs(py) < TRS_EPS &&
        Math.abs(pz) < TRS_EPS &&
        Math.abs(qx) < TRS_EPS &&
        Math.abs(qy) < TRS_EPS &&
        Math.abs(qz) < TRS_EPS &&
        Math.abs(qw - 1) < TRS_EPS &&
        Math.abs(sx - 1) < TRS_EPS &&
        Math.abs(sy - 1) < TRS_EPS &&
        Math.abs(sz - 1) < TRS_EPS
    );
}

/**
 * Construct an empty `ModelDef` shell for `modelId`. Used by
 * `Resources.setModel` when the caller doesn't pass a codegen-stamped
 * handle (i.e. for runtime-uploaded models like avatars). The hydrator
 * mutates this same object in place once the payload lands.
 */
export function createEmptyDef(modelId: string): ModelDef {
    return {
        modelId,
        name: modelId,
        tags: [],
        src: '',
        bin: { client: '', server: '' },
        scene: createNode({ name: `__empty_${modelId}__` }),
        aabb: [0, 0, 0, 0, 0, 0],
        nodes: {},
        meshes: {},
        animations: {},
        version: 0,
    };
}
