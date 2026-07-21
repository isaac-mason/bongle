import type { Shape } from 'crashcat';
import type { ParticleHandle } from '../particles/particles';
import { type AABB, type BlockShape, blockShapeToShape } from './block-collider';
import type { PropsDef, PropsValues } from './block-state';
import type {
    BlockDef,
    BlockHandle,
    BlockModel,
    BlockParticleConfig,
    BlockQuad,
    BlockSoundConfig,
    BlockTextureDef,
    VertexAnimation,
} from './blocks';
import { collectModelTextureIds, deriveBlockDust, MaterialType, resolveTextureRef } from './blocks';
import { defaultLightOpacity, packEmission } from './light';

/** shape kind enum; matches block-collider's BlockShape['type'] order. */
export const SHAPE_CUBE = 0;
export const SHAPE_AABBS = 1;

/** global state id for air. always 0. */
export const AIR = 0;

/** global state id for missing/unresolved blocks. always 1. */
export const MISSING = 1;

/** first global state id available for user blocks. */
const USER_BLOCKS_START = 2;

/** block participates in physics collision. */
export const BLOCK_FLAG_COLLISION = 1 << 0;

/** block can be targeted by selection raycasts. */
export const BLOCK_FLAG_SELECTION = 1 << 1;

/** block is climbable (ladder-like). character bypasses gravity inside it. */
export const BLOCK_FLAG_CLIMBABLE = 1 << 2;

/** block is a liquid. character swims while submerged. */
export const BLOCK_FLAG_LIQUID = 1 << 3;

/** crouched character can edge-guard (anchor + clamp) on this block. */
export const BLOCK_FLAG_SNEAK_GUARD = 1 << 4;

/** block is a fence, fences connect to other fence-flagged blocks. */
export const BLOCK_FLAG_FENCE = 1 << 5;

/** block is a wall, walls connect to other wall-flagged blocks. */
export const BLOCK_FLAG_WALL = 1 << 6;

/** block is a glass pane / bars, panes connect to other pane-flagged blocks. */
export const BLOCK_FLAG_PANE = 1 << 7;

/** block is a door half, identifies the two cells of a door for the
 *  get/setDoorOpen utils (all door presets share one DoorState schema). */
export const BLOCK_FLAG_DOOR = 1 << 8;

/** a navigating agent may occupy/pass through this cell. defaults to the
 *  inverse of `collision` at registration, overridable via
 *  `block({ pathfindable })`, e.g. open doors pathable, hazards not. read by
 *  the voxel pathfinding utils (core/nav). mirrors Minecraft `isPathfindable`. */
export const BLOCK_FLAG_PATHFINDABLE = 1 << 9;

/**
 * format a string key from a block id, its state schema, and a local state index.
 *
 * stateless blocks:  "stone"
 * blocks with props: "oak_log[axis=y]"
 * multi-prop:        "stone_stairs[facing=east,half=bottom,shape=straight]"
 */
export function formatKey(blockId: string, states: import('./block-state').BlockStateDef, localIndex: number): string {
    const propNames = Object.keys(states.props);
    if (propNames.length === 0) return blockId;
    const decoded = states.decode(localIndex);
    const parts = propNames.map((k) => `${k}=${String((decoded as Record<string, unknown>)[k])}`);
    return `${blockId}[${parts.join(',')}]`;
}

/**
 * parse a minecraft-style block state key into its block id and raw prop strings.
 *
 * returns null on bad format. unknown props are included as-is; callers decide
 * how to handle them. missing props should be filled with their default values.
 *
 * examples:
 *   "stone"                                  → { blockId: "stone", props: {} }
 *   "oak_log[axis=y]"                        → { blockId: "oak_log", props: { axis: "y" } }
 *   "stone_stairs[facing=east,half=bottom]"  → { blockId: "stone_stairs", props: { facing: "east", half: "bottom" } }
 */
export function parseKey(key: string): { blockId: string; props: Record<string, string> } | null {
    const bracket = key.indexOf('[');
    if (bracket === -1) {
        // stateless
        if (key.length === 0) return null;
        return { blockId: key, props: {} };
    }
    if (!key.endsWith(']')) return null;
    const blockId = key.substring(0, bracket);
    if (blockId.length === 0) return null;
    const inner = key.substring(bracket + 1, key.length - 1);
    const props: Record<string, string> = {};
    if (inner.length > 0) {
        for (const pair of inner.split(',')) {
            const eq = pair.indexOf('=');
            if (eq === -1) return null;
            props[pair.substring(0, eq)] = pair.substring(eq + 1);
        }
    }
    return { blockId, props };
}

/** pack VertexAnimation enum into uint8 for flat lookup tables. */
export function encodeVertexAnimation(va: VertexAnimation | undefined): number {
    return va ?? 0;
}

/** no geometry (air, missing, invisible blocks). */
export const MODEL_NONE = 0;

/** standard cube, all data in stateTexCube, no mesh arrays needed. */
export const MODEL_CUBE = 1;

/** custom triangle mesh, data in meshXYZ dense arrays. */
export const MODEL_MESH = 2;

/**
 * liquid, cube-like geometry with a fractional top surface height.
 * uses cubeTexIndices for textures. the mesher emits a cube whose top
 * quad is lowered to surfaceHeight[stateId] and whose side quads are
 * height-clipped (positions and UVs).
 */
export const MODEL_LIQUID = 3;

// ── mesh quad shape tags (per-quad prebaked AO/smooth-light routing) ─
//
// classified once at registry freeze. the mesher branches by shape tag
// in the MODEL_MESH path to apply Sodium-equivalent AoFaceData sampling
// without re-deriving geometry per voxel. mirrors the 5 cases in
// SmoothLightPipeline.java (applyAlignedFullFace / AlignedPartialFace /
// ParallelFace / NonParallelFace / IrregularFace).
//
// face indexing (used by SHAPE_*_FACE quads + meshQuadFaceDir) matches
// the mesher's face loop order:
// 0=east(+x), 1=west(-x), 2=up(+y), 3=down(-y), 4=south(+z), 5=north(-z).

/** quad opts out of smooth lighting (ao: false). flat per-cell light. */
export const SHAPE_FLAT = 0;
/** axis-aligned quad covering all 4 corners of a face. direct corner→vertex. */
export const SHAPE_ALIGNED_FULL = 1;
/** axis-aligned quad, partial coverage (slab top, half-step). per-vertex bilerp. */
export const SHAPE_ALIGNED_PARTIAL = 2;
/** quad parallel to a face plane, uniform inset depth. blend offset/non-offset by depth. */
export const SHAPE_PARALLEL = 3;
/** quad parallel to a face plane, but verts have different depths. per-vertex blend. */
export const SHAPE_NON_PARALLEL = 4;
/** quad with non-axis-aligned normal (vegetation cross-quads, etc.). squared-normal blend. */
export const SHAPE_IRREGULAR = 5;

/** face direction sentinel, quad has no single owning face (IRREGULAR). */
export const FACE_DIR_NONE = 0xff;

/** epsilon for snapping vert components to axis planes / corner positions. */
const MESH_SHAPE_EPSILON = 1e-4;

/**
 * per face direction (0..5) → (axisU, axisW) ∈ {0=x, 1=y, 2=z}.
 * stride 2. used to project a vert onto the face plane:
 *   u = vert[axisU], w = vert[axisW]
 * mesher face order: 0=east(+x), 1=west(-x), 2=up(+y), 3=down(-y),
 * 4=south(+z), 5=north(-z).
 */
const FACE_AXIS_UW = /* @__PURE__ */ new Uint8Array([
    2,
    1, // east
    2,
    1, // west
    0,
    2, // up
    0,
    2, // down
    0,
    1, // south
    0,
    1, // north
]);

/**
 * classify a mesh quad into a shape tag and gather the per-shape data the
 * mesher needs (face direction, uniform depth, per-vertex depths/normals).
 *
 * `outDepthsScratch` and `outNormalsScratch` are write-only buffers sized
 * for 4 verts (length 4 / length 12), populated only when the resolved
 * shape needs them (NON_PARALLEL / IRREGULAR). callers copy out as needed.
 *
 * mirrors Sodium's SmoothLightPipeline shape branching at
 * SmoothLightPipeline.java:90-309 (with the same depth ε short-circuits).
 */
function classifyMeshQuadShape(
    q: BlockQuad,
    outDepthsScratch: Float32Array,
    outNormalsScratch: Float32Array,
): { shape: number; faceDir: number; depth: number } {
    if (q.ao === false) return { shape: SHAPE_FLAT, faceDir: FACE_DIR_NONE, depth: 0 };

    const v = q.verts;
    const v0 = v[0],
        v1 = v[1],
        v2 = v[2],
        v3 = v[3];
    const n = q.normal;

    // try to find a face direction (0..5) that the quad's normal aligns with
    // AND all 4 verts share a single depth along that axis.
    // axis: 0=x, 1=y, 2=z. positive flag picks face dir 0/2/4, negative picks 1/3/5.
    let axis = -1;
    let positive = false;
    if (Math.abs(n[0]) > 0.999) {
        axis = 0;
        positive = n[0] > 0;
    } else if (Math.abs(n[1]) > 0.999) {
        axis = 1;
        positive = n[1] > 0;
    } else if (Math.abs(n[2]) > 0.999) {
        axis = 2;
        positive = n[2] > 0;
    }

    if (axis >= 0) {
        // axis-aligned normal. measure per-vertex depth = inset distance from
        // the face plane in [0,1]. positive face: depth = 1 - axisComp. negative
        // face: depth = axisComp. (matches Sodium's getDepth in AoNeighborInfo.)
        const c0 = v0[axis],
            c1 = v1[axis],
            c2 = v2[axis],
            c3 = v3[axis];
        const d0 = positive ? 1 - c0 : c0;
        const d1 = positive ? 1 - c1 : c1;
        const d2 = positive ? 1 - c2 : c2;
        const d3 = positive ? 1 - c3 : c3;
        const dMin = Math.min(d0, d1, d2, d3);
        const dMax = Math.max(d0, d1, d2, d3);
        const faceDir = axis * 2 + (positive ? 0 : 1);

        if (dMax - dMin < MESH_SHAPE_EPSILON) {
            // uniform depth. distinguish ALIGNED_FULL (covers all 4 corners
            // of the face) vs ALIGNED_PARTIAL (partial coverage) vs PARALLEL
            // (inset uniform-depth quad).
            const depth = (d0 + d1 + d2 + d3) * 0.25;
            if (depth < MESH_SHAPE_EPSILON || depth > 1 - MESH_SHAPE_EPSILON) {
                // on a face plane (depth ≈ 0 or 1). check full-face coverage
                // along the two non-axis components.
                const ua = axis === 0 ? 2 : 0; // x→z, y→x, z→x
                const ub = axis === 1 ? 2 : 1; // x→y, y→z, z→y
                const minU = Math.min(v0[ua], v1[ua], v2[ua], v3[ua]);
                const maxU = Math.max(v0[ua], v1[ua], v2[ua], v3[ua]);
                const minV = Math.min(v0[ub], v1[ub], v2[ub], v3[ub]);
                const maxV = Math.max(v0[ub], v1[ub], v2[ub], v3[ub]);
                const isFull =
                    minU < MESH_SHAPE_EPSILON &&
                    maxU > 1 - MESH_SHAPE_EPSILON &&
                    minV < MESH_SHAPE_EPSILON &&
                    maxV > 1 - MESH_SHAPE_EPSILON;
                return { shape: isFull ? SHAPE_ALIGNED_FULL : SHAPE_ALIGNED_PARTIAL, faceDir, depth };
            }
            return { shape: SHAPE_PARALLEL, faceDir, depth };
        }

        // varying depth → NON_PARALLEL. write per-vertex depths.
        outDepthsScratch[0] = d0;
        outDepthsScratch[1] = d1;
        outDepthsScratch[2] = d2;
        outDepthsScratch[3] = d3;
        return { shape: SHAPE_NON_PARALLEL, faceDir, depth: 0 };
    }

    // non-axis-aligned normal → IRREGULAR. fall back to face normal for all 4
    // verts (BlockQuad has no per-vertex normals yet, Sodium reads
    // `getAccurateNormal(i)` per vert; if/when we add per-vert normals we'd
    // copy them here instead).
    for (let i = 0; i < 4; i++) {
        outNormalsScratch[i * 3] = n[0];
        outNormalsScratch[i * 3 + 1] = n[1];
        outNormalsScratch[i * 3 + 2] = n[2];
    }
    return { shape: SHAPE_IRREGULAR, faceDir: FACE_DIR_NONE, depth: 0 };
}

export type Blocks = {
    /** total number of global state ids across all blocks (including air + missing). */
    totalStates: number;
    /** number of registered block types (not counting the implicit missing sentinel). */
    blockCount: number;

    /** block defs in registration order. indexed by dense block type index. */
    defs: BlockDef[];
    /** block string id → def. */
    idToDef: Map<string, BlockDef>;
    /** block handles in registration order. */
    handles: BlockHandle[];
    /** block string id → handle. */
    idToHandle: Map<string, BlockHandle>;

    /** global state id → dense block type index. */
    stateToBlockIndex: Uint16Array;
    /** global state id → local state index within that block. */
    stateToLocalIndex: Uint16Array;

    /**
     * global state id → model type (MODEL_NONE=0, MODEL_CUBE=1, MODEL_MESH=2).
     * used to branch in the mesher/raycast/physics without touching any object.
     */
    modelType: Uint8Array;

    // ── cube-only data ──────────────────────────────────────────────

    /**
     * per-state cube texture indices. 6 entries per state, stride=6.
     * face order: top(0), bottom(1), north(2), south(3), east(4), west(5).
     * indexed as stateId * 6 + faceIdx. only meaningful for MODEL_CUBE states
     * but allocated for all states (unused entries are 0).
     */
    cubeTexIndices: Uint16Array;

    /**
     * per-state cube face UVs. 48 entries per state (6 faces × 4 corners × 2
     * components), stride=48. baked from the canonical FACE_UVS pattern with
     * per-face rotation applied at build time. mesher reads these directly
     * instead of the global FACE_UVS constant, so per-face rotation costs
     * nothing in the hot loop. values are 0 or 1.
     *
     * face-order indexing matches the mesher's emit order (east, west, up,
     * down, south, north, driven by FACE_TEX_OFFSET).
     */
    cubeFaceUVs: Uint8Array;

    // ── mesh-only data (dense, indexed by meshId) ───────────────────

    /**
     * global state id → dense mesh index (0 = not a mesh, 1+ = valid).
     * only non-zero for MODEL_MESH states.
     */
    meshId: Uint16Array;
    /** dense quad arrays. index 0 is unused (sentinel). */
    meshQuads: BlockQuad[][];
    /** dense pre-resolved texture indices per quad. parallel to meshQuads. */
    meshTexIndices: Uint16Array[];
    /**
     * dense per-quad material (MaterialType enum). parallel to meshQuads.
     * always allocated, quads without explicit material get the block's default.
     */
    meshQuadMaterials: Uint8Array[];

    /**
     * per-quad shape tag (SHAPE_FLAT..SHAPE_IRREGULAR) routing the mesher
     * into the matching AO/smooth-light emit path. parallel to meshQuads.
     */
    meshQuadShape: Uint8Array[];
    /**
     * per-quad primary face direction (0..5 mesher face order, or
     * FACE_DIR_NONE=0xff for IRREGULAR). populated for ALIGNED_FULL,
     * ALIGNED_PARTIAL, PARALLEL, NON_PARALLEL. parallel to meshQuads.
     */
    meshQuadFaceDir: Uint8Array[];
    /**
     * per-quad cull-face direction (0..5 mesher face order, or
     * FACE_DIR_NONE=0xff for "no cull face"). pre-resolved from the
     * `cullFace?: 'east'|'west'|'up'|'down'|'south'|'north'` BlockQuad
     * field so the mesher hot loop reads one Uint8 instead of a
     * string-keyed Record lookup per quad. parallel to meshQuads.
     */
    meshQuadCullFaceDir: Uint8Array[];
    /**
     * per-quad uniform inset depth ∈ [0,1] along the face direction.
     * 0 = on the face plane (offset face data), 1 = on the opposite face
     * plane (non-offset face data). meaningful for ALIGNED_FULL,
     * ALIGNED_PARTIAL, PARALLEL. unused for NON_PARALLEL/IRREGULAR. parallel
     * to meshQuads.
     */
    meshQuadDepth: Float32Array[];
    /**
     * per-vertex inset depth, only populated for NON_PARALLEL quads.
     * length = quads.length * 4. zero-filled for other shapes (cheap; mesh
     * models are small).
     */
    meshQuadVertDepth: Float32Array[];
    /**
     * per-vertex normal, only populated for IRREGULAR quads. length =
     * quads.length * 4 * 3. zero-filled for other shapes. when a BlockQuad
     * doesn't supply per-vertex normals we replicate the face normal.
     */
    meshQuadVertNormal: Float32Array[];

    /**
     * per-vertex (u, w) coords on the quad's chosen face plane, in [0,1].
     * length = quads.length * 8 (4 corners × 2 floats). populated for
     * ALIGNED_FULL / ALIGNED_PARTIAL / PARALLEL / NON_PARALLEL. zero for
     * FLAT and IRREGULAR (IRREGULAR uses meshQuadCornerPos).
     *
     * relight reads these to bilerp the 4 face-corner light samples without
     * re-deriving projections from BlockQuad.verts.
     */
    meshQuadCornerUV: Float32Array[];
    /**
     * IRREGULAR only: per-vertex 3D position within the block ([0,1]³).
     * length = quads.length * 12 (4 corners × 3 floats). zero-filled for
     * other shapes.
     *
     * sodium's irregular blend samples one face cache per axis. each axis
     * derives its bilerp (u, w) and depth from the same 3D position:
     * - x-axis: u = vz, w = vy, depth = nx≥0 ? 1-vx : vx
     * - y-axis: u = vx, w = vz, depth = ny≥0 ? 1-vy : vy
     * - z-axis: u = vx, w = vy, depth = nz≥0 ? 1-vz : vz
     * Storing 12 floats instead of 24 (the old per-axis-UV layout was a
     * redundant copy of the same 3 components).
     */
    meshQuadCornerPos: Float32Array[];
    /**
     * IRREGULAR only: per-vertex (n.x², n.y², n.z²) weights summing to 1.
     * length = quads.length * 12 (4 corners × 3 floats). zero-filled for
     * other shapes. pre-squaring saves a multiply per vert per relight.
     */
    meshQuadCornerNormSq: Float32Array[];

    /**
     * per-quad face normal (nx, ny, nz). length = quads.length * 3. flattens
     * `BlockQuad.normal` into a dense per-mesh table so the mesher hot loop
     * reads typed-array entries instead of indexing into the `BlockQuad`
     * object array. parallel to meshQuads. populated for all mesh quads.
     */
    meshQuadNormal: Float32Array[];

    /**
     * per-vert atlas UV (u, v). length = quads.length * 8 (4 corners × 2).
     * flattens `BlockQuad.uvs` into a dense per-mesh table; when a quad
     * leaves `uvs` undefined we bake in the default
     * `[0,1] [1,1] [1,0] [0,0]` pattern. parallel to meshQuads.
     */
    meshQuadUVs: Float32Array[];

    /**
     * per-vert block-local position (x, y, z) ∈ [0,1]³. length =
     * quads.length * 12 (4 corners × 3). flattens `BlockQuad.verts` so the
     * hot loop emits world-space quad coords from typed-array reads instead
     * of dereferencing the BlockQuad object. parallel to meshQuads.
     */
    meshQuadVerts: Float32Array[];

    // ── collider data ──────────────────────────────────────────────

    /**
     * global state id → dense collider index (0 = cube fast path, 1+ = valid).
     * same indirection pattern as meshId. 0 means unit box (COLLIDER_CUBE),
     * non-zero indexes into colliderShapes[].
     */
    colliderId: Uint16Array;

    /**
     * dense pre-built crashcat shapes. index 0 is unused (sentinel).
     * indexed by colliderId values (1-based). derived from the per-shape
     * data below at registry freeze; this is the source of truth for the
     * KCC + rigid-body narrow-phase.
     */
    colliderShapes: Shape[];

    /**
     * dense per-shape kind, indexed by colliderId. index 0 holds SHAPE_CUBE
     * as a sentinel, collider-id 0 is the cube fast path and never reads
     * shapeAabbs. consumers (e.g. VCC's analytical sweep) read this to
     * dispatch.
     */
    shapeKind: Uint8Array;

    /**
     * dense per-shape AABB list (block-local [0,1]³). populated for
     * shapeKind=SHAPE_AABBS; empty array for cube entries. indexed by
     * colliderId.
     */
    shapeAabbs: AABB[][];

    // ── per-state typed arrays (dense, indexed by stateId) ──────────

    /**
     * global state id → cull type (CullType enum, uint8).
     * NONE=0, SOLID=1, SELF=2, PARTIAL=3.
     */
    cull: Uint8Array;
    /**
     * global state id → dense block type index (Uint16).
     * all states of the same block() share the same blockTypeId.
     * used by the mesher for self-cull comparisons.
     */
    blockTypeId: Uint16Array;
    /**
     * global state id → material type (MaterialType enum, uint8).
     * OPAQUE=0, TRANSLUCENT=1. controls which render pass geometry goes to.
     */
    material: Uint8Array;
    /**
     * global state id → vertex animation type (encoded as uint8).
     * 0 = none, 1 = wave, 2 = sway.
     */
    vertexAnimation: Uint8Array;

    /**
     * global state id → packed light emission (0RGB in uint16).
     * 0 for non-emitting blocks. channels in bits 11..8, 7..4, 3..0.
     */
    lightEmission: Uint16Array;

    /**
     * global state id → light opacity (0-15 in uint8).
     * 0 = transparent to light, 15 = fully opaque.
     */
    lightOpacity: Uint8Array;

    /**
     * global state id → emissive flag (0 or 1 in uint8).
     * 1 = renders at full brightness regardless of surrounding light.
     */
    emissive: Uint8Array;

    /**
     * global state id → bitmask of block flags (BLOCK_FLAG_COLLISION, BLOCK_FLAG_SELECTION, etc.).
     * air/missing/invisible blocks have 0. use bitwise AND to test.
     */
    flags: Uint32Array;

    /**
     * global state id → friction coefficient. multiplied with per-body
     * friction (rigid body / aabb body) to produce contact friction, and
     * with the vcc character controller's `groundDragRate` for grounded
     * motion (values < 1 produce slippery surfaces like ice; values > 1
     * produce grippy surfaces like mud). defaults to 1.0 (no-op multiplier).
     */
    friction: Float32Array;

    /**
     * global state id → restitution (bounciness) coefficient. multiplied
     * with per-body restitution to produce contact restitution. defaults
     * to 0 (no bounce, multiplies any per-body restitution down to zero,
     * matching today's behaviour for non-restitutive blocks).
     */
    restitution: Float32Array;

    /**
     * global state id → liquid viscosity (0..1). only meaningful when
     * BLOCK_FLAG_LIQUID is set. drives swim drag in the character controller.
     */
    liquidViscosity: Float32Array;

    /**
     * global state id → surface height (0..1). only meaningful for
     * MODEL_LIQUID states; the mesher reads this to position the top quad
     * and clip the side quads. 1.0 for everything else (full block).
     */
    surfaceHeight: Float32Array;

    /**
     * global state id → fluid group id (uint16). 0 = not a liquid. all states
     * of a single liquid block share the same group; states from different
     * liquid blocks with the same group string also share it. used by the
     * mesher to cull faces between same-fluid neighbours when surface height
     * allows.
     */
    fluidGroup: Uint16Array;

    /**
     * global state id → screen tint (r,g,b,a) packed as 4 floats per state.
     * indexed as stateId * 4. a (opacity) === 0 means "no tint", the
     * fast path on the per-frame lookup. read by the client renderer when
     * the camera sits inside a block; never touched server-side.
     */
    screenTint: Float32Array;

    /**
     * global state id → sounds config (footstep / dig / break / place).
     * `undefined` for air, missing, and blocks without a sounds option.
     * common case: every state of a block shares the same ref (static
     * `sounds: preset` declarations); per-state authors get distinct refs.
     * read on the footstep hot path via `cc.groundBlockState`.
     */
    sounds: (BlockSoundConfig | undefined)[];

    /**
     * global state id → particles config (dust / build / break slots).
     * `undefined` for `particles: false`, air, missing, and blocks
     * without a cube model + no author-supplied slots. default dust is
     * derived once per block (from default state's model) and shared
     * across every state, see `deriveBlockDust` in blocks.ts.
     */
    particles: (BlockParticleConfig | undefined)[];

    /** global state id → string key (e.g. "oak_log[axis=y]"). air → "air", missing → "". */
    stateToKey: string[];
    /** string key → global state id. */
    keyToState: Map<string, number>;

    /** all unique texture layer entries (including animation frames). */
    textures: string[];
    /** texture id → base atlas layer index. built once at freeze time. */
    textureIndex: Map<string, number>;

    /**
     * per-layer animation metadata. 4 floats per layer, stride=4.
     * layout: [frameCount, fps, interpolate (0 or 1), _pad].
     * indexed as layerIdx * 4. for non-animated layers, frameCount=1.
     * the shader uses this to compute the actual layer to sample.
     */
    texAnimData: Float32Array;

    /**
     * per-layer alpha-cutout flag (1 = used by a TRANSPARENT face/quad). built
     * at freeze time by scanning every cube face and mesh quad. consumed by the
     * mip-pyramid builder, which gives cutout layers coverage-preserving alpha
     * so foliage/glass keeps its silhouette at distance instead of eroding.
     */
    textureCutout: Uint8Array;
};

// ── build ───────────────────────────────────────────────────────────

export function buildBlockRegistry(
    defs: Map<string, BlockDef>,
    handles: Map<string, BlockHandle>,
    blockTextures: Map<string, BlockTextureDef>,
): Blocks {
    const orderedDefs: BlockDef[] = [];
    const orderedHandles: BlockHandle[] = [];
    const idToDef = new Map<string, BlockDef>();
    const idToHandle = new Map<string, BlockHandle>();

    // reserve global state ids 0 (air) and 1 (missing).
    // air must be the first user-registered block. we enforce this by
    // starting user block assignment at USER_BLOCKS_START and special-casing
    // air below.
    let nextStateId = USER_BLOCKS_START;

    // check if air is registered. if so, it gets global id 0 as expected.
    const airDef = defs.get('air');
    const airHandle = handles.get('air');

    if (airDef && airHandle) {
        // air is always block type index 0, global state id 0
        airHandle._index = 0;
        airHandle._baseStateId = AIR;
        orderedDefs.push(airDef);
        orderedHandles.push(airHandle);
        idToDef.set('air', airDef);
        idToHandle.set('air', airHandle);
    }

    // assign remaining blocks
    for (const [id, def] of defs) {
        if (id === 'air') continue; // already handled

        const handle = handles.get(id);
        if (!handle) {
            throw new Error(`[block-registry] no handle for block '${id}'`);
        }

        const index = orderedDefs.length;
        const baseStateId = nextStateId;
        const totalStates = def.states.totalStates;

        handle._index = index;
        handle._baseStateId = baseStateId;
        // intrinsic hook bitmask, observer hooks (onBuild/onBreak/onStateChange)
        // are tracked per-room and not reflected here.
        let hooks = 0;
        if (def.onNeighbourUpdate) hooks |= 1 << 0; // HOOK_ON_NEIGHBOUR_UPDATE
        if (def.onNeighbourChanged) hooks |= 1 << 1; // HOOK_ON_NEIGHBOUR_CHANGED
        handle._hooks = hooks;

        orderedDefs.push(def);
        orderedHandles.push(handle);
        idToDef.set(id, def);
        idToHandle.set(id, handle);

        nextStateId += totalStates;
    }

    const totalStates = nextStateId;

    // build flat lookup tables
    const stateToBlockIndex = new Uint16Array(totalStates);
    const stateToLocalIndex = new Uint16Array(totalStates);

    for (let bi = 0; bi < orderedDefs.length; bi++) {
        const handle = orderedHandles[bi]!;
        for (let local = 0; local < handle.totalStates; local++) {
            const globalId = handle._baseStateId + local;
            stateToBlockIndex[globalId] = bi;
            stateToLocalIndex[globalId] = local;
        }
    }

    // build string key tables
    const stateToKey: string[] = new Array(totalStates).fill('');
    const keyToState = new Map<string, number>();

    // air → 0
    stateToKey[AIR] = 'air';
    keyToState.set('air', AIR);
    // missing (1) has no string key, stateToKey[1] stays ""

    for (let bi = 0; bi < orderedDefs.length; bi++) {
        const def = orderedDefs[bi]!;
        const handle = orderedHandles[bi]!;
        for (let local = 0; local < def.states.totalStates; local++) {
            const globalId = handle._baseStateId + local;
            const key = formatKey(def.id, def.states, local);
            stateToKey[globalId] = key;
            keyToState.set(key, globalId);
        }
    }

    // ── pass 1: build models, collect textures, cull, material, anim ──
    //
    // we need to cache all models first so we can collect textures,
    // build the string→index map, then do pass 2 to bake flat texture
    // index tables for the mesher. models are stored in a temp sparse
    // array indexed by stateId, then compacted into dense mesh arrays.
    //
    // modelTypeTable[stateId] = MODEL_NONE/MODEL_CUBE/MODEL_MESH
    // meshIdTable[stateId]    = dense mesh index (1-based, 0 = not a mesh)
    // cube models are "dissolved", their texture indices go into cubeTexIndices
    // at pass 2 and no BlockModel object is stored in the registry.

    const _tempModels: (BlockModel | undefined)[] = new Array(totalStates);
    const _tempColliderShapes: (Shape | undefined)[] = new Array(totalStates);
    const _tempBlockShapes: (BlockShape | undefined)[] = new Array(totalStates);
    const modelTypeTable = new Uint8Array(totalStates); // MODEL_NONE=0
    const meshIdTable = new Uint16Array(totalStates); // 0 = not a mesh
    const colliderIdTable = new Uint16Array(totalStates); // 0 = cube fast path
    const cullTable = new Uint8Array(totalStates);
    const blockTypeIdTable = new Uint16Array(totalStates);
    const materialTable = new Uint8Array(totalStates);
    const vertexAnimationTable = new Uint8Array(totalStates);
    const lightEmissionTable = new Uint16Array(totalStates);
    const lightOpacityTable = new Uint8Array(totalStates);
    const emissiveTable = new Uint8Array(totalStates);
    const flagsTable = new Uint32Array(totalStates);
    const frictionTable = new Float32Array(totalStates);
    const restitutionTable = new Float32Array(totalStates);
    const liquidViscosityTable = new Float32Array(totalStates);
    const surfaceHeightTable = new Float32Array(totalStates);
    const fluidGroupTable = new Uint16Array(totalStates);
    const screenTintTable = new Float32Array(totalStates * 4);
    const soundsTable: (BlockSoundConfig | undefined)[] = new Array(totalStates);
    const particlesTable: (BlockParticleConfig | undefined)[] = new Array(totalStates);
    // friction defaults to 1.0 for every state; users opt into ice/mud via def.friction.
    frictionTable.fill(1);
    // restitution defaults to 0 (no bounce); users opt in via def.restitution.
    // surface height defaults to 1.0 (full block) for every state; only
    // MODEL_LIQUID states read this, but the default keeps the mesher's
    // fluid-cull check correct for non-liquid neighbours.
    surfaceHeightTable.fill(1);

    // intern fluid group strings → uint16 ids. 0 reserved for "not a liquid".
    const fluidGroupIds = new Map<string, number>();
    let nextFluidGroupId = 1;
    const internFluidGroup = (name: string): number => {
        let id = fluidGroupIds.get(name);
        if (id === undefined) {
            id = nextFluidGroupId++;
            fluidGroupIds.set(name, id);
        }
        return id;
    };
    const textureSet = new Set<string>();
    let meshCount = 0; // number of custom mesh models (for dense mesh arrays)
    let colliderCount = 0; // number of custom collider shapes (for dense collider array)

    // air (0) and missing (1) get CullType.NONE (0), already zero-initialized
    // air/missing light opacity = 0 (transparent), already zero-initialized
    // air (0) is navigable: set PATHFINDABLE explicitly. the reserved air state
    // usually isn't a registered block, so it bypasses the per-block flag loop
    // below (where it would derive from !collision) and its flags stay 0. a
    // positive flag means 0 ≠ passable, so nav would treat air as solid without
    // this. missing (1) intentionally stays non-pathfindable (unknown = blocked).
    flagsTable[AIR] |= BLOCK_FLAG_PATHFINDABLE;

    for (let bi = 0; bi < orderedDefs.length; bi++) {
        const def = orderedDefs[bi]!;
        const handle = orderedHandles[bi]!;

        // default dust handles, derived once per block from the default
        // state's model (state 0). shared across every state of the
        // block as the fallback for missing particle slots, keeps the
        // sprite + particle registry from multiplying by state count.
        // null when `particles: false`, no model, or the model isn't a cube.
        const defaultDust = resolveDefaultDust(def);

        for (let local = 0; local < def.states.totalStates; local++) {
            const globalId = handle._baseStateId + local;
            const props = def.states.decode(local);

            // cache model, classify model type
            if (def.model) {
                const model = def.model(props);
                _tempModels[globalId] = model;
                collectModelTextureIds(model, textureSet);

                if (model.type === 'cube') {
                    // liquids opt into MODEL_LIQUID via def.surfaceHeight; texture
                    // baking still goes through the cube path (6 face textures).
                    modelTypeTable[globalId] = def.surfaceHeight !== undefined ? MODEL_LIQUID : MODEL_CUBE;
                } else {
                    modelTypeTable[globalId] = MODEL_MESH;
                    meshCount++;
                    meshIdTable[globalId] = meshCount; // 1-based
                }
            }

            // resolve cull type (CullType enum values are already numeric)
            const cull = typeof def.cull === 'function' ? def.cull(props) : def.cull;
            cullTable[globalId] = cull;

            // resolve material type
            const mat = typeof def.material === 'function' ? def.material(props) : def.material;
            materialTable[globalId] = mat;

            // block type id (all states of same block share one id)
            blockTypeIdTable[globalId] = handle._index;

            // resolve vertex animation
            if (def.vertexAnimation) {
                const va = typeof def.vertexAnimation === 'function' ? def.vertexAnimation(props) : def.vertexAnimation;
                vertexAnimationTable[globalId] = encodeVertexAnimation(va);
            }

            // resolve light emission
            if (def.lightEmission) {
                const em = typeof def.lightEmission === 'function' ? def.lightEmission(props) : def.lightEmission;
                lightEmissionTable[globalId] = packEmission(em[0], em[1], em[2]);
            }

            // resolve light opacity
            if (def.lightOpacity !== undefined) {
                const op = typeof def.lightOpacity === 'function' ? def.lightOpacity(props) : def.lightOpacity;
                lightOpacityTable[globalId] = op;
            } else {
                lightOpacityTable[globalId] = defaultLightOpacity(cull);
            }

            // resolve emissive
            if (def.emissive) {
                const em = typeof def.emissive === 'function' ? def.emissive(props) : def.emissive;
                emissiveTable[globalId] = em ? 1 : 0;
            }

            // resolve block flags bitmask
            const hasGeometry = modelTypeTable[globalId] !== MODEL_NONE || def.shape !== undefined;
            const collisionVal = typeof def.collision === 'function' ? def.collision(props) : (def.collision ?? true);
            const selectionVal = typeof def.selection === 'function' ? def.selection(props) : (def.selection ?? true);
            const collides = hasGeometry && collisionVal;
            const climbableVal = typeof def.climbable === 'function' ? def.climbable(props) : (def.climbable ?? false);
            const liquidVal = typeof def.liquid === 'function' ? def.liquid(props) : (def.liquid ?? null);
            // pathfindable defaults to the inverse of collision, passable cells
            // (air, plants) are navigable, solid cells are not. authors override
            // to mark colliding-but-passable (open doors) or passable-but-blocked
            // (hazards) for the nav utils.
            const pathfindableVal =
                typeof def.pathfindable === 'function' ? def.pathfindable(props) : (def.pathfindable ?? !collides);
            // sneakGuard defaults true for any collidable block, false otherwise.
            const sneakGuardVal = typeof def.sneakGuard === 'function' ? def.sneakGuard(props) : (def.sneakGuard ?? collides);

            let f = 0;
            if (collides) f |= BLOCK_FLAG_COLLISION;
            if (hasGeometry && selectionVal) f |= BLOCK_FLAG_SELECTION;
            if (climbableVal) f |= BLOCK_FLAG_CLIMBABLE;
            if (liquidVal) f |= BLOCK_FLAG_LIQUID;
            if (sneakGuardVal && collides) f |= BLOCK_FLAG_SNEAK_GUARD;
            if (pathfindableVal) f |= BLOCK_FLAG_PATHFINDABLE;
            if (def.flags) f |= def.flags;
            flagsTable[globalId] = f;

            // resolve friction (defaults to 1.0, already filled)
            if (def.friction !== undefined) {
                const friction = typeof def.friction === 'function' ? def.friction(props) : def.friction;
                frictionTable[globalId] = friction;
            }

            // resolve restitution (defaults to 0, already zero-initialised)
            if (def.restitution !== undefined) {
                const restitution = typeof def.restitution === 'function' ? def.restitution(props) : def.restitution;
                restitutionTable[globalId] = restitution;
            }

            // resolve liquid viscosity (0..1; 0 if not a liquid)
            if (liquidVal) {
                liquidViscosityTable[globalId] = liquidVal.viscosity;
            }

            // resolve surface height (default 1.0 = full cube, already filled)
            if (def.surfaceHeight !== undefined) {
                const h = typeof def.surfaceHeight === 'function' ? def.surfaceHeight(props) : def.surfaceHeight;
                surfaceHeightTable[globalId] = h;
            }

            // resolve fluid group (0 = not a liquid, already zero-initialized)
            if (def.fluidGroup) {
                fluidGroupTable[globalId] = internFluidGroup(def.fluidGroup);
            }

            // resolve screen tint (a===0 = no tint, already zero-initialized)
            if (def.screenTint !== undefined) {
                const spec = typeof def.screenTint === 'function' ? def.screenTint(props) : def.screenTint;
                if (spec) {
                    const off = globalId * 4;
                    screenTintTable[off] = spec.color[0];
                    screenTintTable[off + 1] = spec.color[1];
                    screenTintTable[off + 2] = spec.color[2];
                    screenTintTable[off + 3] = spec.opacity;
                }
            }

            // resolve sounds + particles for this state. fn-or-static
            // option on the def; functions are called per state, static
            // values pass through. particles fall back to per-block
            // `defaultDust` for any slot the author left unset.
            soundsTable[globalId] = resolveBlockSounds(def, props);
            particlesTable[globalId] = resolveBlockParticles(def, props, defaultDust);

            // resolve collider shape. explicit cube collapses to the
            // colliderId=0 fast path, same as no shape. a non-cube shape with no
            // boxes has no collision geometry: assigning it a custom collider would
            // build a zero-child crashcat compound, and castRayVsShape dereferences
            // an undefined child on the next raycast (e.g. the editor cursor). leave
            // such a (degenerate) shape on the fast path so it can never crash.
            if (def.shape) {
                const blockShape = typeof def.shape === 'function' ? def.shape(props) : def.shape;
                if (blockShape.type !== 'cube' && blockShape.boxes.length > 0) {
                    colliderCount++;
                    colliderIdTable[globalId] = colliderCount; // 1-based
                    _tempBlockShapes[globalId] = blockShape;
                    _tempColliderShapes[globalId] = blockShapeToShape(blockShape);
                }
            }
            // else: 0 (cube fast path), already zero-initialized
        }
    }

    // ── build texture layers (expanding animated textures) ────────
    //
    // each unique texture id from models gets atlas layers. static
    // textures get 1 layer. animated textures (multi-frame) get N
    // consecutive layers. textureIndex maps id → base layer index.
    //
    // textures[] is the flat list of layer entries for the atlas builder.
    // for animated frames: "id:0", "id:1", etc. (texture indices, not block state keys). for static: just "id".

    const textureIds = [...textureSet];
    const textures: string[] = [];
    const textureIndex = new Map<string, number>();

    // animation metadata: 4 floats per layer [frameCount, fps, interpolate, pad]
    // we'll build a temp array and convert to Float32Array after
    const animEntries: number[] = [];

    for (const texId of textureIds) {
        const decl = blockTextures.get(texId);
        const baseLayer = textures.length;
        textureIndex.set(texId, baseLayer);

        if (decl && decl.frames.length > 1) {
            // animated: N consecutive layers
            const frameCount = decl.frames.length;
            for (let f = 0; f < frameCount; f++) {
                textures.push(`${texId}:${f}`);
                // each frame layer gets the same anim metadata
                animEntries.push(frameCount, decl.fps, decl.interpolate ? 1 : 0, 0);
            }
        } else {
            // static: 1 layer
            textures.push(texId);
            animEntries.push(1, 0, 0, 0);
        }
    }

    // pad to at least one entry, WebGPU rejects zero-sized storage buffers,
    // and a game with no blocks defined would otherwise produce an empty array.
    if (animEntries.length === 0) animEntries.push(1, 0, 0, 0);
    const texAnimData = new Float32Array(animEntries);

    // per-layer alpha-cutout flag, populated during pass 2 below. marking a
    // base layer also marks its animation frames (consecutive layers), so an
    // animated cutout texture is fully covered.
    const textureCutout = new Uint8Array(textures.length);
    const markCutoutLayer = (baseLayer: number) => {
        const frameCount = texAnimData[baseLayer * 4] || 1;
        for (let f = 0; f < frameCount; f++) textureCutout[baseLayer + f] = 1;
    };

    // ── pass 2: bake flat texture index tables + dense mesh arrays ─────
    //
    // cube models are "dissolved" into cubeTexIndices (stateId × 6 stride).
    // no BlockModel object is stored for cubes, the mesher reads directly
    // from the flat typed array.
    //
    // custom (mesh) models are compacted into dense arrays indexed by
    // meshId (1-based, 0 = sentinel). this avoids holes for air/missing/cubes.

    const cubeTexIndices = new Uint16Array(totalStates * 6);
    const cubeFaceUVs = new Uint8Array(totalStates * 48);

    // canonical face UVs, must mirror chunk-mesher's FACE_UVS order.
    // mesher face index: 0=east, 1=west, 2=up, 3=down, 4=south, 5=north.
    // 8 entries per face: (u,v) × 4 corners.
    const CANONICAL_FACE_UVS = [
        // east, v0(bottom) v1(bottom) v2(top) v3(top)
        0, 1, 1, 1, 1, 0, 0, 0,
        // west
        0, 1, 1, 1, 1, 0, 0, 0,
        // up, top-down, no flip
        0, 0, 0, 1, 1, 1, 1, 0,
        // down, bottom-up, no flip
        0, 0, 0, 1, 1, 1, 1, 0,
        // south
        0, 1, 1, 1, 1, 0, 0, 0,
        // north
        0, 1, 1, 1, 1, 0, 0, 0,
    ];

    // authoring face slot → mesher face index (matches FACE_TEX_OFFSET).
    const FACE_INDEX = { east: 0, west: 1, top: 2, bottom: 3, south: 4, north: 5 } as const;

    // write 8 UVs (4 corners × 2 components) for one face, rotated by
    // `rotation` degrees ccw. corner ordering follows the mesher's quad
    // winding; rotation cycles which canonical corner maps to which vertex.
    function writeFaceUVs(stateBase: number, mesherFace: number, rotation: number) {
        const dst = stateBase + mesherFace * 8;
        const src = mesherFace * 8;
        // each rotation step (90° ccw) shifts the corner-to-vertex mapping
        // by one. shift = 0 → identity; shift = 1 → vertex i gets corner
        // (i+1)%4's UV; shift = 2 → (i+2)%4; shift = 3 → (i+3)%4.
        const shift = ((rotation / 90) | 0) & 3;
        for (let i = 0; i < 4; i++) {
            const srcCorner = (i + shift) & 3;
            cubeFaceUVs[dst + i * 2] = CANONICAL_FACE_UVS[src + srcCorner * 2]!;
            cubeFaceUVs[dst + i * 2 + 1] = CANONICAL_FACE_UVS[src + srcCorner * 2 + 1]!;
        }
    }

    // dense mesh arrays, index 0 is unused sentinel
    const meshQuads: BlockQuad[][] = new Array(meshCount + 1);
    const meshTexIndices: Uint16Array[] = new Array(meshCount + 1);
    const meshQuadMaterials: Uint8Array[] = new Array(meshCount + 1);
    const meshQuadShape: Uint8Array[] = new Array(meshCount + 1);
    const meshQuadFaceDir: Uint8Array[] = new Array(meshCount + 1);
    const meshQuadCullFaceDir: Uint8Array[] = new Array(meshCount + 1);

    // map BlockQuad.cullFace string → mesher face order (0..5).
    // matches FACE_INDEX up top, except cullFace uses 'up'/'down' where
    // FACE_INDEX uses 'top'/'bottom' for the same +y/-y directions.
    const CULL_FACE_TO_DIR: Record<string, number> = {
        east: 0,
        west: 1,
        up: 2,
        down: 3,
        south: 4,
        north: 5,
    };
    const meshQuadDepth: Float32Array[] = new Array(meshCount + 1);
    const meshQuadVertDepth: Float32Array[] = new Array(meshCount + 1);
    const meshQuadVertNormal: Float32Array[] = new Array(meshCount + 1);
    const meshQuadCornerUV: Float32Array[] = new Array(meshCount + 1);
    const meshQuadCornerPos: Float32Array[] = new Array(meshCount + 1);
    const meshQuadCornerNormSq: Float32Array[] = new Array(meshCount + 1);
    const meshQuadNormal: Float32Array[] = new Array(meshCount + 1);
    const meshQuadUVs: Float32Array[] = new Array(meshCount + 1);
    const meshQuadVerts: Float32Array[] = new Array(meshCount + 1);

    // reused per-quad scratch for the shape classifier.
    const _shapeDepthScratch = new Float32Array(4);
    const _shapeNormalScratch = new Float32Array(12);

    for (let sid = 0; sid < totalStates; sid++) {
        const mt = modelTypeTable[sid]!;
        if (mt === MODEL_NONE) {
            // still seed default uvs so air/none reads aren't NaN if some path strays
            const stateBase = sid * 48;
            for (let f = 0; f < 6; f++) writeFaceUVs(stateBase, f, 0);
            continue;
        }

        const model = _tempModels[sid]!;

        if ((mt === MODEL_CUBE || mt === MODEL_LIQUID) && model.type === 'cube') {
            // dissolve cube textures into cubeTexIndices, and bake rotated
            // per-face UVs into cubeFaceUVs.
            const base = sid * 6;
            const uvBase = sid * 48;
            const tex = model.textures;
            if ('all' in tex) {
                const idx = textureIndex.get(resolveTextureRef(tex.all.texture)) ?? 0;
                const rot = tex.all.rotation ?? 0;
                cubeTexIndices[base] = idx; // top
                cubeTexIndices[base + 1] = idx; // bottom
                cubeTexIndices[base + 2] = idx; // north
                cubeTexIndices[base + 3] = idx; // south
                cubeTexIndices[base + 4] = idx; // east
                cubeTexIndices[base + 5] = idx; // west
                for (let f = 0; f < 6; f++) writeFaceUVs(uvBase, f, rot);
            } else if ('sides' in tex) {
                const t = textureIndex.get(resolveTextureRef(tex.top.texture)) ?? 0;
                const b = textureIndex.get(resolveTextureRef(tex.bottom.texture)) ?? 0;
                const s = textureIndex.get(resolveTextureRef(tex.sides.texture)) ?? 0;
                cubeTexIndices[base] = t;
                cubeTexIndices[base + 1] = b;
                cubeTexIndices[base + 2] = s;
                cubeTexIndices[base + 3] = s;
                cubeTexIndices[base + 4] = s;
                cubeTexIndices[base + 5] = s;
                writeFaceUVs(uvBase, FACE_INDEX.top, tex.top.rotation ?? 0);
                writeFaceUVs(uvBase, FACE_INDEX.bottom, tex.bottom.rotation ?? 0);
                const sideRot = tex.sides.rotation ?? 0;
                writeFaceUVs(uvBase, FACE_INDEX.north, sideRot);
                writeFaceUVs(uvBase, FACE_INDEX.south, sideRot);
                writeFaceUVs(uvBase, FACE_INDEX.east, sideRot);
                writeFaceUVs(uvBase, FACE_INDEX.west, sideRot);
            } else {
                cubeTexIndices[base] = textureIndex.get(resolveTextureRef(tex.top.texture)) ?? 0;
                cubeTexIndices[base + 1] = textureIndex.get(resolveTextureRef(tex.bottom.texture)) ?? 0;
                cubeTexIndices[base + 2] = textureIndex.get(resolveTextureRef(tex.north.texture)) ?? 0;
                cubeTexIndices[base + 3] = textureIndex.get(resolveTextureRef(tex.south.texture)) ?? 0;
                cubeTexIndices[base + 4] = textureIndex.get(resolveTextureRef(tex.east.texture)) ?? 0;
                cubeTexIndices[base + 5] = textureIndex.get(resolveTextureRef(tex.west.texture)) ?? 0;
                writeFaceUVs(uvBase, FACE_INDEX.top, tex.top.rotation ?? 0);
                writeFaceUVs(uvBase, FACE_INDEX.bottom, tex.bottom.rotation ?? 0);
                writeFaceUVs(uvBase, FACE_INDEX.north, tex.north.rotation ?? 0);
                writeFaceUVs(uvBase, FACE_INDEX.south, tex.south.rotation ?? 0);
                writeFaceUVs(uvBase, FACE_INDEX.east, tex.east.rotation ?? 0);
                writeFaceUVs(uvBase, FACE_INDEX.west, tex.west.rotation ?? 0);
            }

            // a TRANSPARENT cube cuts out on every face → flag all 6 textures.
            if (materialTable[sid] === MaterialType.TRANSPARENT) {
                for (let f = 0; f < 6; f++) markCutoutLayer(cubeTexIndices[base + f]!);
            }
        } else {
            // mesh / liquid-from-custom: seed default uvs so the array is
            // well-formed across all stateIds. mesh path doesn't read it.
            const stateBase = sid * 48;
            for (let f = 0; f < 6; f++) writeFaceUVs(stateBase, f, 0);
        }

        if (mt === MODEL_MESH && model.type === 'custom') {
            const mid = meshIdTable[sid]!;
            const quads = model.quads;

            // quad-only authoring, validated implicitly by the type
            // (BlockQuad.verts is a 4-tuple). reject empty quad lists.
            if (quads.length === 0) {
                throw new Error(`block ${sid}: custom model has zero quads`);
            }

            meshQuads[mid] = quads;

            // per-quad texture indices
            const indices = new Uint16Array(quads.length);
            for (let i = 0; i < quads.length; i++) {
                indices[i] = textureIndex.get(resolveTextureRef(quads[i]!.texture)) ?? 0;
            }
            meshTexIndices[mid] = indices;

            // per-quad material, always allocate for mesh models.
            // quads without an explicit material get the block's default.
            const defaultMat = materialTable[sid]!;
            const quadMats = new Uint8Array(quads.length);
            for (let i = 0; i < quads.length; i++) {
                quadMats[i] = quads[i]!.material ?? defaultMat;
            }
            meshQuadMaterials[mid] = quadMats;

            // flag textures of any cutout quad so their mips preserve coverage.
            for (let i = 0; i < quads.length; i++) {
                if (quadMats[i] === MaterialType.TRANSPARENT) markCutoutLayer(indices[i]!);
            }

            // per-quad smooth-light shape classification (see classifyMeshQuadShape).
            const qShape = new Uint8Array(quads.length);
            const qFaceDir = new Uint8Array(quads.length);
            const qCullFaceDir = new Uint8Array(quads.length).fill(FACE_DIR_NONE);
            const qDepth = new Float32Array(quads.length);
            const qVertDepth = new Float32Array(quads.length * 4);
            const qVertNormal = new Float32Array(quads.length * 12);
            const qCornerUV = new Float32Array(quads.length * 8);
            const qCornerPos = new Float32Array(quads.length * 12);
            const qCornerNormSq = new Float32Array(quads.length * 12);
            const qNormal = new Float32Array(quads.length * 3);
            const qUVs = new Float32Array(quads.length * 8);
            const qVerts = new Float32Array(quads.length * 12);
            for (let i = 0; i < quads.length; i++) {
                const q = quads[i]!;
                const c = classifyMeshQuadShape(q, _shapeDepthScratch, _shapeNormalScratch);
                qShape[i] = c.shape;
                qFaceDir[i] = c.faceDir;
                if (q.cullFace !== undefined) qCullFaceDir[i] = CULL_FACE_TO_DIR[q.cullFace]!;
                qDepth[i] = c.depth;

                // flatten BlockQuad.normal / uvs / verts into dense per-mesh
                // tables so the mesher hot loop reads typed-array entries
                // instead of indexing into the BlockQuad object array.
                const nBase = i * 3;
                qNormal[nBase] = q.normal[0]!;
                qNormal[nBase + 1] = q.normal[1]!;
                qNormal[nBase + 2] = q.normal[2]!;

                const vBase = i * 12;
                for (let v = 0; v < 4; v++) {
                    const vert = q.verts[v]!;
                    qVerts[vBase + v * 3] = vert[0]!;
                    qVerts[vBase + v * 3 + 1] = vert[1]!;
                    qVerts[vBase + v * 3 + 2] = vert[2]!;
                }
                const uvBase = i * 8;
                const uvs = q.uvs;
                if (uvs !== undefined) {
                    qUVs[uvBase] = uvs[0]![0]!;
                    qUVs[uvBase + 1] = uvs[0]![1]!;
                    qUVs[uvBase + 2] = uvs[1]![0]!;
                    qUVs[uvBase + 3] = uvs[1]![1]!;
                    qUVs[uvBase + 4] = uvs[2]![0]!;
                    qUVs[uvBase + 5] = uvs[2]![1]!;
                    qUVs[uvBase + 6] = uvs[3]![0]!;
                    qUVs[uvBase + 7] = uvs[3]![1]!;
                } else {
                    // default: [0,1] [1,1] [1,0] [0,0]
                    qUVs[uvBase] = 0;
                    qUVs[uvBase + 1] = 1;
                    qUVs[uvBase + 2] = 1;
                    qUVs[uvBase + 3] = 1;
                    qUVs[uvBase + 4] = 1;
                    qUVs[uvBase + 5] = 0;
                    qUVs[uvBase + 6] = 0;
                    qUVs[uvBase + 7] = 0;
                }
                if (c.shape === SHAPE_NON_PARALLEL) {
                    const o = i * 4;
                    qVertDepth[o] = _shapeDepthScratch[0]!;
                    qVertDepth[o + 1] = _shapeDepthScratch[1]!;
                    qVertDepth[o + 2] = _shapeDepthScratch[2]!;
                    qVertDepth[o + 3] = _shapeDepthScratch[3]!;
                } else if (c.shape === SHAPE_IRREGULAR) {
                    const o = i * 12;
                    for (let k = 0; k < 12; k++) qVertNormal[o + k] = _shapeNormalScratch[k]!;
                }

                // per-corner (u, w) on the chosen face plane (ALIGNED_*, PARALLEL,
                // NON_PARALLEL). IRREGULAR has no single face plane → leave zeros
                // and populate the per-axis variant instead. FLAT also unused.
                if (c.shape !== SHAPE_FLAT && c.shape !== SHAPE_IRREGULAR) {
                    const axU = FACE_AXIS_UW[c.faceDir * 2]!;
                    const axW = FACE_AXIS_UW[c.faceDir * 2 + 1]!;
                    const o = i * 8;
                    qCornerUV[o] = q.verts[0]![axU]!;
                    qCornerUV[o + 1] = q.verts[0]![axW]!;
                    qCornerUV[o + 2] = q.verts[1]![axU]!;
                    qCornerUV[o + 3] = q.verts[1]![axW]!;
                    qCornerUV[o + 4] = q.verts[2]![axU]!;
                    qCornerUV[o + 5] = q.verts[2]![axW]!;
                    qCornerUV[o + 6] = q.verts[3]![axU]!;
                    qCornerUV[o + 7] = q.verts[3]![axW]!;
                }

                // IRREGULAR: raw 3D vert position + per-corner squared-normal
                // weights. (u, w) for each of the 3 axis-aligned face planes
                // are derived at sample time from the same 3D position.
                if (c.shape === SHAPE_IRREGULAR) {
                    const pBase = i * 12;
                    const nsBase = i * 12;
                    for (let v = 0; v < 4; v++) {
                        qCornerPos[pBase + v * 3] = q.verts[v]![0]!;
                        qCornerPos[pBase + v * 3 + 1] = q.verts[v]![1]!;
                        qCornerPos[pBase + v * 3 + 2] = q.verts[v]![2]!;

                        const nx = _shapeNormalScratch[v * 3]!;
                        const ny = _shapeNormalScratch[v * 3 + 1]!;
                        const nz = _shapeNormalScratch[v * 3 + 2]!;
                        qCornerNormSq[nsBase + v * 3] = nx * nx;
                        qCornerNormSq[nsBase + v * 3 + 1] = ny * ny;
                        qCornerNormSq[nsBase + v * 3 + 2] = nz * nz;
                    }
                }
            }
            meshQuadShape[mid] = qShape;
            meshQuadFaceDir[mid] = qFaceDir;
            meshQuadCullFaceDir[mid] = qCullFaceDir;
            meshQuadDepth[mid] = qDepth;
            meshQuadVertDepth[mid] = qVertDepth;
            meshQuadVertNormal[mid] = qVertNormal;
            meshQuadCornerUV[mid] = qCornerUV;
            meshQuadCornerPos[mid] = qCornerPos;
            meshQuadCornerNormSq[mid] = qCornerNormSq;
            meshQuadNormal[mid] = qNormal;
            meshQuadUVs[mid] = qUVs;
            meshQuadVerts[mid] = qVerts;
        }
    }

    // ── compact collider shapes + per-shape data into dense arrays ──
    //
    // colliderShapes[] is the crashcat shape consumed by KCC and rigid
    // bodies. shapeKind / shapeAabbs are the source of truth, VCC's
    // analytical sweep reads them directly without touching the crashcat
    // shape.

    const colliderShapes: Shape[] = new Array(colliderCount + 1);
    const shapeKind = new Uint8Array(colliderCount + 1); // index 0 = SHAPE_CUBE sentinel
    const shapeAabbs: AABB[][] = new Array(colliderCount + 1);

    // index 0: cube sentinel, empty per-shape data, never read.
    const _emptyAabbs: AABB[] = [];
    shapeAabbs[0] = _emptyAabbs;

    for (let sid = 0; sid < totalStates; sid++) {
        const cid = colliderIdTable[sid]!;
        if (cid === 0) continue;
        colliderShapes[cid] = _tempColliderShapes[sid]!;
        const bs = _tempBlockShapes[sid]!;
        if (bs.type === 'aabbs') {
            shapeKind[cid] = SHAPE_AABBS;
            shapeAabbs[cid] = bs.boxes;
        }
    }

    return {
        totalStates,
        blockCount: orderedDefs.length,
        defs: orderedDefs,
        idToDef,
        handles: orderedHandles,
        idToHandle,
        stateToBlockIndex,
        stateToLocalIndex,
        modelType: modelTypeTable,
        cubeTexIndices,
        cubeFaceUVs,
        meshId: meshIdTable,
        meshQuads,
        meshTexIndices,
        meshQuadMaterials,
        meshQuadShape,
        meshQuadFaceDir,
        meshQuadCullFaceDir,
        meshQuadDepth,
        meshQuadVertDepth,
        meshQuadVertNormal,
        meshQuadCornerUV,
        meshQuadCornerPos,
        meshQuadCornerNormSq,
        meshQuadNormal,
        meshQuadUVs,
        meshQuadVerts,
        colliderId: colliderIdTable,
        colliderShapes,
        shapeKind,
        shapeAabbs,
        cull: cullTable,
        blockTypeId: blockTypeIdTable,
        material: materialTable,
        vertexAnimation: vertexAnimationTable,
        lightEmission: lightEmissionTable,
        lightOpacity: lightOpacityTable,
        emissive: emissiveTable,
        flags: flagsTable,
        friction: frictionTable,
        restitution: restitutionTable,
        liquidViscosity: liquidViscosityTable,
        surfaceHeight: surfaceHeightTable,
        fluidGroup: fluidGroupTable,
        screenTint: screenTintTable,
        sounds: soundsTable,
        particles: particlesTable,
        stateToKey,
        keyToState,
        textures,
        textureIndex,
        texAnimData,
        textureCutout,
    };
}

/**
 * resolve a string key to a global state id. returns MISSING (1) for unknown keys.
 *
 * fast path: exact match in keyToState.
 *
 * tolerant fallback: if no exact match, parse the key as "blockId[p=v,...]" or
 * "blockId", look up the block def, fill missing props with their default (index 0),
 * ignore unknown props, encode to localIndex and return the global state id. the
 * resolved id is cached in keyToState for subsequent O(1) lookups.
 *
 * this makes resolveKey resilient to schema additions: a key saved with fewer props
 * than the current def (e.g. "oak_log[axis=y]" where the def now has a "waterlogged"
 * prop too) will still resolve correctly.
 */
export function resolveKey(registry: Blocks, key: string): number {
    const cached = registry.keyToState.get(key);
    if (cached !== undefined) return cached;

    // tolerant parse fallback
    const parsed = parseKey(key);
    if (!parsed) return MISSING;

    const def = registry.idToDef.get(parsed.blockId);
    if (!def) return MISSING;

    const handle = registry.idToHandle.get(parsed.blockId);
    if (!handle) return MISSING;

    // start at the block's configured default state (drives `defaultKey()` /
    // `defaultId()`). apply each known prop from the parsed key via .with(),
    // ignoring unknown props and silently skipping invalid values.
    let localIndex = def.defaultLocalIdx ?? 0;
    for (const [name, rawVal] of Object.entries(parsed.props)) {
        const propDef = def.states.props[name];
        if (!propDef) continue; // unknown prop, ignore

        let typedVal: boolean | string | number;
        if (propDef.type === 'bool') {
            typedVal = rawVal === 'true';
        } else if (propDef.type === 'int') {
            const n = parseInt(rawVal, 10);
            if (!Number.isFinite(n)) continue; // bad value → keep default
            typedVal = n;
        } else {
            typedVal = rawVal;
        }

        try {
            localIndex = def.states.with(localIndex, name as never, typedVal as never);
        } catch {
            // invalid value for this prop → keep current localIndex (default)
        }
    }

    const globalId = handle._baseStateId + localIndex;

    // cache for future lookups
    registry.keyToState.set(key, globalId);

    return globalId;
}

// ── helpers ─────────────────────────────────────────────────────────

/** derive the per-block default dust handle set once, from the default
 *  state's model. used as the fallback for any particle slot the author
 *  left unset. returns `null` when the block has no model or opts out
 *  via `particles: false`. cube models slice from the top face; custom
 *  models pick the first upward-facing quad (see `deriveBlockDust`). */
function resolveDefaultDust<P extends PropsDef>(def: BlockDef<P>): readonly ParticleHandle[] | null {
    if (def.particles === false) return null;
    if (!def.model) return null;
    const model = def.model(def.states.decode(0));
    return deriveBlockDust(def.id, model);
}

/** evaluate the sounds option for a single state. static config passes
 *  through (shared ref across all states, common case); function form
 *  is called with decoded props. `undefined` for blocks without any
 *  sounds option. */
function resolveBlockSounds<P extends PropsDef>(def: BlockDef<P>, props: PropsValues<P>): BlockSoundConfig | undefined {
    const opt = def.sounds;
    if (!opt) return undefined;
    return typeof opt === 'function' ? opt(props) : opt;
}

/** evaluate the particles option for a single state. static config or
 *  function-form returns get user-supplied slots filled from
 *  `defaultDust` for whatever the author omitted. `particles: false`
 *  short-circuits to `undefined` for every state. */
function resolveBlockParticles<P extends PropsDef>(
    def: BlockDef<P>,
    props: PropsValues<P>,
    defaultDust: readonly ParticleHandle[] | null,
): BlockParticleConfig | undefined {
    const opt = def.particles;
    if (opt === false) return undefined;

    const user: BlockParticleConfig = typeof opt === 'function' ? opt(props) : (opt ?? {});

    const fallback = defaultDust ?? undefined;
    const dust = user.dust ?? fallback;
    const build = user.build ?? fallback;
    const breakP = user.break ?? fallback;

    if (!dust && !build && !breakP) return undefined;
    return { dust, build, break: breakP };
}
