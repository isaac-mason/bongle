// Type definitions for the new model handle system.
//
// Handle values themselves come from codegen'd per-model sidecar files
// (`src/generated/models/<id>.ts`), this file is types-only.
//
// Sub-asset references mirror commercial-engine patterns:
//   - meshes by compound id { modelId, meshName } (Unity GUID+fileID, Unreal path+sub-name)
//   - clips by ClipDef ref identity (three.js style, sidecar exports refs, animator keys by identity)

import type { Box3 } from 'mathcat';
import type { Node } from '../scene/scene-tree';

/**
 * Compound id for a single mesh inside a model.
 * modelId is the user-chosen string id from `model('wizard', { src })`,
 * scopes by model file. meshName scopes within the file.
 *
 * Wire format: length-prefixed modelId + length-prefixed meshName.
 */
export type MeshId = {
    readonly modelId: string;
    readonly meshName: string;
};

/** Which transform field a channel drives. */
export type ClipChannelProperty = 'translation' | 'rotation' | 'scale';

/**
 * One animated property of one node, keyframes-only, sampling lives in
 * the animator (W3.3). Times are seconds, monotonically increasing.
 * Values stride is 3 for translation/scale, 4 for rotation (xyzw quats).
 */
export type ClipChannel = {
    /** Target node by name within the rig (matches a node in `ModelHandle.nodes`). */
    nodeName: string;
    /** Which transform field this channel drives. */
    property: ClipChannelProperty;
    /** glTF interpolation mode. CUBICSPLINE keys are 3× wider (in/value/out). */
    interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
    /** Keyframe times in seconds. */
    times: Float32Array;
    /** Keyframe values, packed; stride determined by `property`. */
    values: Float32Array;
};

/**
 * Parsed clip data, channels + clip duration. Stored in
 * `Resources.modelPayloads[modelId].clips[name]` once the bin loads;
 * consumed by the animator via `Resources.modelClipChannels(resources, clip)`.
 */
export type ClipChannels = {
    /** Total clip length in seconds (max keyframe time across channels). */
    duration: number;
    channels: ClipChannel[];
};

/**
 * Singleton clip ref. Per (model, clip name), exported by reference from
 * the sidecar (`wizard.animations.idle`). Pure value type, channel data
 * lives in `Resources.modelPayloads[modelId].clips[name]` and is fetched
 * lazily when the model bin loads. User code passes the ref to
 * `Animation.clip()`; the animator keys its action Map by ref identity,
 * and looks up channels each tick via
 * `Resources.modelClipChannels(resources, clip)`.
 */
export type ClipDef = {
    readonly name: string;
    readonly modelId: string;
};

/**
 * Static handle for a single model. Codegen'd into `<basename>.glb.generated.ts`,
 * never constructed at runtime.
 *
 * Fully typed against the source gltf:
 *   - NodeNames: union of all named gltf nodes (mesh-bearing or not)
 *   - MeshNames: union of all mesh names
 *   - ClipNames: union of all animation clip names
 */
export type ModelHandle<
    NodeNames extends string = string,
    MeshNames extends string = string,
    ClipNames extends string = string,
> = {
    /** User-chosen id from `model('wizard', { src })`. Stable handle. */
    readonly modelId: string;
    /** human-readable display name for editor UIs. always set,
     *  defaults to `modelId` when the author didn't supply one. */
    readonly name: string;
    /** DepGraph dependency, see SceneHandle.dependency. */
    dependency: { registry: 'models'; id: string };
    /** Source path (relative to project root, e.g. 'characters/wizard.glb'). Informational. */
    readonly src: string;
    /**
     * Per-side public URLs for the packed payload, codegen'd as plain
     * strings pointing at `/generated/models/<id>.<hash>.<side>.bin` (the cli writes
     * the bins under `public/generated/models/`). Engine picks the right side and
     * fetches; user code doesn't touch it. Empty strings on the empty
     * handle.
     */
    readonly bin: {
        readonly client: string;
        readonly server: string;
    };
    /**
     * Detached Node tree, codegen'd from the gltf hierarchy. Carries
     * TransformTrait values (baked from gltf node TRS) and MeshTrait with
     * meshIds wired to the right structs. Clone with cloneNode() before use;
     * treat as immutable by convention.
     */
    readonly scene: Node;
    /**
     * Bind-pose axis-aligned bounding box in root-local space, union of every
     * mesh's AABB transformed by its node's accumulated TRS chain to the scene
     * root. Static (computed at codegen). Use for spawn/framing/coarse colliders;
     * animation can push verts outside this box at runtime.
     *
     * mathcat `Box3`: `[minX, minY, minZ, maxX, maxY, maxZ]`. Empty handle:
     * zero box at origin.
     */
    readonly aabb: Box3;
    /**
     * Flat-name index of every named gltf node (mesh-bearing or not).
     * Each value is a by-reference pointer into `scene`, clone with
     * cloneNode() to materialize, or reference by name via `model(handle, nodeName)`.
     */
    readonly nodes: { readonly [K in NodeNames]: Node };
    /**
     * Flat-name index for mesh-surgery: `meshTrait.meshId = wizard.meshes.HatA.id`.
     * Each entry also carries the mesh's bind-pose local-space AABB
     * (mathcat `Box3`), handy for mesh-level framing or coarse colliders
     * without paying for the runtime payload fetch.
     */
    readonly meshes: { readonly [K in MeshNames]: { readonly id: MeshId; readonly aabb: Box3 } };
    /** Clip refs (singletons). Pass directly to Animation.clip(). */
    readonly animations: { readonly [K in ClipNames]: ClipDef };
    /**
     * monotonic counter bumped when this handle's payload reloads. starts
     * at 0. let prefab() callers list the handle in `deps` to re-trigger
     * preview at edit time when the model changes. mutated by the engine;
     * user code treats it as read-only.
     */
    version: number;
};
