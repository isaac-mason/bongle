import type { Shape } from 'crashcat';
import type { SpriteHandle } from '../sprites/sprites';
import { type AABB, type BlockShape, blockShapeToShape } from './block-collider';
import type { PropsDef, PropsValues } from './block-state';
import type {
    BlockDef,
    BlockHandle,
    BlockModel,
    BlockParticleConfig,
    BlockQuad,
    BlockSoundConfig,
    TileDef,
    VertexAnimation,
} from './blocks';
import { collectModelTileIds, faceRotation, faceTile, MaterialType } from './blocks';
import { defaultLightOpacity, packEmission } from './light';

/** shape kind enum; matches block-collider's BlockShape['type'] order. */
export const SHAPE_CUBE = 0;
export const SHAPE_AABBS = 1;

/** global state id for air. always 0. */
export const AIR = 0;

/** global state id for missing/unresolved blocks. always 1. */
export const MISSING = 1;

const USER_BLOCKS_START = 2;

// per-id reservation of a block's dense index and state-id range, durable across HMR; a removed id's range is abandoned and handed back on re-declaration, so old palettes still resolve.
type BlockSlot = { index: number; baseStateId: number; totalStates: number };
const blockSlots = new Map<string, BlockSlot>();
let nextBlockIndex = 1;
let nextBlockStateId = USER_BLOCKS_START;

function reserveBlockSlot(id: string, totalStates: number): BlockSlot {
    const existing = blockSlots.get(id);
    if (existing && existing.totalStates === totalStates) return existing;
    const slot: BlockSlot = {
        // identity: kept even when the state range has to move.
        index: existing ? existing.index : nextBlockIndex++,
        baseStateId: nextBlockStateId,
        totalStates,
    };
    nextBlockStateId += totalStates;
    blockSlots.set(id, slot);
    return slot;
}

/** Drop every reservation; test-only, called by `registry._reset()` between cases. */
export function _resetBlockSlots(): void {
    blockSlots.clear();
    nextBlockIndex = 1;
    nextBlockStateId = USER_BLOCKS_START;
}

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

/** block is a door half, identifies the two cells of a door for the get/setDoorOpen utils. */
export const BLOCK_FLAG_DOOR = 1 << 8;

/** a navigating agent may occupy/pass through this cell; defaults to the inverse of collision, overridable via block({ pathfindable }). */
export const BLOCK_FLAG_PATHFINDABLE = 1 << 9;
/** block can hold a hanging block below it even though it is not a full cube (a chain, a fence post). */
export const BLOCK_FLAG_SUPPORTS_HANGING = 1 << 10;

/** Format a string key from a block id, its state schema, and a local state index (e.g. "oak_log[axis=y]"). */
export function formatKey(blockId: string, states: import('./block-state').BlockStateDef, localIndex: number): string {
    const propNames = Object.keys(states.props);
    if (propNames.length === 0) return blockId;
    const decoded = states.decode(localIndex);
    const parts = propNames.map((k) => `${k}=${String((decoded as Record<string, unknown>)[k])}`);
    return `${blockId}[${parts.join(',')}]`;
}

/** Parse a block state key ("stone" or "oak_log[axis=y]") into its block id and raw prop strings; null on bad format. */
export function parseKey(key: string): { blockId: string; props: Record<string, string> } | null {
    const bracket = key.indexOf('[');
    if (bracket === -1) {
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

/** liquid: cube-like geometry with a fractional top surface height (surfaceHeight[stateId]); side quads are height-clipped. */
export const MODEL_LIQUID = 3;

// face indexing (SHAPE_*_FACE quads, meshQuadFaceDir) matches the mesher's face loop order: 0=east(+x), 1=west(-x), 2=up(+y), 3=down(-y), 4=south(+z), 5=north(-z).

/** quad opts out of smooth lighting (ao: false). flat per-cell light. */
export const SHAPE_FLAT = 0;
/** axis-aligned quad covering all 4 corners of a face. direct corner-to-vertex. */
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

// per face direction (0..5) -> (axisU, axisW) in {0=x,1=y,2=z}, stride 2; projects a vert onto the face plane via u=vert[axisU], w=vert[axisW].
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

// classify a mesh quad into a shape tag and gather the per-shape data (face direction, depth, per-vertex depths/normals) the mesher needs.
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

    // axis: 0=x, 1=y, 2=z; positive flag picks face dir 0/2/4, negative picks 1/3/5.
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
            const depth = (d0 + d1 + d2 + d3) * 0.25;
            if (depth < MESH_SHAPE_EPSILON || depth > 1 - MESH_SHAPE_EPSILON) {
                const ua = axis === 0 ? 2 : 0;
                const ub = axis === 1 ? 2 : 1;
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

        outDepthsScratch[0] = d0;
        outDepthsScratch[1] = d1;
        outDepthsScratch[2] = d2;
        outDepthsScratch[3] = d3;
        return { shape: SHAPE_NON_PARALLEL, faceDir, depth: 0 };
    }

    // non-axis-aligned normal: replicate the face normal to all 4 verts.
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

    defs: BlockDef[]; // declaration order, dense; NOT aligned with stateToBlockIndex
    idToDef: Map<string, BlockDef>;
    handles: BlockHandle[]; // keyed by reserved block index (holes for removed ids); use with stateToBlockIndex
    idToHandle: Map<string, BlockHandle>;

    stateToBlockIndex: Uint16Array; // global state id -> dense block type index
    stateToLocalIndex: Uint16Array; // global state id -> local state index within that block

    /** global state id -> model type (MODEL_NONE=0, MODEL_CUBE=1, MODEL_MESH=2, MODEL_LIQUID=3). */
    modelType: Uint8Array;

    /** per-state cube texture indices, stride 6, face order top/bottom/north/south/east/west, indexed as stateId*6+faceIdx. */
    cubeTexIndices: Uint16Array;

    /** per-state cube face UVs, stride 48 (6 faces x 4 corners x 2), rotation-baked, matches the mesher's face emit order. */
    cubeFaceUVs: Uint8Array;

    variantCount: Uint8Array; // global state id -> per-position model variant count; 0 or 1 means none
    /** global state id -> first of `variantCount` consecutive bases (a cubeTexIndices/cubeFaceUVs slot for cubes, a meshId for meshes). */
    variantBase: Uint32Array;
    jitterXz: Uint8Array; // global state id -> max horizontal render offset, in 1/255 of a block
    jitterY: Uint8Array; // global state id -> max downward render offset, in 1/255 of a block

    meshId: Uint16Array; // global state id -> dense mesh index (0 = not a mesh, 1+ = valid)
    meshQuads: BlockQuad[][]; // index 0 is unused (sentinel)
    meshTexIndices: Uint16Array[]; // parallel to meshQuads
    /** dense per-quad material (MaterialType enum); quads without an explicit material get the block's default. parallel to meshQuads. */
    meshQuadMaterials: Uint8Array[];

    meshQuadUnshaded: Uint8Array[]; // per-quad `shade: false` flag (1 = skip directional face shade)

    meshQuadShape: Uint8Array[]; // per-quad shape tag (SHAPE_FLAT..SHAPE_IRREGULAR)
    meshQuadFaceDir: Uint8Array[]; // per-quad primary face direction (0..5, or FACE_DIR_NONE for IRREGULAR)
    meshQuadCullFaceDir: Uint8Array[]; // per-quad cull-face direction (0..5, or FACE_DIR_NONE), pre-resolved from BlockQuad.cullFace
    meshQuadDepth: Float32Array[]; // per-quad uniform inset depth in [0,1]; meaningful for ALIGNED_*/PARALLEL only
    meshQuadVertDepth: Float32Array[]; // length quads.length*4, only populated (else zero) for NON_PARALLEL quads
    meshQuadVertNormal: Float32Array[]; // length quads.length*12, only populated (else zero) for IRREGULAR quads

    meshQuadCornerUV: Float32Array[]; // per-vertex (u,w) on the chosen face plane, length quads.length*8; zero for FLAT/IRREGULAR
    meshQuadCornerPos: Float32Array[]; // IRREGULAR only: per-vertex 3D position in [0,1]^3, length quads.length*12
    meshQuadCornerNormSq: Float32Array[]; // IRREGULAR only: per-vertex (nx^2,ny^2,nz^2) weights summing to 1, length quads.length*12

    meshQuadNormal: Float32Array[]; // length quads.length*3, flattened from BlockQuad.normal
    meshQuadUVs: Float32Array[]; // length quads.length*8, flattened from BlockQuad.uvs (default [0,1][1,1][1,0][0,0])
    meshQuadVerts: Float32Array[]; // length quads.length*12, flattened from BlockQuad.verts

    colliderId: Uint16Array; // global state id -> dense collider index (0 = cube fast path, 1+ indexes colliderShapes)

    /** dense pre-built crashcat shapes, index 0 unused, indexed by colliderId (1-based); source of truth for the KCC + rigid-body narrow-phase. */
    colliderShapes: Shape[];

    shapeKind: Uint8Array; // indexed by colliderId; index 0 holds SHAPE_CUBE as a sentinel
    shapeAabbs: AABB[][]; // block-local [0,1]^3, indexed by colliderId; populated for shapeKind=SHAPE_AABBS

    cull: Uint8Array; // global state id -> cull type (CullType enum, uint8)
    blockTypeId: Uint16Array; // global state id -> dense block type index; all states of one block() share the same value
    material: Uint8Array; // global state id -> material type (MaterialType enum, uint8)
    vertexAnimation: Uint8Array; // global state id -> vertex animation type (VertexAnimation enum, encoded as uint8)

    lightEmission: Uint16Array; // global state id -> packed light emission (0RGB in uint16, channels in bits 11..8/7..4/3..0)
    lightOpacity: Uint8Array; // global state id -> light opacity (0-15 in uint8); 0 = transparent, 15 = fully opaque
    emissive: Uint8Array; // global state id -> emissive flag (0 or 1 in uint8)
    flags: Uint32Array; // global state id -> bitmask of BLOCK_FLAG_* bits

    friction: Float32Array; // global state id -> friction coefficient, multiplied with per-body friction; defaults to 1.0
    restitution: Float32Array; // global state id -> restitution coefficient, multiplied with per-body restitution; defaults to 0
    liquidViscosity: Float32Array; // global state id -> liquid viscosity (0..1); meaningful only when BLOCK_FLAG_LIQUID is set
    surfaceHeight: Float32Array; // global state id -> surface height (0..1); meaningful only for MODEL_LIQUID states, 1.0 elsewhere
    fluidGroup: Uint16Array; // global state id -> fluid group id (uint16); 0 = not a liquid
    screenTint: Float32Array; // global state id -> screen tint (r,g,b,a), stride 4; a===0 means no tint; read client-side only

    sounds: (BlockSoundConfig | undefined)[]; // global state id -> sounds config; undefined for air, missing, and blocks without one
    particles: (BlockParticleConfig | undefined)[]; // global state id -> particles config; undefined for `particles: false` and models with no dust

    /** global state id -> string key (e.g. "oak_log[axis=y]"). air -> "air", missing -> "". */
    stateToKey: string[];
    keyToState: Map<string, number>;

    textures: string[]; // all unique texture layer entries, including animation frames
    textureIndex: Map<string, number>; // texture id -> base atlas layer index

    texAnimData: Float32Array; // stride 4: [frameCount, fps, interpolate(0/1), pad], indexed as layerIdx*4
    textureCutout: Uint8Array; // per-layer alpha-cutout flag (1 = used by a TRANSPARENT face/quad)
};

/** An empty `Blocks`, every field at its real shape, nothing null; pair with `buildBlockRegistry`, which fills one in place. */
// identity matters: holders keep a reference and a rebuild must refill it, not replace it, or they strand on stale-sized tables.
export function createBlockRegistry(): Blocks {
    return {
        totalStates: 0,
        blockCount: 0,
        defs: [],
        idToDef: new Map(),
        handles: [],
        idToHandle: new Map(),
        stateToBlockIndex: new Uint16Array(0),
        stateToLocalIndex: new Uint16Array(0),
        modelType: new Uint8Array(0),
        cubeTexIndices: new Uint16Array(0),
        cubeFaceUVs: new Uint8Array(0),
        variantCount: new Uint8Array(0),
        variantBase: new Uint32Array(0),
        jitterXz: new Uint8Array(0),
        jitterY: new Uint8Array(0),
        meshId: new Uint16Array(0),
        meshQuads: [],
        meshTexIndices: [],
        meshQuadMaterials: [],
        meshQuadUnshaded: [],
        meshQuadShape: [],
        meshQuadFaceDir: [],
        meshQuadCullFaceDir: [],
        meshQuadDepth: [],
        meshQuadVertDepth: [],
        meshQuadVertNormal: [],
        meshQuadCornerUV: [],
        meshQuadCornerPos: [],
        meshQuadCornerNormSq: [],
        meshQuadNormal: [],
        meshQuadUVs: [],
        meshQuadVerts: [],
        colliderId: new Uint16Array(0),
        colliderShapes: [],
        shapeKind: new Uint8Array(0),
        shapeAabbs: [],
        cull: new Uint8Array(0),
        blockTypeId: new Uint16Array(0),
        material: new Uint8Array(0),
        vertexAnimation: new Uint8Array(0),
        lightEmission: new Uint16Array(0),
        lightOpacity: new Uint8Array(0),
        emissive: new Uint8Array(0),
        flags: new Uint32Array(0),
        friction: new Float32Array(0),
        restitution: new Float32Array(0),
        liquidViscosity: new Float32Array(0),
        surfaceHeight: new Float32Array(0),
        fluidGroup: new Uint16Array(0),
        screenTint: new Float32Array(0),
        sounds: [],
        particles: [],
        stateToKey: [],
        keyToState: new Map(),
        textures: [],
        textureIndex: new Map(),
        // one padded entry: WebGPU rejects a zero-sized storage buffer.
        texAnimData: new Float32Array([1, 0, 0, 0]),
        textureCutout: new Uint8Array(0),
    };
}

/** Rebuild `out` from the current block + tile declarations, in place; callers with no registry yet start from `createBlockRegistry()`. */
export function buildBlockRegistry(
    out: Blocks,
    blockDefs: Map<string, BlockDef>,
    blockHandles: Map<string, BlockHandle>,
    tiles: Map<string, TileDef>,
): void {
    const orderedDefs: BlockDef[] = [];
    const orderedHandles: BlockHandle[] = [];
    const idToDef = new Map<string, BlockDef>();
    const idToHandle = new Map<string, BlockHandle>();

    // air is always block type index 0, global state id 0; user blocks start at USER_BLOCKS_START.
    const airDef = blockDefs.get('air');
    const airHandle = blockHandles.get('air');

    if (airDef && airHandle) {
        airHandle._index = 0;
        airHandle._baseStateId = AIR;
        orderedDefs.push(airDef);
        orderedHandles.push(airHandle);
        idToDef.set('air', airDef);
        idToHandle.set('air', airHandle);
    }

    for (const [id, def] of blockDefs) {
        if (id === 'air') continue;

        const handle = blockHandles.get(id);
        if (!handle) {
            throw new Error(`[block-registry] no handle for block '${id}'`);
        }

        const slot = reserveBlockSlot(id, def.states.totalStates);
        const index = slot.index;
        const baseStateId = slot.baseStateId;

        handle._index = index;
        handle._baseStateId = baseStateId;
        // intrinsic hooks only; observer hooks (onBuild/onBreak/onStateChange) are tracked per-room.
        let hooks = 0;
        if (def.onNeighbourUpdate) hooks |= 1 << 0;
        if (def.onNeighbourChanged) hooks |= 1 << 1;
        handle._hooks = hooks;

        // `handles` is keyed by the reserved index, so a removed block leaves a hole rather than shifting the rest down.
        orderedDefs.push(def);
        orderedHandles[index] = handle;
        idToDef.set(id, def);
        idToHandle.set(id, handle);
    }

    const totalStates = nextBlockStateId;

    const stateToBlockIndex = new Uint16Array(totalStates);
    const stateToLocalIndex = new Uint16Array(totalStates);

    for (let bi = 0; bi < orderedHandles.length; bi++) {
        const handle = orderedHandles[bi];
        if (!handle) continue; // reserved index with no live declaration
        for (let local = 0; local < handle.def.states.totalStates; local++) {
            const globalId = handle._baseStateId + local;
            stateToBlockIndex[globalId] = bi;
            stateToLocalIndex[globalId] = local;
        }
    }

    const stateToKey: string[] = new Array(totalStates).fill('');
    const keyToState = new Map<string, number>();

    stateToKey[AIR] = 'air';
    keyToState.set('air', AIR);
    // missing (1) has no string key, stateToKey[1] stays ""

    for (let bi = 0; bi < orderedHandles.length; bi++) {
        const handle = orderedHandles[bi];
        if (!handle) continue; // reserved index with no live declaration
        const def = handle.def;
        for (let local = 0; local < def.states.totalStates; local++) {
            const globalId = handle._baseStateId + local;
            const key = formatKey(def.id, def.states, local);
            stateToKey[globalId] = key;
            keyToState.set(key, globalId);
        }
    }

    // pass 1: cache all models (temp sparse array by stateId) so textures can be collected; pass 2 bakes the dense mesh/texture arrays.
    const _tempModels: (BlockModel | undefined)[] = new Array(totalStates);
    const _tempVariants: (BlockModel[] | undefined)[] = new Array(totalStates);
    const _tempColliderShapes: (Shape | undefined)[] = new Array(totalStates);
    const _tempBlockShapes: (BlockShape | undefined)[] = new Array(totalStates);
    const modelTypeTable = new Uint8Array(totalStates); // MODEL_NONE=0
    const meshIdTable = new Uint16Array(totalStates); // 0 = not a mesh
    // when variantCount > 1 the mesher picks variantBase + (hash & mask) instead of the state's own base.
    const variantCountTable = new Uint8Array(totalStates);
    const variantBaseTable = new Uint32Array(totalStates);
    const jitterXzTable = new Uint8Array(totalStates); // quantised to 1/255 of a block, 0 = none
    const jitterYTable = new Uint8Array(totalStates);
    let extraCubeSlots = 0; // extra cube slots needed beyond one per state, filled in pass 1
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
    frictionTable.fill(1); // default 1.0; users opt into ice/mud via def.friction
    surfaceHeightTable.fill(1); // default full block; only MODEL_LIQUID states read this

    // intern fluid group strings into uint16 ids; 0 reserved for "not a liquid".
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
    let meshCount = 0;
    let colliderCount = 0;

    // air bypasses the per-block flag loop below (it isn't a registered block), so flag it pathfindable explicitly; missing stays blocked.
    flagsTable[AIR] |= BLOCK_FLAG_PATHFINDABLE;

    for (let bi = 0; bi < orderedHandles.length; bi++) {
        const handle = orderedHandles[bi];
        if (!handle) continue; // reserved index with no live declaration
        const def = handle.def;

        // shared fallback for any particle slot the author left unset, derived once per block from its default state's model.
        const defaultDust = handle._defaultDust;

        for (let local = 0; local < def.states.totalStates; local++) {
            const globalId = handle._baseStateId + local;
            const props = def.states.decode(local);

            if (def.model) {
                const produced = def.model(props);
                const models = Array.isArray(produced) ? produced : [produced];
                if (models.length === 0) {
                    throw new Error(`block ${def.id}: model returned an empty variant list`);
                }
                const head = models[0]!;
                for (const variant of models) {
                    if (variant.type !== head.type) {
                        throw new Error(
                            `block ${def.id}: variant list mixes '${head.type}' and '${variant.type}' models; ` +
                                `every entry must share a type, since the mesher picks one path for the block`,
                        );
                    }
                    collectModelTileIds(variant, textureSet);
                }
                _tempModels[globalId] = head;
                _tempVariants[globalId] = models.length > 1 ? models : undefined;
                if (models.length > 1) variantCountTable[globalId] = models.length;

                if (head.type === 'cube') {
                    // liquids opt into MODEL_LIQUID via def.surfaceHeight; tile baking still goes through the cube path.
                    modelTypeTable[globalId] = def.surfaceHeight !== undefined ? MODEL_LIQUID : MODEL_CUBE;
                    if (models.length > 1) {
                        // all N go in the appended region so `base + v` stays contiguous.
                        variantBaseTable[globalId] = totalStates + extraCubeSlots;
                        extraCubeSlots += models.length;
                    }
                } else {
                    modelTypeTable[globalId] = MODEL_MESH;
                    meshIdTable[globalId] = meshCount + 1; // 1-based
                    variantBaseTable[globalId] = meshCount + 1;
                    meshCount += models.length;
                }
            }

            if (def.jitter) {
                jitterXzTable[globalId] = Math.round(Math.min(Math.max(def.jitter.xz ?? 0, 0), 1) * 255);
                jitterYTable[globalId] = Math.round(Math.min(Math.max(def.jitter.y ?? 0, 0), 1) * 255);
            }

            const cull = typeof def.cull === 'function' ? def.cull(props) : def.cull;
            cullTable[globalId] = cull;

            const mat = typeof def.material === 'function' ? def.material(props) : def.material;
            materialTable[globalId] = mat;

            blockTypeIdTable[globalId] = handle._index;

            if (def.vertexAnimation) {
                const va = typeof def.vertexAnimation === 'function' ? def.vertexAnimation(props) : def.vertexAnimation;
                vertexAnimationTable[globalId] = encodeVertexAnimation(va);
            }

            if (def.lightEmission) {
                const em = typeof def.lightEmission === 'function' ? def.lightEmission(props) : def.lightEmission;
                lightEmissionTable[globalId] = packEmission(em[0], em[1], em[2]);
            }

            if (def.lightOpacity !== undefined) {
                const op = typeof def.lightOpacity === 'function' ? def.lightOpacity(props) : def.lightOpacity;
                lightOpacityTable[globalId] = op;
            } else {
                lightOpacityTable[globalId] = defaultLightOpacity(cull);
            }

            if (def.emissive) {
                const em = typeof def.emissive === 'function' ? def.emissive(props) : def.emissive;
                emissiveTable[globalId] = em ? 1 : 0;
            }

            const hasGeometry = modelTypeTable[globalId] !== MODEL_NONE || def.shape !== undefined;
            const collisionVal = typeof def.collision === 'function' ? def.collision(props) : (def.collision ?? true);
            const selectionVal = typeof def.selection === 'function' ? def.selection(props) : (def.selection ?? true);
            const collides = hasGeometry && collisionVal;
            const climbableVal = typeof def.climbable === 'function' ? def.climbable(props) : (def.climbable ?? false);
            const liquidVal = typeof def.liquid === 'function' ? def.liquid(props) : (def.liquid ?? null);
            const pathfindableVal =
                typeof def.pathfindable === 'function' ? def.pathfindable(props) : (def.pathfindable ?? !collides);
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

            if (def.friction !== undefined) {
                const friction = typeof def.friction === 'function' ? def.friction(props) : def.friction;
                frictionTable[globalId] = friction;
            }

            if (def.restitution !== undefined) {
                const restitution = typeof def.restitution === 'function' ? def.restitution(props) : def.restitution;
                restitutionTable[globalId] = restitution;
            }

            if (liquidVal) {
                liquidViscosityTable[globalId] = liquidVal.viscosity;
            }

            if (def.surfaceHeight !== undefined) {
                const h = typeof def.surfaceHeight === 'function' ? def.surfaceHeight(props) : def.surfaceHeight;
                surfaceHeightTable[globalId] = h;
            }

            if (def.fluidGroup) {
                fluidGroupTable[globalId] = internFluidGroup(def.fluidGroup);
            }

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

            soundsTable[globalId] = resolveBlockSounds(def, props);
            particlesTable[globalId] = resolveBlockParticles(def, props, defaultDust);

            // a non-cube shape with no boxes gets no collider: a zero-child crashcat compound would crash raycasts, so it stays on the cube fast path.
            let blockShape: BlockShape | undefined;
            if (def.shape) {
                blockShape = typeof def.shape === 'function' ? def.shape(props) : def.shape;
            } else if (liquidVal && surfaceHeightTable[globalId]! < 1) {
                // a shallow liquid's true volume is the [0..surfaceHeight] band; give it that shape for overlap/selection even though it doesn't collide.
                blockShape = { type: 'aabbs', boxes: [[0, 0, 0, 1, surfaceHeightTable[globalId]!, 1]] };
            }
            if (blockShape && blockShape.type !== 'cube' && blockShape.boxes.length > 0) {
                colliderCount++;
                colliderIdTable[globalId] = colliderCount; // 1-based
                _tempBlockShapes[globalId] = blockShape;
                _tempColliderShapes[globalId] = blockShapeToShape(blockShape);
            }
        }
    }

    // `textures[]` is the flat per-frame layer list for the atlas builder ("id:0", "id:1", ... for animated, just "id" for static).
    const textureIds = [...textureSet];
    const textures: string[] = [];
    const textureIndex = new Map<string, number>();

    const animEntries: number[] = []; // 4 floats per layer: [frameCount, fps, interpolate, pad]

    for (const texId of textureIds) {
        const decl = tiles.get(texId);
        const baseLayer = textures.length;
        textureIndex.set(texId, baseLayer);

        if (decl && decl.frames.length > 1) {
            const frameCount = decl.frames.length;
            for (let f = 0; f < frameCount; f++) {
                textures.push(`${texId}:${f}`);
                animEntries.push(frameCount, decl.fps, decl.interpolate ? 1 : 0, 0);
            }
        } else {
            textures.push(texId);
            animEntries.push(1, 0, 0, 0);
        }
    }

    // pad to at least one entry, WebGPU rejects zero-sized storage buffers.
    if (animEntries.length === 0) animEntries.push(1, 0, 0, 0);
    const texAnimData = new Float32Array(animEntries);

    // marking a base layer also marks its animation frames, so an animated cutout texture is fully covered.
    const textureCutout = new Uint8Array(textures.length);
    const markCutoutLayer = (baseLayer: number) => {
        const frameCount = texAnimData[baseLayer * 4] || 1;
        for (let f = 0; f < frameCount; f++) textureCutout[baseLayer + f] = 1;
    };

    // cube models dissolve into cubeTexIndices (stateId*6 stride); custom models compact into dense arrays indexed by meshId (1-based, 0 = sentinel).
    // variant slots live past the per-state region: slot < totalStates is a state's own, slots above are its variant copies.
    const cubeSlotCount = totalStates + extraCubeSlots;
    const cubeTexIndices = new Uint16Array(cubeSlotCount * 6);
    const cubeFaceUVs = new Uint8Array(cubeSlotCount * 48);

    // canonical face UVs, must mirror chunk-mesher's FACE_UVS order; mesher face index 0=east,1=west,2=up,3=down,4=south,5=north, 8 entries (u,v)x4 corners per face.
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

    // authoring face slot -> mesher face index (matches FACE_TEX_OFFSET).
    const FACE_INDEX = { east: 0, west: 1, top: 2, bottom: 3, south: 4, north: 5 } as const;

    // writes 8 UVs (4 corners x 2) for one face, rotated by `rotation` degrees ccw via a corner-to-vertex shift.
    function writeFaceUVs(stateBase: number, mesherFace: number, rotation: number) {
        const dst = stateBase + mesherFace * 8;
        const src = mesherFace * 8;
        const shift = ((rotation / 90) | 0) & 3;
        for (let i = 0; i < 4; i++) {
            const srcCorner = (i + shift) & 3;
            cubeFaceUVs[dst + i * 2] = CANONICAL_FACE_UVS[src + srcCorner * 2]!;
            cubeFaceUVs[dst + i * 2 + 1] = CANONICAL_FACE_UVS[src + srcCorner * 2 + 1]!;
        }
    }

    // dense mesh arrays, index 0 is unused sentinel.
    const meshQuads: BlockQuad[][] = new Array(meshCount + 1);
    const meshTexIndices: Uint16Array[] = new Array(meshCount + 1);
    const meshQuadMaterials: Uint8Array[] = new Array(meshCount + 1);
    const meshQuadUnshaded: Uint8Array[] = new Array(meshCount + 1);
    const meshQuadShape: Uint8Array[] = new Array(meshCount + 1);
    const meshQuadFaceDir: Uint8Array[] = new Array(meshCount + 1);
    const meshQuadCullFaceDir: Uint8Array[] = new Array(meshCount + 1);

    // maps BlockQuad.cullFace to mesher face order; matches FACE_INDEX but uses 'up'/'down' instead of 'top'/'bottom'.
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
            // once per variant, into consecutive slots; a state with no variants runs once against its own slot (`sid`).
            const cubeVariants = _tempVariants[sid];
            const cubeVariantCount = cubeVariants?.length ?? 1;
            const cubeSlot0 = cubeVariants ? variantBaseTable[sid]! : sid;
            for (let v = 0; v < cubeVariantCount; v++) {
                const slot = cubeSlot0 + v;
                const base = slot * 6;
                const uvBase = slot * 48;
                const t = ((cubeVariants ? cubeVariants[v]! : model) as Extract<BlockModel, { type: 'cube' }>).tiles;
                if ('all' in t) {
                    const idx = textureIndex.get(faceTile(t.all).id) ?? 0;
                    const rot = faceRotation(t.all);
                    cubeTexIndices[base] = idx; // top
                    cubeTexIndices[base + 1] = idx; // bottom
                    cubeTexIndices[base + 2] = idx; // north
                    cubeTexIndices[base + 3] = idx; // south
                    cubeTexIndices[base + 4] = idx; // east
                    cubeTexIndices[base + 5] = idx; // west
                    for (let f = 0; f < 6; f++) writeFaceUVs(uvBase, f, rot);
                } else if ('sides' in t) {
                    const top = textureIndex.get(faceTile(t.top).id) ?? 0;
                    const bottom = textureIndex.get(faceTile(t.bottom).id) ?? 0;
                    const side = textureIndex.get(faceTile(t.sides).id) ?? 0;
                    cubeTexIndices[base] = top;
                    cubeTexIndices[base + 1] = bottom;
                    cubeTexIndices[base + 2] = side;
                    cubeTexIndices[base + 3] = side;
                    cubeTexIndices[base + 4] = side;
                    cubeTexIndices[base + 5] = side;
                    writeFaceUVs(uvBase, FACE_INDEX.top, faceRotation(t.top));
                    writeFaceUVs(uvBase, FACE_INDEX.bottom, faceRotation(t.bottom));
                    const sideRot = faceRotation(t.sides);
                    writeFaceUVs(uvBase, FACE_INDEX.north, sideRot);
                    writeFaceUVs(uvBase, FACE_INDEX.south, sideRot);
                    writeFaceUVs(uvBase, FACE_INDEX.east, sideRot);
                    writeFaceUVs(uvBase, FACE_INDEX.west, sideRot);
                } else {
                    cubeTexIndices[base] = textureIndex.get(faceTile(t.top).id) ?? 0;
                    cubeTexIndices[base + 1] = textureIndex.get(faceTile(t.bottom).id) ?? 0;
                    cubeTexIndices[base + 2] = textureIndex.get(faceTile(t.north).id) ?? 0;
                    cubeTexIndices[base + 3] = textureIndex.get(faceTile(t.south).id) ?? 0;
                    cubeTexIndices[base + 4] = textureIndex.get(faceTile(t.east).id) ?? 0;
                    cubeTexIndices[base + 5] = textureIndex.get(faceTile(t.west).id) ?? 0;
                    writeFaceUVs(uvBase, FACE_INDEX.top, faceRotation(t.top));
                    writeFaceUVs(uvBase, FACE_INDEX.bottom, faceRotation(t.bottom));
                    writeFaceUVs(uvBase, FACE_INDEX.north, faceRotation(t.north));
                    writeFaceUVs(uvBase, FACE_INDEX.south, faceRotation(t.south));
                    writeFaceUVs(uvBase, FACE_INDEX.east, faceRotation(t.east));
                    writeFaceUVs(uvBase, FACE_INDEX.west, faceRotation(t.west));
                }

                if (materialTable[sid] === MaterialType.TRANSPARENT) {
                    for (let f = 0; f < 6; f++) markCutoutLayer(cubeTexIndices[base + f]!);
                }
            }
        } else {
            // mesh / liquid-from-custom: seed default uvs so the array stays well-formed; the mesh path doesn't read it.
            const stateBase = sid * 48;
            for (let f = 0; f < 6; f++) writeFaceUVs(stateBase, f, 0);
        }

        if (mt === MODEL_MESH && model.type === 'custom') {
            // once per variant, into consecutive meshIds starting at meshIdTable[sid].
            const meshVariants = _tempVariants[sid];
            const meshVariantCount = meshVariants?.length ?? 1;
            const mid0 = meshIdTable[sid]!;
            for (let v = 0; v < meshVariantCount; v++) {
                const mid = mid0 + v;
                const quads = ((meshVariants ? meshVariants[v]! : model) as Extract<BlockModel, { type: 'custom' }>).quads;

                if (quads.length === 0) {
                    throw new Error(`block ${sid}: custom model has zero quads`);
                }

                meshQuads[mid] = quads;

                const indices = new Uint16Array(quads.length);
                for (let i = 0; i < quads.length; i++) {
                    indices[i] = textureIndex.get(quads[i]!.tile.id) ?? 0;
                }
                meshTexIndices[mid] = indices;

                // quads without an explicit material get the block's default.
                const defaultMat = materialTable[sid]!;
                const quadMats = new Uint8Array(quads.length);
                for (let i = 0; i < quads.length; i++) {
                    quadMats[i] = quads[i]!.material ?? defaultMat;
                }
                meshQuadMaterials[mid] = quadMats;

                const quadUnshaded = new Uint8Array(quads.length);
                for (let i = 0; i < quads.length; i++) quadUnshaded[i] = quads[i]!.shade === false ? 1 : 0;
                meshQuadUnshaded[mid] = quadUnshaded;

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

                    // flatten BlockQuad.normal/uvs/verts into dense per-mesh tables so the mesher hot loop reads typed arrays, not objects.
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

                    // per-corner (u, w) on the chosen face plane; IRREGULAR has no single face plane, so it's left zero here.
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

                    // IRREGULAR: raw 3D vert position + per-corner squared-normal weights, sampled per-axis at relight time.
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
    }

    // colliderShapes[] is the crashcat shape for KCC/rigid bodies; VCC's analytical sweep reads shapeKind/shapeAabbs directly instead.
    const colliderShapes: Shape[] = new Array(colliderCount + 1);
    const shapeKind = new Uint8Array(colliderCount + 1); // index 0 = SHAPE_CUBE sentinel
    const shapeAabbs: AABB[][] = new Array(colliderCount + 1);

    const _emptyAabbs: AABB[] = []; // index 0: cube sentinel, never read

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

    // one assign over the complete field set; `Blocks` has no optional fields, so TS proves nothing from the previous build is left behind.
    Object.assign(out, {
        totalStates,
        blockCount: nextBlockIndex,
        defs: orderedDefs,
        idToDef,
        handles: orderedHandles,
        idToHandle,
        stateToBlockIndex,
        stateToLocalIndex,
        modelType: modelTypeTable,
        cubeTexIndices,
        cubeFaceUVs,
        variantCount: variantCountTable,
        variantBase: variantBaseTable,
        jitterXz: jitterXzTable,
        jitterY: jitterYTable,
        meshId: meshIdTable,
        meshQuads,
        meshTexIndices,
        meshQuadMaterials,
        meshQuadUnshaded,
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
    } satisfies Blocks);
}

/** Resolve a string key to a global state id, falling back to a tolerant reparse (missing/unknown props filled/ignored) and caching the result; MISSING for unresolvable keys. */
export function resolveKey(registry: Blocks, key: string): number {
    const cached = registry.keyToState.get(key);
    if (cached !== undefined) return cached;

    const parsed = parseKey(key);
    if (!parsed) return MISSING;

    const def = registry.idToDef.get(parsed.blockId);
    if (!def) return MISSING;

    const handle = registry.idToHandle.get(parsed.blockId);
    if (!handle) return MISSING;

    let localIndex = def.defaultLocalIdx ?? 0;
    for (const [name, rawVal] of Object.entries(parsed.props)) {
        const propDef = def.states.props[name];
        if (!propDef) continue; // unknown prop, ignore

        let typedVal: boolean | string | number;
        if (propDef.type === 'bool') {
            typedVal = rawVal === 'true';
        } else if (propDef.type === 'int') {
            const n = parseInt(rawVal, 10);
            if (!Number.isFinite(n)) continue; // bad value, keep default
            typedVal = n;
        } else {
            typedVal = rawVal;
        }

        try {
            localIndex = def.states.with(localIndex, name as never, typedVal as never);
        } catch {
            // invalid value for this prop, keep current localIndex
        }
    }

    const globalId = handle._baseStateId + localIndex;
    registry.keyToState.set(key, globalId);

    return globalId;
}

/** Map a global state id to the block handle that owns it; air and unresolved (stale, pre-rebuild) states resolve to the air handle. */
export function stateToBlock(registry: Blocks, state: number): BlockHandle {
    return registry.handles[registry.stateToBlockIndex[state] ?? 0] ?? registry.handles[0]!;
}

/** Map a block key to its block handle, ignoring block-state; prefer `stateToBlock` in hot paths to skip the key-string resolve. */
export function keyToBlock(registry: Blocks, key: string): BlockHandle {
    return stateToBlock(registry, resolveKey(registry, key));
}

/** Evaluate the sounds option for a single state; undefined for blocks without one. */
function resolveBlockSounds<P extends PropsDef>(def: BlockDef<P>, props: PropsValues<P>): BlockSoundConfig | undefined {
    const opt = def.sounds;
    if (!opt) return undefined;
    return typeof opt === 'function' ? opt(props) : opt;
}

/** Evaluate the particles option for a single state, filling unset slots from `defaultDust`; `particles: false` short-circuits to undefined. */
function resolveBlockParticles<P extends PropsDef>(
    def: BlockDef<P>,
    props: PropsValues<P>,
    defaultDust: readonly SpriteHandle[] | null,
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

/** the world-space bounds of the block state at a voxel: the unit cell for cubes, the union of its collider boxes otherwise. */
export function blockStateAabb(
    blocks: Pick<Blocks, 'colliderId' | 'shapeAabbs'>,
    stateId: number,
    wx: number,
    wy: number,
    wz: number,
): [number, number, number, number, number, number] {
    const cid = blocks.colliderId[stateId]!;
    if (cid === 0) return [wx, wy, wz, wx + 1, wy + 1, wz + 1];
    const boxes = blocks.shapeAabbs[cid];
    if (!boxes || boxes.length === 0) return [wx, wy, wz, wx + 1, wy + 1, wz + 1];
    let nx = Infinity;
    let ny = Infinity;
    let nz = Infinity;
    let xx = -Infinity;
    let xy = -Infinity;
    let xz = -Infinity;
    for (const b of boxes) {
        if (b[0] < nx) nx = b[0];
        if (b[1] < ny) ny = b[1];
        if (b[2] < nz) nz = b[2];
        if (b[3] > xx) xx = b[3];
        if (b[4] > xy) xy = b[4];
        if (b[5] > xz) xz = b[5];
    }
    return [wx + nx, wy + ny, wz + nz, wx + xx, wy + xy, wz + xz];
}
