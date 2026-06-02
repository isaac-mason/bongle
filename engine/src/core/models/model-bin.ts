// Model .bin format — packcat schema shared by CLI emit and engine unpack.
//
// Two artifacts per model, same schema:
//   <basename>.<hash8>.server.bin — meshes + clips + scene (`images: undefined`)
//   <basename>.<hash8>.client.bin — meshes + clips + scene + images
//
// Same `unpack(bytes)` runs on both sides; client reads `result.images ?? []`.
//
// Scene tree (`nodes` + `rootIndices` + `aabb`) lives here so runtime-only
// `.glb` uploads (avatars) can hydrate the same `ModelHandle` shape that
// codegen produces for declared models. Declared models still have the
// codegen sidecar — that's the static-at-module-eval source of truth for
// `wizard.scene` / `.nodes.Body` etc. — but the .bin now carries the same
// data structurally so the runtime hydrator path doesn't need a separate
// format-specific construction routine.

import * as packcat from 'packcat';

const meshSchema = packcat.object({
    /** mesh-name within the model. */
    name: packcat.string(),
    /** vertex positions, 3 floats per vertex. */
    positions: packcat.float32Array(),
    /** vertex normals, 3 floats per vertex. */
    normals: packcat.float32Array(),
    /** vertex uvs, 2 floats per vertex. */
    uvs: packcat.float32Array(),
    /** triangle indices (uint32 always — keeps slot math uniform pool-side). */
    indices: packcat.uint32Array(),
    /** local-space AABB — mathcat `Box3` (`[minX, minY, minZ, maxX, maxY, maxZ]`). */
    aabb: packcat.list(packcat.float32(), 6),
    /**
     * index into `images` for this mesh's base-color texture; absent for
     * untextured meshes (no material, or material without baseColorTexture).
     *
     * one-image-per-mesh is an importer constraint: `extractMesh` flattens
     * all primitives into one geometry, so primitives with different
     * baseColor textures would render with whichever the first primitive
     * picked. fix is to split per-primitive at import; out of scope here.
     */
    imageIndex: packcat.optional(packcat.int32()),
});

const channelSchema = packcat.object({
    /** target node by name within the rig (must match a node in `ModelHandle.nodes`). */
    nodeName: packcat.string(),
    /** which transform field this channel drives. */
    property: packcat.enumeration(['translation', 'rotation', 'scale'] as const),
    /** glTF interpolation. CUBICSPLINE keys are 3× wider (in/value/out). */
    interpolation: packcat.enumeration(['LINEAR', 'STEP', 'CUBICSPLINE'] as const),
    /** keyframe times in seconds, monotonically increasing. */
    times: packcat.float32Array(),
    /** keyframe values; stride 3 for translation/scale, 4 for rotation. */
    values: packcat.float32Array(),
});

const clipSchema = packcat.object({
    /** clip name within the model. */
    name: packcat.string(),
    /** total clip length in seconds. */
    duration: packcat.float32(),
    channels: packcat.list(channelSchema),
});

const imageSchema = packcat.object({
    /** mime type — 'image/png' or 'image/jpeg' typically. */
    mimeType: packcat.string(),
    /** raw image bytes; client decodes via createImageBitmap. */
    bytes: packcat.uint8Array(),
});

/**
 * Flat scene-tree entry. Mirrors the kit pipeline's `SceneNodeInfo` shape
 * so the runtime hydrator and codegen barrel can produce equivalent
 * `ModelHandle.scene` trees from the same data.
 *
 * DFS order: parents always precede children, so a one-pass build can
 * resolve `parent` indices and accumulate world matrices.
 */
const sceneNodeSchema = packcat.object({
    /** unique within model (kit/parser dedupe via numeric suffix). */
    name: packcat.string(),
    /** index of parent in the flat array, or -1 for roots. */
    parent: packcat.int32(),
    /** local-space TRS at bind. */
    position: packcat.list(packcat.float32(), 3),
    quaternion: packcat.list(packcat.float32(), 4),
    scale: packcat.list(packcat.float32(), 3),
    /** unique mesh name attached to this node (matches `meshes[].name`),
     *  or undefined for transform-only nodes. */
    meshName: packcat.optional(packcat.string()),
});

/** Shared model-bin schema. `images` omitted in the server artifact. */
export const modelBinSchema = packcat.object({
    meshes: packcat.list(meshSchema),
    clips: packcat.list(clipSchema),
    images: packcat.optional(packcat.list(imageSchema)),
    /**
     * DFS-flattened scene tree. Empty list is legal — a meshes-only model
     * (one root with one mesh) needs no hierarchy; the hydrator wraps it
     * in a synthetic root.
     */
    sceneNodes: packcat.list(sceneNodeSchema),
    /** indices into `sceneNodes[]` for top-level (parent === -1) nodes. */
    rootIndices: packcat.list(packcat.uint16()),
    /** node names referenced by at least one clip channel. lets the
     *  hydrator skip `TransformTrait` on identity non-mesh non-animated
     *  nodes (matches the codegen barrel's same optimization). */
    animatedNodeNames: packcat.list(packcat.string()),
    /** bind-pose AABB in root-local space — union of mesh AABBs
     *  transformed by each owning node's accumulated TRS chain. */
    aabb: packcat.list(packcat.float32(), 6),
});

export type ModelBin = packcat.SchemaType<typeof modelBinSchema>;
export type ModelBinMesh = packcat.SchemaType<typeof meshSchema>;
export type ModelBinClip = packcat.SchemaType<typeof clipSchema>;
export type ModelBinChannel = packcat.SchemaType<typeof channelSchema>;
export type ModelBinImage = packcat.SchemaType<typeof imageSchema>;
export type ModelBinSceneNode = packcat.SchemaType<typeof sceneNodeSchema>;

const codec = packcat.build(modelBinSchema);

/** Pack a model bin. CLI uses this. */
export const pack = codec.pack;

/** Unpack a fetched .bin. Engine runtime uses this. */
export const unpack = codec.unpack;
