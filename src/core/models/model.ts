import type { Quat, Vec3 } from 'math';
import type { Box3 } from 'math/shapes';
import type { ModelBin } from './model-bin';

/** scene-graph node in the parsed model. */
export type ModelNode = {
    name: string;
    /** local-space TRS at bind pose. */
    position: Vec3;
    quaternion: Quat;
    scale: Vec3;
    /** parent node, or null for the root. */
    parent: ModelNode | null;
    children: ModelNode[];
    /** mesh attached to this node, or null; resolved at parse time so consumers never index back through the model. */
    mesh: ModelMesh | null;
};

export type ModelMesh = {
    name: string;
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    /** local-space AABB. */
    aabb: Box3;
    /** baseColor image, or null. resolved at parse time. */
    image: ModelImage | null;
};

export type ModelClip = {
    name: string;
    /** total clip length in seconds. */
    duration: number;
    channels: ModelChannel[];
};

export type ModelChannel = {
    /** target node by direct ref. */
    target: ModelNode;
    /** which transform field this channel drives. */
    property: 'translation' | 'rotation' | 'scale';
    /** glTF interpolation mode. */
    interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
    /** keyframe times in seconds, monotonically increasing. */
    times: Float32Array;
    /** keyframe values; stride 3 for translation/scale, 4 for rotation. */
    values: Float32Array;
};

export type ModelImage = {
    mimeType: string;
    bytes: Uint8Array;
};

/** The parsed in-memory model, runtime-only. Produced by `gltfUnpack` (runtime .glb) and `toModel` (declared .bin). */
export type Model = {
    /** scene root; when the source has multiple top-level nodes, a synthetic wrapper named after the modelId. */
    root: ModelNode;
    /** flat by-name index, same node refs as the tree under `root`. */
    nodesByName: Map<string, ModelNode>;
    meshesByName: Map<string, ModelMesh>;
    clipsByName: Map<string, ModelClip>;
    images: ModelImage[];
    /** bind-pose AABB in root-local space, union of mesh AABBs transformed by each owning node's accumulated TRS chain. */
    aabb: Box3;
};

/**
 * Converts a wire-format `ModelBin` into the runtime `Model` shape: resolves flat indices into direct
 * object refs, builds the by-name maps, and synthesizes a wrapper root for multi-root sources.
 * `modelId` names the synthetic wrapper root when needed.
 */
export function toModel(modelId: string, bin: ModelBin): Model {
    const images: ModelImage[] = (bin.images ?? []).map((img) => ({
        mimeType: img.mimeType,
        bytes: img.bytes,
    }));

    const meshesByName = new Map<string, ModelMesh>();
    for (const m of bin.meshes) {
        meshesByName.set(m.name, {
            name: m.name,
            positions: m.positions,
            normals: m.normals,
            uvs: m.uvs,
            indices: m.indices,
            aabb: [m.aabb[0], m.aabb[1], m.aabb[2], m.aabb[3], m.aabb[4], m.aabb[5]],
            image: m.imageIndex !== undefined ? (images[m.imageIndex] ?? null) : null,
        });
    }

    // two-pass build so parent/children refs always resolve
    const flatNodes: ModelNode[] = new Array(bin.sceneNodes.length);
    const nodesByName = new Map<string, ModelNode>();
    for (let i = 0; i < bin.sceneNodes.length; i++) {
        const sn = bin.sceneNodes[i]!;
        const node: ModelNode = {
            name: sn.name,
            position: [sn.position[0], sn.position[1], sn.position[2]],
            quaternion: [sn.quaternion[0], sn.quaternion[1], sn.quaternion[2], sn.quaternion[3]],
            scale: [sn.scale[0], sn.scale[1], sn.scale[2]],
            parent: null,
            children: [],
            mesh: sn.meshName !== undefined ? (meshesByName.get(sn.meshName) ?? null) : null,
        };
        flatNodes[i] = node;
        nodesByName.set(sn.name, node);
    }
    for (let i = 0; i < bin.sceneNodes.length; i++) {
        const sn = bin.sceneNodes[i]!;
        if (sn.parent < 0) continue;
        const parent = flatNodes[sn.parent]!;
        const child = flatNodes[i]!;
        child.parent = parent;
        parent.children.push(child);
    }

    const clipsByName = new Map<string, ModelClip>();
    for (const c of bin.clips) {
        const channels: ModelChannel[] = [];
        for (const ch of c.channels) {
            const target = nodesByName.get(ch.nodeName);
            // no resolvable target means dead data (stale wire bytes or a malformed source gltf); drop quietly
            if (!target) continue;
            channels.push({
                target,
                property: ch.property,
                interpolation: ch.interpolation,
                times: ch.times,
                values: ch.values,
            });
        }
        clipsByName.set(c.name, { name: c.name, duration: c.duration, channels });
    }

    const root = pickOrSynthesizeRoot(modelId, flatNodes, bin.rootIndices);

    return {
        root,
        nodesByName,
        meshesByName,
        clipsByName,
        images,
        aabb: [bin.aabb[0], bin.aabb[1], bin.aabb[2], bin.aabb[3], bin.aabb[4], bin.aabb[5]],
    };
}

function pickOrSynthesizeRoot(modelId: string, flatNodes: ModelNode[], rootIndices: readonly number[]): ModelNode {
    if (rootIndices.length === 1) return flatNodes[rootIndices[0]!]!;
    if (rootIndices.length === 0) {
        // an empty model still needs a root for the hydrator to mount under
        return makeWrapperRoot(modelId, []);
    }
    const roots = rootIndices.map((i) => flatNodes[i]!);
    return makeWrapperRoot(modelId, roots);
}

function makeWrapperRoot(name: string, children: ModelNode[]): ModelNode {
    const wrapper: ModelNode = {
        name,
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        parent: null,
        children: [],
        mesh: null,
    };
    for (const c of children) {
        c.parent = wrapper;
        wrapper.children.push(c);
    }
    return wrapper;
}
