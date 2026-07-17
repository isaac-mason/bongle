// build-runtime-handle.ts, construct a `ModelHandle` from a parsed
// `Model`. Used by `Resources.ensureModel` to hydrate the empty handle
// that `setModel` created for runtime models (avatars, uploaded assets).
// Structurally mirrors the bongle pipeline's codegen barrel
// (`renderModelConstruction` in src/asset-pipeline/bake/models.ts), the
// codegen path is still the source of truth for *declared* models
// because it gives a synchronous typed handle at module-eval; this
// function is the runtime equivalent for models that have no codegen
// because they were uploaded at runtime.
//
// Mutates the passed-in `handle` in place (same object identity) so any
// user code that grabbed a ref to the empty shell stays valid; bumps
// `handle.version` so dependent prefabs / queries re-trigger.

import type { Box3 } from 'mathcat';
import { MeshTrait } from '../../builtins/mesh';
import { TransformTrait } from '../../builtins/transform';
import { addChild, addTrait, createNode, type Node } from '../scene/scene-tree';
import type { ClipDef, MeshId, ModelHandle } from './handle';
import type { Model, ModelNode } from './model';

/** TRS within `TRS_EPS` of identity, gltf bake noise absorbs the slack. */
const TRS_EPS = 1e-6;

/**
 * Hydrate `handle` from `model` in place. Reads the node tree under
 * `model.root`, the by-name indices, and per-mesh AABBs. Writes node
 * tree, flat node index, mesh ref index, clip ref index, root-local
 * AABB. Bumps `handle.version`.
 *
 * Identity isn't preserved across re-hydration, fresh `Node` objects
 * are created each call. Re-hydration isn't part of the normal flow
 * anyway: model swap goes via setModel + a fresh handle for a different id.
 */
export function hydrateRuntimeHandle(handle: ModelHandle, model: Model): void {
    const modelId = handle.modelId;

    // animated set: any ModelNode that's a target of at least one channel.
    // gates TransformTrait stamping on identity non-mesh nodes.
    const animated = new Set<ModelNode>();
    for (const clip of model.clipsByName.values()) {
        for (const ch of clip.channels) animated.add(ch.target);
    }

    // walk the runtime tree in DFS, building a parallel Node tree. keep
    // a parallel ModelNode→Node map so addChild() can wire parents.
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

    // mutate the same handle object in place, user refs (and the
    // resources-side entry from setModel) stay valid.
    const target = handle as {
        -readonly [K in keyof ModelHandle]: ModelHandle[K];
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
 * Construct an empty `ModelHandle` shell for `modelId`. Used by
 * `Resources.setModel` when the caller doesn't pass a codegen-stamped
 * handle (i.e. for runtime-uploaded models like avatars). The hydrator
 * mutates this same object in place once the payload lands.
 */
export function createEmptyHandle(modelId: string): ModelHandle {
    return {
        modelId,
        name: modelId,
        dependency: { registry: 'models', id: modelId },
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
