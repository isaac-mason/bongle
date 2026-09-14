import type { Box3 } from 'math/shapes';
import type { Node } from '../scene/scene-tree';

/**
 * Compound id for a single mesh inside a model. `modelId` scopes by model file, `meshName` within it.
 * Wire format: length-prefixed modelId + length-prefixed meshName.
 */
export type MeshId = {
    readonly modelId: string;
    readonly meshName: string;
};

/** Which transform field a channel drives. */
export type ClipChannelProperty = 'translation' | 'rotation' | 'scale';

/** One animated property of one node, keyframes-only; sampling lives in the animator. Times are seconds, monotonically increasing. */
export type ClipChannel = {
    /** Target node by name within the rig (matches a node in `ModelHandle.nodes`). */
    nodeName: string;
    /** Which transform field this channel drives. */
    property: ClipChannelProperty;
    /** glTF interpolation mode. CUBICSPLINE keys are 3x wider (in/value/out). */
    interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
    /** Keyframe times in seconds. */
    times: Float32Array;
    /** Keyframe values, packed; stride determined by `property`. */
    values: Float32Array;
};

/** Parsed clip data, channels + clip duration. Loaded lazily into `Resources.modelPayloads[modelId].clips[name]`. */
export type ClipChannels = {
    /** Total clip length in seconds (max keyframe time across channels). */
    duration: number;
    channels: ClipChannel[];
};

/**
 * Singleton clip ref, exported by reference from the sidecar (`wizard.animations.idle`). The animator keys its
 * action Map by ref identity and looks up channels lazily via `Resources.modelClipChannels(resources, clip)`.
 */
export type ClipDef = {
    readonly name: string;
    readonly modelId: string;
};

/**
 * Static handle for one model. Codegen'd into `<basename>.glb.generated.ts`, never constructed at runtime.
 * Pure data: hashed for change detection and swapped wholesale when the barrel re-registers.
 */
export type ModelDef<NodeNames extends string = string, MeshNames extends string = string, ClipNames extends string = string> = {
    /** user-chosen id from `model('wizard', { src })`; stable handle. */
    readonly modelId: string;
    /** display name for editor UIs; defaults to `modelId`. */
    readonly name: string;
    /** search words for editor UIs, normalised (see `AssetMeta`). */
    readonly tags: readonly string[];
    /** source path relative to project root (e.g. 'characters/wizard.glb'). */
    readonly src: string;
    /** per-side public URLs for the packed payload; the engine picks the right side and fetches. Empty on the empty handle. */
    readonly bin: {
        readonly client: string;
        readonly server: string;
    };
    /** detached Node tree codegen'd from the gltf hierarchy, TransformTrait + MeshTrait already wired. Clone with `cloneNode()` before use. */
    readonly scene: Node;
    /**
     * bind-pose axis-aligned bounding box in root-local space, union of every mesh's AABB via its node's TRS chain.
     * `[minX, minY, minZ, maxX, maxY, maxZ]`. Static; animation can push verts outside it at runtime.
     */
    readonly aabb: Box3;
    /** flat-name index of every named gltf node (mesh-bearing or not); values are by-reference pointers into `scene`. */
    readonly nodes: { readonly [K in NodeNames]: Node };
    /** flat-name index for mesh-surgery, `meshTrait.meshId = wizard.meshes.HatA.id`, each with its bind-pose local-space AABB. */
    readonly meshes: { readonly [K in MeshNames]: { readonly id: MeshId; readonly aabb: Box3 } };
    /** Clip refs (singletons). Pass directly to Animation.clip(). */
    readonly animations: { readonly [K in ClipNames]: ClipDef };
    /** monotonic counter bumped when this handle's payload reloads; list in `prefab()` deps to re-trigger edit-time preview. Read-only for user code. */
    version: number;
};

/** Stable wrapper around a `ModelDef`; identity plus the live def, re-pointed on every codegen pass so a held handle stays current. */
export type ModelHandle<D extends ModelDef = ModelDef> = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /** DepGraph dependency + the brand `isHandle` tests. */
    dependency: { registry: 'models'; id: string };
    /** the codegen'd data. re-pointed on every re-registration. */
    def: D;

    // forwarding accessors, not stored copies, so they never go stale when `def` is re-pointed.
    // the engine reads `ModelDef` directly, so per-frame paths pay nothing for these.

    /** @see ModelDef.name */
    readonly name: string;
    /** @see ModelDef.src */
    readonly src: string;
    /** @see ModelDef.scene */
    readonly scene: D['scene'];
    /** @see ModelDef.aabb */
    readonly aabb: D['aabb'];
    /** @see ModelDef.nodes */
    readonly nodes: D['nodes'];
    /** @see ModelDef.meshes */
    readonly meshes: D['meshes'];
    /** @see ModelDef.animations */
    readonly animations: D['animations'];
};
