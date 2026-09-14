// mesher:
//
//   cube, hardcoded 6 quads per block. face culling via the
//            registry's cull table + blockTypeId for self-cull.
//            texture indices from pre-baked cubeTexIndices flat array.
//            routed to opaque/translucent by material table.
//            hot path
//
//   mesh, iterates dense per-mesh tables (meshQuadNormal / UVs / Verts /
//            Shape / FaceDir / ...) keyed by meshId,
//            checks cullFace per tri,
//            texture indices from registry's meshTexIndices.
//            per-quad material routing via meshQuadMaterials.
//            used for stairs, slopes, vegetation, etc.
//
// design principles (inspired by minetest content_mapblock.cpp):
//   - zero object allocations in the mesh loop
//   - zero Map lookups or string comparisons
//   - all texture resolution done at registry build time
//   - geometry constants stored as flat typed arrays
//   - slab prepass resolves palette → global state id once
//
// uses an 18x18x18 padded slab so the inner meshing loop has zero chunk boundary lookups
//
// mesh + light unified (Sodium-derived, but not Sodium-identical):
//
//   meshChunk emits geometry, AO, and smooth light in a single pass.
//   Both block-id and packed light are pulled from eager 18³ slabs
//   (`_slab`, `_blockLightSlab`) built by `buildSlabs` from the chunk
//   + its 26 neighbours. AO is a 4-bit raw level per corner packed
//   into the meta word; smooth light is 4 u32/quad (RGB+sky) written
//   Light is NOT baked into quads: every consumer samples the GPU light
//   diagFlip decision lives in `light[0]` bit 29, set at emit time.
//   Any light change reruns the full mesher, there is no
//   relight-only fast path (worker pool absorbs the cost).
//
// divergences from Sodium worth noting:
//
//   D3, AO is folded into the flags word, not a separate GPU buffer.
//        Sodium writes a per-vertex shade float into the vertex stream.
//        we pack 2 bits/corner (raw 0..3 level) into the spare top
//        byte of `flags` and let the shader map through a 4-entry
//        AO_FACTORS LUT (0.5/0.7/0.85/1.0). saves an entire u32/quad
//        of GPU bandwidth at the cost of 4-level quantization for the
//        few mesh-quad paths that previously held a smoother float.

import type { Blocks } from './block-registry';
import {
    AIR,
    FACE_DIR_NONE,
    MISSING,
    MODEL_CUBE,
    MODEL_LIQUID,
    MODEL_MESH,
    MODEL_NONE,
    SHAPE_ALIGNED_FULL,
    SHAPE_FLAT,
    SHAPE_IRREGULAR,
    SHAPE_NON_PARALLEL,
} from './block-registry';
import { CHUNK_BITS, CHUNK_SIZE, getChunk, neighbourSlot, type Voxels, voxelIndex } from './voxels';

const SLAB_SIZE = CHUNK_SIZE + 2; // 18
const SLAB_SIZE_SQ = SLAB_SIZE * SLAB_SIZE; // 324
const SLAB_VOLUME = SLAB_SIZE * SLAB_SIZE * SLAB_SIZE; // 5832

// slab axis strides for neighbor checks
const SLAB_STRIDE_X = 1;
const SLAB_STRIDE_Y = SLAB_SIZE_SQ; // 324
const SLAB_STRIDE_Z = SLAB_SIZE; // 18

// stores global state ids. allocated once, reused across mesh calls.
const _slab = new Uint32Array(SLAB_VOLUME);

// Packed chunk.light values for the 18³ slab, same u16 sky4|R4|G4|B4
// layout as `Chunk.light`, eagerly populated by `buildSlabs` in the same
// neighbour walk that fills `_slab`. Missing-neighbour cells default to
// `PACKED_LIGHT_SKY_FULL` (sky=15, RGB=0) so absent borders read as
// sky-lit air through `readLightCellByIdx`.
const _blockLightSlab = new Uint16Array(SLAB_VOLUME);

// Sodium-style packed light word, returned by `readLightCellByIdx`.
// Layout:
//   bits  0..3   R                       (4-bit value in low nibble of byte 0)
//   bits  4..7   reserved (carry guard)
//   bits  8..11  G                       (byte 1)
//   bits 12..15  reserved
//   bits 16..19  B                       (byte 2)
//   bits 20..23  reserved
//   bits 24..27  sky                     (byte 3)
//   bits 28      opaque flag (mirror of `cullTable[stateId] === CULL_SOLID`,
//                used for Sodium-style diagonal substitution during the
//                per-corner light average, not light data itself)
//   bits 29..31  reserved (future: AO, emissive, full-cube, mirrors Sodium
//                LightDataAccess word)
//
// Light channels are expanded to byte lanes so 4 cells can be summed in one
// packed-byte add (max sum 60 per lane < 256 → no carry). `blendCornerBrightness`
// drops the per-channel unpack work to a single mask.

const CULL_NONE = 0;
const CULL_SOLID = 1;
const CULL_SELF = 2;

// material type constants (match MaterialType enum in blocks.ts)
const MAT_TRANSPARENT = 1;
const MAT_TRANSLUCENT = 2;

/**
 * THE MESHER NO LONGER BAKES LIGHT. It once wrote a packed u32 per quad corner,
 * rebuilt by relight from the chunk's slabs; that is gone. Light lives in the
 * light-volume texture and is sampled per fragment (`voxel-light-sample`), which
 * is why a relight no longer touches quad data at all.
 *
 * The volume's format is NOT the old per-corner one: cells are u16 with 4-bit
 * RGB+sky nibbles, two cells to a u32, plus a trailing solidity bitset per tile.
 * See `light-lattice` for the writer and `voxel-light-sample` for the reader.
 */

/** unified all-quads per-pass output. cubes, custom-model quads, and
 *  liquid quads all emit into this single format. quad-pull layout:
 *  the VS draws 6 verts/quad non-indexed, decoding cornerIdx via
 *  (vertexIndex % 6) → {0,1,2,0,2,3} (or {0,1,3,1,2,3} when diagFlip).
 *
 *  per-quad stride = 52 B (13 × u32), geometry only - there is no light here,
 *  see the note above:
 *      u32[0..5]  pos: u16×3 per corner × 4 corners, chunk-local voxels encoded
 *                 as `(v + 8) * 2048`, i.e. the range [-8, +24) at 1/2048 voxel.
 *                 The range OVERHANGS the chunk on every side so a model can
 *                 reach past its own cell and past the chunk itself - leaning
 *                 foliage, wide overhangs - where a u8 over [0, 16] clamped it
 *                 flat at the boundary. Sodium spends 20 bits an axis over
 *                 [-8, +24] for the same reason; this is the same range at half
 *                 the cost. 2048 is a power of two, so every 1/16 authoring
 *                 position lands on an exact integer (2048/16 = 128) and chunk
 *                 seams stay watertight.
 *      u32[6]     normal oct16 in low 16 bits |
 *                 blockLocal: x(4b) at <<16 | y(4b) at <<20 | z(4b) at <<24 |
 *                 stackOffset(4b) reserved at <<28 (v2 stacked-sway)
 *      u32[7..10] uvAnchor[0..3]: 4 × packUV (u16 u + u16 v per corner)
 *      u32[11]    flags: texIndex 16 | animType 4 | facing 3 | emissive 1 | unshaded 1 |
 *                        reserved 8. bit 23 is emissive; it was the bake-time
 *                        diagFlip before that moved to the meta word.
 *      u32[12]    meta: aoPacked 16 (4 bits/corner: ao0 | ao1<<4 |
 *                        ao2<<8 | ao3<<12) | diagFlip 1 (bit 16,
 *                        `QUAD_META_DIAG_FLIP_BIT`) | reserved 15. each AO is
 *                        `round((brightness - 0.5) * 30)` in [0..15],
 *                        recovers via `bits/30 + 0.5` in the shader.
 *
 *  The shader multiplies light by AO at draw time; the 4-bit AO level per
 *  corner lives in the low 16 bits of the meta word. AO is bake-once
 *  geometry, never touched by relight.
 *  faceOffsets/faceCounts split the quads into 7 facing slices:
 *  0..5 = +X,-X,+Y,-Y,+Z,-Z; 6 = UNASSIGNED (model quads with non-axis-
 *  aligned normals). Sum of faceCounts == quadCount. */
export type PassMesh = {
    quads: Uint32Array;
    quadCount: number;
    faceOffsets: [number, number, number, number, number, number, number];
    faceCounts: [number, number, number, number, number, number, number];
};

export type ChunkMeshResult = {
    opaque: PassMesh | null;
    transparent: PassMesh | null;
    translucent: PassMesh | null;
    /** world-space AABB of all emitted geometry (chunk-local + chunk origin).
     *  null if the chunk emitted no geometry. */
    aabb: { min: [number, number, number]; max: [number, number, number] } | null;
};

/** quad capacity per pass in a `MeshOutput`. Generous, realistic chunks
 *  emit far fewer; egregious overage is silently truncated by
 *  `finishPassMesh`. Per-buffer bytes = `MAX_QUADS_PER_PASS × 13 u32 × 4
 *  = 52 B/quad × 4096 = 208 KB`; one MeshOutput = 3 × 208 KB = 624 KB. */
export const MAX_QUADS_PER_PASS = 4096;

/** caller-provided final-pass write targets. `meshChunk` writes the
 *  concatenated 7-facing output for each pass into the corresponding
 *  buffer; the returned `PassMesh.quads` is a subarray view of that
 *  buffer (length = quadCount * QUAD_STRIDE_U32S).
 *
 *  Sized by `createMeshOutput` to hold `MAX_QUADS_PER_PASS` quads per
 *  pass. Sources:
 *  - main-thread sync path: one engine-global scratch on `VoxelResources`
 *  - worker pool: one buffer triple per slot, transferred each job
 *  - tests / offline / bench: fresh allocations per call. */
export type MeshOutput = {
    opaque: Uint32Array;
    transparent: Uint32Array;
    translucent: Uint32Array;
};

/** allocate a `MeshOutput` sized for `MAX_QUADS_PER_PASS` quads per pass. */
export function createMeshOutput(): MeshOutput {
    const len = MAX_QUADS_PER_PASS * QUAD_STRIDE_U32S;
    return {
        opaque: new Uint32Array(len),
        transparent: new Uint32Array(len),
        translucent: new Uint32Array(len),
    };
}

/** facing classification: 0..5 cardinal cube-faces, 6 = UNASSIGNED. */
export const FACING_POS_X = 0;
export const FACING_NEG_X = 1;
export const FACING_POS_Y = 2;
export const FACING_NEG_Y = 3;
export const FACING_POS_Z = 4;
export const FACING_NEG_Z = 5;
export const FACING_UNASSIGNED = 6;
export const FACING_COUNT = 7;

// ── flat cube face data ─────────────────────────────────────────────
//
// 6 faces, each with: slab stride, normal (3), 4 verts (12), 4 uvs (8),
// and a tex face index into stateTexCube (top=0..west=5).
//
// all packed as flat Float32Arrays / Int32Arrays for zero-indirection access.
// face order: east(+x), west(-x), up(+y), down(-y), south(+z), north(-z)

// slab strides per face, index with face index 0..5
const FACE_STRIDE = new Int32Array([
    SLAB_STRIDE_X, // east +x
    -SLAB_STRIDE_X, // west -x
    SLAB_STRIDE_Y, // up +y
    -SLAB_STRIDE_Y, // down -y
    SLAB_STRIDE_Z, // south +z
    -SLAB_STRIDE_Z, // north -z
]);

// normals per face, stride 3, index as f*3
const FACE_NORMAL = new Float32Array([
    // east
    1,
    0,
    0,
    // west
    -1,
    0,
    0,
    // up
    0,
    1,
    0,
    // down
    0,
    -1,
    0,
    // south
    0,
    0,
    1,
    // north
    0,
    0,
    -1, // north
]);

// 4 verts per face, 3 components each, stride 12, index as f*12 + v*3
const FACE_VERTS = new Float32Array([
    // east (+x)
    1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1,
    // west (-x)
    0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0,
    // up (+y)
    0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0,
    // down (-y)
    0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1,
    // south (+z)
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
    // north (-z)
    1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0,
]);

// 4 uvs per face, 2 components each, stride 8, index as f*8 + v*2
// note: webgpu textures have V=0 at the top of the image, V=1 at the bottom.
// side faces map V=0 to top vertices (high Y) and V=1 to bottom vertices (low Y).
const FACE_UVS = new Float32Array([
    // east, v0(bottom) v1(bottom) v2(top) v3(top)
    0, 1, 1, 1, 1, 0, 0, 0,
    // west, v0(bottom) v1(bottom) v2(top) v3(top)
    0, 1, 1, 1, 1, 0, 0, 0,
    // up, top-down, no vertical flip needed
    0, 0, 0, 1, 1, 1, 1, 0,
    // down, bottom-up, no vertical flip needed
    0, 0, 0, 1, 1, 1, 1, 0,
    // south, v0(bottom) v1(bottom) v2(top) v3(top)
    0, 1, 1, 1, 1, 0, 0, 0,
    // north, v0(bottom) v1(bottom) v2(top) v3(top)
    0, 1, 1, 1, 1, 0, 0, 0,
]);

// maps face index (0..5) to stateTexCube offset.
// stateTexCube layout: top(0), bottom(1), north(2), south(3), east(4), west(5)
// face loop order: east(0), west(1), up(2), down(3), south(4), north(5)
const FACE_TEX_OFFSET = new Uint8Array([
    4, // east  → stateTexCube offset 4
    5, // west  → stateTexCube offset 5
    0, // up    → stateTexCube offset 0
    1, // down  → stateTexCube offset 1
    3, // south → stateTexCube offset 3
    2, // north → stateTexCube offset 2
]);

// ── ambient occlusion + smooth-light face neighbour tables ─────────
//
// Mirrors Sodium's `AoNeighborInfo.faces` (4 edges per face) + the
// implicit corner→edge pairing in `AoFaceData.initLightData`. The 4
// face-corners around a block face share neighbour cells: each edge is
// between 2 corners, each diagonal is unique to 1 corner. We store this
// edge-major so consumers read each edge once and reuse across corners.
//
// FACE_EDGE_OFFSETS: 6 faces × 4 edges = 24 Int32 slab-stride entries.
// Per face the 4 edges are listed in canonical order [-u, +u, -w, +w]
// (axU/axW per face: east/west → axU=Z,axW=Y; up/down → axU=X,axW=Z;
// south/north → axU=X,axW=Y). The 4 diagonal cells are derived as the
// sum of any 2 edge offsets, no need to store them.
//
// FACE_CORNER_EDGES: 6 faces × 4 corners × 2 edge indices = 48 Uint8.
// For each face-corner (v0..v3 matching FACE_VERTS), the 2 edge indices
// (0..3, into the per-face edge list) that bracket the corner. The
// diagonal for that corner is FACE_EDGE_OFFSETS[eA] + FACE_EDGE_OFFSETS[eB].
//
// stride aliases for readability:
const _X = SLAB_STRIDE_X; // +x
const _Y = SLAB_STRIDE_Y; // +y
const _Z = SLAB_STRIDE_Z; // +z

const FACE_EDGE_OFFSETS = new Int32Array([
    // east  (+x): axU=Z, axW=Y → [-Y, +Y, -Z, +Z]
    -_Y,
    _Y,
    -_Z,
    _Z,
    // west  (-x): axU=Z, axW=Y → [-Y, +Y, -Z, +Z]
    -_Y,
    _Y,
    -_Z,
    _Z,
    // up    (+y): axU=X, axW=Z → [-X, +X, -Z, +Z]
    -_X,
    _X,
    -_Z,
    _Z,
    // down  (-y): axU=X, axW=Z → [-X, +X, -Z, +Z]
    -_X,
    _X,
    -_Z,
    _Z,
    // south (+z): axU=X, axW=Y → [-X, +X, -Y, +Y]
    -_X,
    _X,
    -_Y,
    _Y,
    // north (-z): axU=X, axW=Y → [-X, +X, -Y, +Y]
    -_X,
    _X,
    -_Y,
    _Y,
]);

const FACE_CORNER_EDGES = new Uint8Array([
    // east:  v0(1,0,1)[-Y,+Z]=[0,3] v1(1,0,0)[-Y,-Z]=[0,2] v2(1,1,0)[+Y,-Z]=[1,2] v3(1,1,1)[+Y,+Z]=[1,3]
    0, 3, 0, 2, 1, 2, 1, 3,
    // west:  v0(0,0,0)[-Y,-Z]=[0,2] v1(0,0,1)[-Y,+Z]=[0,3] v2(0,1,1)[+Y,+Z]=[1,3] v3(0,1,0)[+Y,-Z]=[1,2]
    0, 2, 0, 3, 1, 3, 1, 2,
    // up:    v0(0,1,0)[-X,-Z]=[0,2] v1(0,1,1)[-X,+Z]=[0,3] v2(1,1,1)[+X,+Z]=[1,3] v3(1,1,0)[+X,-Z]=[1,2]
    0, 2, 0, 3, 1, 3, 1, 2,
    // down:  v0(0,0,1)[-X,+Z]=[0,3] v1(0,0,0)[-X,-Z]=[0,2] v2(1,0,0)[+X,-Z]=[1,2] v3(1,0,1)[+X,+Z]=[1,3]
    0, 3, 0, 2, 1, 2, 1, 3,
    // south: v0(0,0,1)[-X,-Y]=[0,2] v1(1,0,1)[+X,-Y]=[1,2] v2(1,1,1)[+X,+Y]=[1,3] v3(0,1,1)[-X,+Y]=[0,3]
    0, 2, 1, 2, 1, 3, 0, 3,
    // north: v0(1,0,0)[+X,-Y]=[1,2] v1(0,0,0)[-X,-Y]=[0,2] v2(0,1,0)[-X,+Y]=[0,3] v3(1,1,0)[+X,+Y]=[1,3]
    1, 2, 0, 2, 0, 3, 1, 3,
]);

// ── light packing for vertex attribute ──────────────────────────────
//
// Output format: u32 per quad-corner with R | G<<8 | B<<16 | sky<<24
// where each byte's low nibble holds the raw 0..15 light level. Sky is
// kept separate so the shader can dim it at runtime (day/night) without
// remeshing.
//
// The Minetest-style brightness curve `(-0.5x + 1.5)x²` is applied
// per-channel in the WGSL shader (`voxel-material.ts`'s `brightnessCurve`),
// not on the CPU. Shipping raw 4-bit channels lets the per-corner average
// run in packed-byte parallel form (`((a+b+c+d) >> 2) & 0x0F0F0F0F`).

// AO darkening factors indexed by ao level (vertexAO output: 0..3).
// 0 = fully occluded corner, 3 = no occluders. matches the shader's
// AO_FACTORS LUT, the shader reads raw 2-bit AO from the flags word and
// multiplies the per-vertex light by AO_FACTORS[ao].
export const AO_FACTORS = [0.5, 0.7, 0.85, 1.0] as const;

// ── smooth vertex light (AO is a separate stream) ────────────────────
//
// Sodium-aligned per-vertex light averaging. For each face-corner we
// average 4 packed light words: face center + 2 edges + 1 diagonal. The
// Sodium diagonal-substitution fixup (substitute edgeA when both edges
// are opaque) is applied at the caller's fetch site, so this function is
// a single packed-byte arithmetic mean. AO is NOT baked in, it lives in
// the meta word's low 16 bits and is multiplied by AO_FACTORS in the
// shader at draw time.

// ── per-face AO + smooth-light cache (sodium AoFaceData analog) ─────
//
// for each block we visit, mesh quads on a given face may sample the
// same 4 face-corner AO+light values many times. cache them so
// `ensureFaceCache` is the only place that walks the edge-share tables.
//
// 12 caches per block = 6 faces × 2 offsets:
//   offset=1 (true), sampled at the cell beyond the face (slabIdx + FACE_STRIDE)
//   offset=0 (false), sampled at the host cell itself (slabIdx)
//
// for a quad with inset depth D ∈ [0,1] (D=0 at the outer face plane,
// D=1 at the host face plane, matches Sodium's AoNeighborInfo.getDepth
// and classifyMeshQuadShape's `depth`), we bilerp the cache_offset_true
// and cache_offset_false at the quad vert's (u,w), then blend by D:
//   v = (1-D) * v_offset_true + D * v_offset_false
// so D=0 → all outside cell, D=1 → all host cell (the inset shading
// case for farmland/paths). ALIGNED_FULL/PARTIAL use D=0 (outside only),
// PARALLEL uses a uniform inset D, NON_PARALLEL per-vertex. IRREGULAR
// samples 3 face caches and blends by n².
//
// caches are valid for one (slabIdx, face, offset) triple, reset all
// validity bits before each voxel iteration's mesh-quad emit.

// 12 face slots (6 faces × 2 offsets) + 1 scratch slot for face-level blend
// (Sodium AoFaceData.weightedMean analog).
const FACE_CACHE_SIZE = 13;
const SLOT_SCRATCH = 12;
// ao stores pre-mapped brightness floats in [0.5, 1.0] (matches Sodium's
// `float[] ao` post-AoFaceData mapping). raw occluder count [0..3] is
// mapped through AO_BRIGHTNESS_TABLE at cache-fill time, so bake quantises
// to 4 bits across the [0.5, 1.0] range. shader unpacks linearly:
// `aoFactor = bits/30 + 0.5`.
const _faceCacheAo = new Float32Array(FACE_CACHE_SIZE * 4); // 52 f32
// AO brightness curve. raw occluder count 0..3 → brightness.
// `[0]` = 3 occluders (darkest), `[3]` = 0 occluders (open). Vanilla MC
// / Sodium values, applied uniformly across all light levels (the
// shader no longer fades AO based on corner brightness).
const AO_BRIGHTNESS_TABLE = new Float32Array([0.5, 0.6, 0.8, 1.0]);
const _faceCacheAoValid = new Uint8Array(FACE_CACHE_SIZE); // 13 flags

// Sibling lm field of the per-face cache (Sodium AoFaceData.lm analog).
// 4 packed corner light words per slot. Layout matches `readLightCellByIdx`
// output (R | G<<8 | B<<16 | sky<<24), opacity bit 28 is stripped by
// `blendCornerBrightness` at cache-fill time, so the stored words are
// pure light.
// Independent validity from `_faceCacheAoValid`: AO bake and light bake
// have the same lifetime (`meshChunk` runs both per voxel and
// `resetFaceCaches` clears them together), but a quad emit may request AO
// without light or vice-versa, so we don't want one to false-cache-hit
// the other.

// per-face edge scratch, populated by every consumer of the Sodium-style
// edge-share path (`ensureFaceCache`, `ensureFaceLightCache`, cube AO emit,
// cube relight). 4 slots = the 4 unique edges around a face center, indexed
// by FACE_CORNER_EDGES to pick which 2 bracket each corner. Reused across
// every call; values overwritten on entry.
const _edgeOffset = new Int32Array(4); // slab-stride offsets to the 4 edges
const _edgeOpaque = new Uint8Array(4); // 0/1 opacity flag per edge

/** per-face × per-corner (u, w) ∈ {0,1}², matching FACE_VERTS v0..v3
 *  projected via the face's (axisU, axisW). bilerp weights against these
 *  give the cache→vert blend. stride = 8 (face), 2 (corner).
 *  inverse table `FACE_UV_HASH_TO_CORNER` below for the ALIGNED_FULL fast path. */
const AO_FACE_UW_PER_CORNER = /* @__PURE__ */ new Float32Array([
    // east (+x), axU=z, axW=y
    1, 0, 0, 0, 0, 1, 1, 1,
    // west (-x), axU=z, axW=y
    0, 0, 1, 0, 1, 1, 0, 1,
    // up (+y), axU=x, axW=z
    0, 0, 0, 1, 1, 1, 1, 0,
    // down (-y), axU=x, axW=z
    0, 1, 0, 0, 1, 0, 1, 1,
    // south (+z), axU=x, axW=y
    0, 0, 1, 0, 1, 1, 0, 1,
    // north (-z), axU=x, axW=y
    1, 0, 0, 0, 0, 1, 1, 1,
]);

/** ALIGNED_FULL fast path: hash a quad-vert's (u, w) ∈ {0, 1}² to a 2-bit
 *  index (u≥0.5 → bit1, w≥0.5 → bit0), look up which cache corner it sits
 *  on for this face. Lets ALIGNED_FULL skip the bilerp + 5-channel
 *  accumulator entirely. Sodium's `AoNeighborInfo.mapCorners` analog,
 *  but in our codebase the swizzle is identity per construction, so we
 *  only need to invert AO_FACE_UW_PER_CORNER. */
const FACE_UV_HASH_TO_CORNER = /* @__PURE__ */ (() => {
    const t = new Uint8Array(6 * 4);
    for (let f = 0; f < 6; f++) {
        for (let c = 0; c < 4; c++) {
            const u = AO_FACE_UW_PER_CORNER[f * 8 + c * 2]!;
            const w = AO_FACE_UW_PER_CORNER[f * 8 + c * 2 + 1]!;
            const hash = (u >= 0.5 ? 2 : 0) | (w >= 0.5 ? 1 : 0);
            t[f * 4 + hash] = c;
        }
    }
    return t;
})();

/** reset all 13 face caches. call at the start of each voxel's mesh
 *  emit (and any other shape-dispatch site that uses the cache). */
function resetFaceCaches(): void {
    _faceCacheAoValid[0] = 0;
    _faceCacheAoValid[1] = 0;
    _faceCacheAoValid[2] = 0;
    _faceCacheAoValid[3] = 0;
    _faceCacheAoValid[4] = 0;
    _faceCacheAoValid[5] = 0;
    _faceCacheAoValid[6] = 0;
    _faceCacheAoValid[7] = 0;
    _faceCacheAoValid[8] = 0;
    _faceCacheAoValid[9] = 0;
    _faceCacheAoValid[10] = 0;
    _faceCacheAoValid[11] = 0;
    _faceCacheAoValid[12] = 0;
}

/** bake variant: populate _faceCacheAo for (face, offset) at this block if
 *  not already valid. four AO samples written per call: one per face corner
 *  in v0..v3 order (matches FACE_VERTS). AO is independent of smooth light:
 *  light is read per-emit by `emitQuadLightSmooth` directly from the eager
 *  18³ light slab.
 *
 *  Sodium edge-share pattern (`AoFaceData.initLightData`): the 4 face
 *  corners share 4 unique edge cells (each edge between 2 corners), so we
 *  read each edge once. The diagonal is skipped entirely when both edges
 *  are opaque, `vertexAO(1, 1, _)` is always 0, so the diagonal read
 *  is dead in that branch.
 *
 *  Reads the 18³ `opaqueMaskSlab` (cell-iteration context) so the AO
 *  sample reads stay branch-free in the inner mesh loop. */
function ensureFaceCache(
    blockSlabIdx: number,
    face: number,
    offset: number, // 0 | 1
    opaqueMaskSlab: Uint8Array,
): number {
    const cacheIdx = face * 2 + offset;
    if (_faceCacheAoValid[cacheIdx]) return cacheIdx;

    const centerSlabIdx = offset ? blockSlabIdx + FACE_STRIDE[face]! : blockSlabIdx;
    const edgeOffsetBase = face * 4;
    const cornerEdgeBase = face * 8;

    // 4 unique edges around the face center. Each used by 2 corners.
    const edge0Offset = FACE_EDGE_OFFSETS[edgeOffsetBase]!;
    const edge1Offset = FACE_EDGE_OFFSETS[edgeOffsetBase + 1]!;
    const edge2Offset = FACE_EDGE_OFFSETS[edgeOffsetBase + 2]!;
    const edge3Offset = FACE_EDGE_OFFSETS[edgeOffsetBase + 3]!;
    const edge0Opaque = opaqueMaskSlab[centerSlabIdx + edge0Offset]!;
    const edge1Opaque = opaqueMaskSlab[centerSlabIdx + edge1Offset]!;
    const edge2Opaque = opaqueMaskSlab[centerSlabIdx + edge2Offset]!;
    const edge3Opaque = opaqueMaskSlab[centerSlabIdx + edge3Offset]!;
    _edgeOpaque[0] = edge0Opaque;
    _edgeOpaque[1] = edge1Opaque;
    _edgeOpaque[2] = edge2Opaque;
    _edgeOpaque[3] = edge3Opaque;
    _edgeOffset[0] = edge0Offset;
    _edgeOffset[1] = edge1Offset;
    _edgeOffset[2] = edge2Offset;
    _edgeOffset[3] = edge3Offset;

    const outBase = cacheIdx * 4;
    for (let corner = 0; corner < 4; corner++) {
        const edgeAIndex = FACE_CORNER_EDGES[cornerEdgeBase + corner * 2]!;
        const edgeBIndex = FACE_CORNER_EDGES[cornerEdgeBase + corner * 2 + 1]!;
        const edgeAOpaque = _edgeOpaque[edgeAIndex]!;
        const edgeBOpaque = _edgeOpaque[edgeBIndex]!;
        if (edgeAOpaque && edgeBOpaque) {
            // both edges occlude the corner, diagonal is irrelevant.
            // raw occluder count = 3 → AO_BRIGHTNESS_TABLE[0] = 0.5.
            _faceCacheAo[outBase + corner] = AO_BRIGHTNESS_TABLE[0]!;
        } else {
            const diagonalSlabIdx = centerSlabIdx + _edgeOffset[edgeAIndex]! + _edgeOffset[edgeBIndex]!;
            const diagonalOpaque = opaqueMaskSlab[diagonalSlabIdx]!;
            _faceCacheAo[outBase + corner] = AO_BRIGHTNESS_TABLE[3 - edgeAOpaque - edgeBOpaque - diagonalOpaque]!;
        }
    }

    _faceCacheAoValid[cacheIdx] = 1;
    return cacheIdx;
}

// Sodium-mirror nomenclature (cross-reference for the reader):
//
//   Sodium `AoFaceData.initLightData`         |  Ours
//   ──────────────────────────────────────────┼────────────────────────────────
//   adjWord = cache.get(adj)                  |  centerWord = readLightCellByIdx(base)
//   unpackFO(adjWord)                         |  (centerWord & (1<<28)), see note
//   calm = getLightmap(origin/adj)            |  centerWord (post-FO substitution)
//   AoNeighborInfo.get(direction).faces[0..3] |  AO_OFFSETS[face*12 + c*3]
//   e0lm..e3lm, e0op..e3op                    |  s1word..s2word (opacity in bit 28)
//   c0lm..c3lm (`if eAop && eBop → use eA`)   |  diagWord (same substitution)
//   per-corner (e3,e0,c1,calm), (e2,e0,c0,…)  |  per-corner (s1, s2, diag, center)
//   calculateCornerBrightness(a, b, c, d, em) |  blendCornerBrightness(s1, s2, diag, center)
//   cb[0..3] (4 packed lightmap words)        |  out[cornerBase + v]
//
// Divergences:
//   - We pack RGB+sky+opacity into ONE u32 cell word (Sodium splits lm/ao/op/em).
//   - AO and smooth light are both emitted by meshChunk in the same pass;
//     AO comes from `_faceCacheAo` via `opaqueMaskSlab`, light from
//     `_blockLightSlab` via `readLightCellByIdx`. Sodium splits these
//     across separate AoFaceData fields.
//   - Emissive is modelled per-quad: `emitQuadLightEmissive` writes 0xffffffff
//     when `registry.emissive[stateId]` is true.
//   - Sodium's `unpackFO` is "full-cube occluder"; we use bit 28 = `CULL_SOLID`
//     which is functionally equivalent for our cull set (no PARTIAL emits as
//     opaque). When that changes, this is the bit to revisit.

/** Per-channel Sodium min-non-zero blend (Sodium `calculateCornerBrightness`'s
 *  per-channel inner): pick the smallest non-zero of the 4 corner samples,
 *  substitute zeros with that min, then average. */
/** Sodium `AoFaceData.calculateCornerBrightness(a, b, c, d, em…)`. Arg order
 *  matches Sodium: a=edgeA, b=edgeB, c=cornerDiagonal, d=center. The min-
 *  non-zero blend is symmetric across the 4 args, so the order is documentary
 *  rather than load-bearing, keep it aligned so the relationship to Sodium
 *  is obvious. */
// ── inline per-quad light emit ──────────────────────────────────────
//
/** scratch for mesh per-vert ao emit. cube and liquid use their own
 *  scratch; this is exclusive to MODEL_MESH shape-dispatch so it
 *  doesn't alias liquid's mid-loop reads. stores brightness floats
 *  in [0.5, 1.0] (mapped via AO_BRIGHTNESS_TABLE) so partial-face
 *  blends keep sub-level precision until 4-bit quantize at bake. */
const _meshAoScratch = new Float32Array(4);

// ── Sodium-mirror scalar bilerp + face-level blend ──
//
// Mirrors `AoFaceData.getBlendedShade/SkyLight/BlockLight` (scalar returns)
// and `AoFaceData.weightedMean` (face-level linear combine). Callers pass
// bilerp weights as 4 positional args and consume one scalar per call.
//
// For ALIGNED_FULL the bilerp degenerates to a direct cache read at one
// corner (no LUT needed, our cache is keyed in FACE_VERTS vertex order).
// PARALLEL/NON_PARALLEL/ALIGNED_PARTIAL use bilerp-then-scalar-blend
// (Sodium's `applyInsetPartialFaceVertex`). IRREGULAR uses
// `gatherInsetFaceForAxis` (Sodium's `gatherInsetFace`) which face-level-
// blends two slots into SLOT_SCRATCH before the bilerp.

/** Sodium `AoFaceData.getBlendedShade(w[])`. Returns float AO level (0..3). */
function getBlendedAo(slot: number, w0: number, w1: number, w2: number, w3: number): number {
    const b = slot * 4;
    return _faceCacheAo[b]! * w0 + _faceCacheAo[b + 1]! * w1 + _faceCacheAo[b + 2]! * w2 + _faceCacheAo[b + 3]! * w3;
}

/** bake variant of Sodium `AoFaceData.weightedMean`. Writes a face-level
 *  linear combine of slotA and slotB into slotOut, for _faceCacheAo only. */
function blendFacesInto(slotA: number, wA: number, slotB: number, wB: number, slotOut: number): void {
    const bA = slotA * 4,
        bB = slotB * 4,
        bO = slotOut * 4;
    _faceCacheAo[bO] = _faceCacheAo[bA]! * wA + _faceCacheAo[bB]! * wB;
    _faceCacheAo[bO + 1] = _faceCacheAo[bA + 1]! * wA + _faceCacheAo[bB + 1]! * wB;
    _faceCacheAo[bO + 2] = _faceCacheAo[bA + 2]! * wA + _faceCacheAo[bB + 2]! * wB;
    _faceCacheAo[bO + 3] = _faceCacheAo[bA + 3]! * wA + _faceCacheAo[bB + 3]! * wB;
    _faceCacheAoValid[slotOut] = 1;
}

/** bake variant of Sodium `gatherInsetFace`. Returns a slot index to bilerp
 *  against:
 *  - depth ≤ 0 → cacheTrue (face cell beyond the host)
 *  - depth ≥ 1 → cacheFalse (host cell itself)
 *  - else      → SLOT_SCRATCH containing weightedMean(true, 1-depth, false, depth) */
function gatherInsetFaceForAxis(slabIdx: number, face: number, depth: number, opaqueMaskSlab: Uint8Array): number {
    if (depth <= 0) return ensureFaceCache(slabIdx, face, 1, opaqueMaskSlab);
    if (depth >= 1) return ensureFaceCache(slabIdx, face, 0, opaqueMaskSlab);
    const sT = ensureFaceCache(slabIdx, face, 1, opaqueMaskSlab);
    const sF = ensureFaceCache(slabIdx, face, 0, opaqueMaskSlab);
    blendFacesInto(sT, 1 - depth, sF, depth, SLOT_SCRATCH);
    return SLOT_SCRATCH;
}

// ── scratch slabs (consumed by meshChunk) ───────────────────────────

/** scratch opaque-mask slab, one byte per cell (1 = solid). Populated by
 *  meshChunk after `buildSlabs`, consumed by `ensureFaceCache`/AO bake. */
const _opaqueMaskSlab = new Uint8Array(SLAB_VOLUME);

// ── prepass: build the 18x18x18 block-id + light slabs in one pass ──
//
// meshChunk iterates every cell of the 16³ region and reads 1-cell
// neighbours for both AO (block ids) and smooth light (packed light),
// so we amortise the 26 cross-chunk lookups by filling both slabs in
// the same neighbour walk.
//
// missing-neighbor handling: when a face/edge/corner neighbour chunk
// does not exist, the block slab stays AIR (from `_slab.fill(AIR)`)
// and the light slab stays `PACKED_LIGHT_SKY_FULL` (sky=15, RGB=0),
// matches Sodium's "no chunk = sky-lit void" fallback.

// packed u16 with sky=15 (matches `Chunk.light` layout: sky4|R4|G4|B4
// in the high nibble of byte 1).
const PACKED_LIGHT_SKY_FULL = 0xf000;

// buildSlabs reads only `voxels.chunks`; the worker (mesh-worker) builds a
// `Voxels`-shaped store from a transferred MeshTasks packet and passes it here,
// so no live `Voxels` reference crosses the worker boundary.
function buildSlabs(voxels: Voxels, cx: number, cy: number, cz: number, slab: Uint32Array, lightSlab: Uint16Array): void {
    slab.fill(AIR);
    lightSlab.fill(PACKED_LIGHT_SKY_FULL);

    const center = getChunk(voxels, cx, cy, cz);
    if (center === undefined) return;

    // fill the center 16x16x16 from the chunk's own data + light
    for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            const slabRowBase = (y + 1) * SLAB_SIZE_SQ + (z + 1) * SLAB_SIZE + 1;
            const chunkRowBase = (y << (CHUNK_BITS + CHUNK_BITS)) | (z << CHUNK_BITS);
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const ci = chunkRowBase | x;
                slab[slabRowBase + x] = center.palette[center.data[ci]!]!;
                lightSlab[slabRowBase + x] = center.light[ci]!;
            }
        }
    }

    // fill the 6 face borders from neighbor chunks. each border is a
    // 16x16 strip of slab cells fed from the matching face of the
    // adjacent chunk; missing neighbor → sky-lit air on the light slab.
    //
    // -X border (slab x=0 ← neighbor x=CHUNK_SIZE-1)
    {
        const neighbor = center.neighbors[neighbourSlot(-1, 0, 0)];
        if (neighbor) {
            for (let y = 0; y < CHUNK_SIZE; y++)
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    const dstIdx = (y + 1) * SLAB_SIZE_SQ + (z + 1) * SLAB_SIZE + 0;
                    const srcIdx = voxelIndex(CHUNK_SIZE - 1, y, z);
                    slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                    lightSlab[dstIdx] = neighbor.light[srcIdx]!;
                }
        }
    }
    // +X border (slab x=CHUNK_SIZE+1 ← neighbor x=0)
    {
        const neighbor = center.neighbors[neighbourSlot(1, 0, 0)];
        if (neighbor) {
            for (let y = 0; y < CHUNK_SIZE; y++)
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    const dstIdx = (y + 1) * SLAB_SIZE_SQ + (z + 1) * SLAB_SIZE + (CHUNK_SIZE + 1);
                    const srcIdx = voxelIndex(0, y, z);
                    slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                    lightSlab[dstIdx] = neighbor.light[srcIdx]!;
                }
        }
    }
    // -Y border (slab y=0 ← neighbor y=CHUNK_SIZE-1)
    {
        const neighbor = center.neighbors[neighbourSlot(0, -1, 0)];
        if (neighbor) {
            for (let z = 0; z < CHUNK_SIZE; z++)
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    const dstIdx = 0 * SLAB_SIZE_SQ + (z + 1) * SLAB_SIZE + (x + 1);
                    const srcIdx = voxelIndex(x, CHUNK_SIZE - 1, z);
                    slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                    lightSlab[dstIdx] = neighbor.light[srcIdx]!;
                }
        }
    }
    // +Y border (slab y=CHUNK_SIZE+1 ← neighbor y=0)
    {
        const neighbor = center.neighbors[neighbourSlot(0, 1, 0)];
        if (neighbor) {
            for (let z = 0; z < CHUNK_SIZE; z++)
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    const dstIdx = (CHUNK_SIZE + 1) * SLAB_SIZE_SQ + (z + 1) * SLAB_SIZE + (x + 1);
                    const srcIdx = voxelIndex(x, 0, z);
                    slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                    lightSlab[dstIdx] = neighbor.light[srcIdx]!;
                }
        }
    }
    // -Z border (slab z=0 ← neighbor z=CHUNK_SIZE-1)
    {
        const neighbor = center.neighbors[neighbourSlot(0, 0, -1)];
        if (neighbor) {
            for (let y = 0; y < CHUNK_SIZE; y++)
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    const dstIdx = (y + 1) * SLAB_SIZE_SQ + 0 * SLAB_SIZE + (x + 1);
                    const srcIdx = voxelIndex(x, y, CHUNK_SIZE - 1);
                    slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                    lightSlab[dstIdx] = neighbor.light[srcIdx]!;
                }
        }
    }
    // +Z border (slab z=CHUNK_SIZE+1 ← neighbor z=0)
    {
        const neighbor = center.neighbors[neighbourSlot(0, 0, 1)];
        if (neighbor) {
            for (let y = 0; y < CHUNK_SIZE; y++)
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    const dstIdx = (y + 1) * SLAB_SIZE_SQ + (CHUNK_SIZE + 1) * SLAB_SIZE + (x + 1);
                    const srcIdx = voxelIndex(x, y, 0);
                    slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                    lightSlab[dstIdx] = neighbor.light[srcIdx]!;
                }
        }
    }

    // fill 12 edge strips from diagonal-neighbor chunks. smooth lighting
    // samples edge neighbors in the slab, so vertices at chunk boundaries
    // need valid data here; missing neighbor → sky-lit air on the light
    // slab. edge naming: the two fixed axes define the diagonal chunk;
    // e.g. (+X,+Y) runs along Z, reading chunk (cx+1, cy+1, cz) at (0,0,z).
    //
    // -X-Y edge (slab x=0, y=0, runs along z)
    {
        const neighbor = center.neighbors[neighbourSlot(-1, -1, 0)];
        if (neighbor) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                const dstIdx = 0 * SLAB_SIZE_SQ + (z + 1) * SLAB_SIZE + 0;
                const srcIdx = voxelIndex(CHUNK_SIZE - 1, CHUNK_SIZE - 1, z);
                slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                lightSlab[dstIdx] = neighbor.light[srcIdx]!;
            }
        }
    }
    // +X-Y edge (slab x=17, y=0, runs along z)
    {
        const neighbor = center.neighbors[neighbourSlot(1, -1, 0)];
        if (neighbor) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                const dstIdx = 0 * SLAB_SIZE_SQ + (z + 1) * SLAB_SIZE + (CHUNK_SIZE + 1);
                const srcIdx = voxelIndex(0, CHUNK_SIZE - 1, z);
                slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                lightSlab[dstIdx] = neighbor.light[srcIdx]!;
            }
        }
    }
    // -X+Y edge (slab x=0, y=17, runs along z)
    {
        const neighbor = center.neighbors[neighbourSlot(-1, 1, 0)];
        if (neighbor) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                const dstIdx = (CHUNK_SIZE + 1) * SLAB_SIZE_SQ + (z + 1) * SLAB_SIZE + 0;
                const srcIdx = voxelIndex(CHUNK_SIZE - 1, 0, z);
                slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                lightSlab[dstIdx] = neighbor.light[srcIdx]!;
            }
        }
    }
    // +X+Y edge (slab x=17, y=17, runs along z)
    {
        const neighbor = center.neighbors[neighbourSlot(1, 1, 0)];
        if (neighbor) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                const dstIdx = (CHUNK_SIZE + 1) * SLAB_SIZE_SQ + (z + 1) * SLAB_SIZE + (CHUNK_SIZE + 1);
                const srcIdx = voxelIndex(0, 0, z);
                slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                lightSlab[dstIdx] = neighbor.light[srcIdx]!;
            }
        }
    }
    // -X-Z edge (slab x=0, z=0, runs along y)
    {
        const neighbor = center.neighbors[neighbourSlot(-1, 0, -1)];
        if (neighbor) {
            for (let y = 0; y < CHUNK_SIZE; y++) {
                const dstIdx = (y + 1) * SLAB_SIZE_SQ + 0 * SLAB_SIZE + 0;
                const srcIdx = voxelIndex(CHUNK_SIZE - 1, y, CHUNK_SIZE - 1);
                slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                lightSlab[dstIdx] = neighbor.light[srcIdx]!;
            }
        }
    }
    // +X-Z edge (slab x=17, z=0, runs along y)
    {
        const neighbor = center.neighbors[neighbourSlot(1, 0, -1)];
        if (neighbor) {
            for (let y = 0; y < CHUNK_SIZE; y++) {
                const dstIdx = (y + 1) * SLAB_SIZE_SQ + 0 * SLAB_SIZE + (CHUNK_SIZE + 1);
                const srcIdx = voxelIndex(0, y, CHUNK_SIZE - 1);
                slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                lightSlab[dstIdx] = neighbor.light[srcIdx]!;
            }
        }
    }
    // -X+Z edge (slab x=0, z=17, runs along y)
    {
        const neighbor = center.neighbors[neighbourSlot(-1, 0, 1)];
        if (neighbor) {
            for (let y = 0; y < CHUNK_SIZE; y++) {
                const dstIdx = (y + 1) * SLAB_SIZE_SQ + (CHUNK_SIZE + 1) * SLAB_SIZE + 0;
                const srcIdx = voxelIndex(CHUNK_SIZE - 1, y, 0);
                slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                lightSlab[dstIdx] = neighbor.light[srcIdx]!;
            }
        }
    }
    // +X+Z edge (slab x=17, z=17, runs along y)
    {
        const neighbor = center.neighbors[neighbourSlot(1, 0, 1)];
        if (neighbor) {
            for (let y = 0; y < CHUNK_SIZE; y++) {
                const dstIdx = (y + 1) * SLAB_SIZE_SQ + (CHUNK_SIZE + 1) * SLAB_SIZE + (CHUNK_SIZE + 1);
                const srcIdx = voxelIndex(0, y, 0);
                slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                lightSlab[dstIdx] = neighbor.light[srcIdx]!;
            }
        }
    }
    // -Y-Z edge (slab y=0, z=0, runs along x)
    {
        const neighbor = center.neighbors[neighbourSlot(0, -1, -1)];
        if (neighbor) {
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const dstIdx = 0 * SLAB_SIZE_SQ + 0 * SLAB_SIZE + (x + 1);
                const srcIdx = voxelIndex(x, CHUNK_SIZE - 1, CHUNK_SIZE - 1);
                slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                lightSlab[dstIdx] = neighbor.light[srcIdx]!;
            }
        }
    }
    // +Y-Z edge (slab y=17, z=0, runs along x)
    {
        const neighbor = center.neighbors[neighbourSlot(0, 1, -1)];
        if (neighbor) {
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const dstIdx = (CHUNK_SIZE + 1) * SLAB_SIZE_SQ + 0 * SLAB_SIZE + (x + 1);
                const srcIdx = voxelIndex(x, 0, CHUNK_SIZE - 1);
                slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                lightSlab[dstIdx] = neighbor.light[srcIdx]!;
            }
        }
    }
    // -Y+Z edge (slab y=0, z=17, runs along x)
    {
        const neighbor = center.neighbors[neighbourSlot(0, -1, 1)];
        if (neighbor) {
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const dstIdx = 0 * SLAB_SIZE_SQ + (CHUNK_SIZE + 1) * SLAB_SIZE + (x + 1);
                const srcIdx = voxelIndex(x, CHUNK_SIZE - 1, 0);
                slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                lightSlab[dstIdx] = neighbor.light[srcIdx]!;
            }
        }
    }
    // +Y+Z edge (slab y=17, z=17, runs along x)
    {
        const neighbor = center.neighbors[neighbourSlot(0, 1, 1)];
        if (neighbor) {
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const dstIdx = (CHUNK_SIZE + 1) * SLAB_SIZE_SQ + (CHUNK_SIZE + 1) * SLAB_SIZE + (x + 1);
                const srcIdx = voxelIndex(x, 0, 0);
                slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
                lightSlab[dstIdx] = neighbor.light[srcIdx]!;
            }
        }
    }

    // 8 corner cells from diagonal-neighbor chunks.
    //
    // -X-Y-Z corner (slab 0,0,0)
    {
        const neighbor = center.neighbors[neighbourSlot(-1, -1, -1)];
        const dstIdx = 0 * SLAB_SIZE_SQ + 0 * SLAB_SIZE + 0;
        if (neighbor) {
            const srcIdx = voxelIndex(CHUNK_SIZE - 1, CHUNK_SIZE - 1, CHUNK_SIZE - 1);
            slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
            lightSlab[dstIdx] = neighbor.light[srcIdx]!;
        }
    }
    // +X-Y-Z corner (slab 17,0,0)
    {
        const neighbor = center.neighbors[neighbourSlot(1, -1, -1)];
        const dstIdx = 0 * SLAB_SIZE_SQ + 0 * SLAB_SIZE + (CHUNK_SIZE + 1);
        if (neighbor) {
            const srcIdx = voxelIndex(0, CHUNK_SIZE - 1, CHUNK_SIZE - 1);
            slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
            lightSlab[dstIdx] = neighbor.light[srcIdx]!;
        }
    }
    // -X+Y-Z corner (slab 0,17,0)
    {
        const neighbor = center.neighbors[neighbourSlot(-1, 1, -1)];
        const dstIdx = (CHUNK_SIZE + 1) * SLAB_SIZE_SQ + 0 * SLAB_SIZE + 0;
        if (neighbor) {
            const srcIdx = voxelIndex(CHUNK_SIZE - 1, 0, CHUNK_SIZE - 1);
            slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
            lightSlab[dstIdx] = neighbor.light[srcIdx]!;
        }
    }
    // +X+Y-Z corner (slab 17,17,0)
    {
        const neighbor = center.neighbors[neighbourSlot(1, 1, -1)];
        const dstIdx = (CHUNK_SIZE + 1) * SLAB_SIZE_SQ + 0 * SLAB_SIZE + (CHUNK_SIZE + 1);
        if (neighbor) {
            const srcIdx = voxelIndex(0, 0, CHUNK_SIZE - 1);
            slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
            lightSlab[dstIdx] = neighbor.light[srcIdx]!;
        }
    }
    // -X-Y+Z corner (slab 0,0,17)
    {
        const neighbor = center.neighbors[neighbourSlot(-1, -1, 1)];
        const dstIdx = 0 * SLAB_SIZE_SQ + (CHUNK_SIZE + 1) * SLAB_SIZE + 0;
        if (neighbor) {
            const srcIdx = voxelIndex(CHUNK_SIZE - 1, CHUNK_SIZE - 1, 0);
            slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
            lightSlab[dstIdx] = neighbor.light[srcIdx]!;
        }
    }
    // +X-Y+Z corner (slab 17,0,17)
    {
        const neighbor = center.neighbors[neighbourSlot(1, -1, 1)];
        const dstIdx = 0 * SLAB_SIZE_SQ + (CHUNK_SIZE + 1) * SLAB_SIZE + (CHUNK_SIZE + 1);
        if (neighbor) {
            const srcIdx = voxelIndex(0, CHUNK_SIZE - 1, 0);
            slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
            lightSlab[dstIdx] = neighbor.light[srcIdx]!;
        }
    }
    // -X+Y+Z corner (slab 0,17,17)
    {
        const neighbor = center.neighbors[neighbourSlot(-1, 1, 1)];
        const dstIdx = (CHUNK_SIZE + 1) * SLAB_SIZE_SQ + (CHUNK_SIZE + 1) * SLAB_SIZE + 0;
        if (neighbor) {
            const srcIdx = voxelIndex(CHUNK_SIZE - 1, 0, 0);
            slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
            lightSlab[dstIdx] = neighbor.light[srcIdx]!;
        }
    }
    // +X+Y+Z corner (slab 17,17,17)
    {
        const neighbor = center.neighbors[neighbourSlot(1, 1, 1)];
        const dstIdx = (CHUNK_SIZE + 1) * SLAB_SIZE_SQ + (CHUNK_SIZE + 1) * SLAB_SIZE + (CHUNK_SIZE + 1);
        if (neighbor) {
            const srcIdx = voxelIndex(0, 0, 0);
            slab[dstIdx] = neighbor.palette[neighbor.data[srcIdx]!]!;
            lightSlab[dstIdx] = neighbor.light[srcIdx]!;
        }
    }
}

// ── output buffers ──────────────────────────────────────────────────
//
// 21 unified scratch buckets: 3 passes × 7 facing slices. cubes,
// liquid sides/tops, and custom-model quads all emit into the same
// per-quad format documented at PassMesh. allocated once at module
// load; reset at the top of every meshChunk. if a chunk overruns its
// budget for a (pass, facing), that bucket is truncated.
//
// per-bucket budget is the true upper bound, 16³ = 4096 quads per
// facing (every cell of the chunk could emit one quad in that
// direction). cheap scratch, module-level typed arrays.

export const QUAD_U32S = 13; // 52 B / quad header (see PassMesh layout above)
export const QUAD_STRIDE_U32S = QUAD_U32S; // 13 u32 = 52 B / quad
export const FLAGS_OFFSET = 11; // u32[11] within each quad header
export const META_OFFSET = 12; // u32[12] within each quad header

/** per-vert corner picks for cube/liquid quads. cube vert k IS corner k,
 *  so this is the identity packing `0 | 1<<2 | 2<<4 | 3<<6 = 0xE4`,
 *  same for every face. Consumed by `emitQuadLightSmooth` to index
 *  AO_OFFSETS per vertex. */

const MAX_QUADS_PER_BUCKET = 4096;
const SCRATCH_BUCKET_COUNT = 3 * FACING_COUNT; // 21

// pass × facing → bucket index
const PASS_OPAQUE_BASE = 0;
const PASS_TRANSPARENT_BASE = FACING_COUNT;
const PASS_TRANSLUCENT_BASE = FACING_COUNT * 2;

type QuadScratch = {
    /** interleaved per-quad buffer: 14 u32/quad, header (10) + light (4) */
    quads: Uint32Array;
    quadCount: number;
};

function makeQuadScratch(maxQuads: number): QuadScratch {
    return {
        quads: new Uint32Array(maxQuads * QUAD_STRIDE_U32S),
        quadCount: 0,
    };
}

const quadScratch: QuadScratch[] = /* @__PURE__ */ (() => {
    const arr: QuadScratch[] = [];
    for (let i = 0; i < SCRATCH_BUCKET_COUNT; i++) arr.push(makeQuadScratch(MAX_QUADS_PER_BUCKET));
    return arr;
})();

/** flags layout: texIndex 16 | animType 4 | facing 3 | emissive 1 | unshaded 1 | reserved 7.
 *  bit 23 (was the bake-time diagFlip, which now lives in the meta word at
 *  `QUAD_META_DIAG_FLIP_BIT`) is reused as the emissive
 *  flag: the shader skips directional face-shade + AO for emissive quads
 *  so a self-lit block (torch, glowstone) glows uniformly instead of
 *  dimming its E/W/N/S faces. bit 24 is unshaded (`BlockQuad.shade: false`):
 *  the shader skips the directional face shade only, AO still applies. AO
 *  sits in the dedicated meta word (`u32[9]`). bits 25..31 stay reserved. */
const QUAD_FLAG_EMISSIVE = 1 << 23;
const QUAD_FLAG_UNSHADED = 1 << 24;

function packQuadFlags(texIndex: number, animType: number, facing: number, emissive: number, unshaded = 0): number {
    return (
        (texIndex & 0xffff) |
        ((animType & 0xf) << 16) |
        ((facing & 0x7) << 20) |
        (emissive ? QUAD_FLAG_EMISSIVE : 0) |
        (unshaded ? QUAD_FLAG_UNSHADED : 0)
    );
}

/** diagFlip, bit 16 of the meta word. Was `light[0]` bit 29 back when the
 *  mesher baked per-corner light; that word is gone. */
export const QUAD_META_DIAG_FLIP_BIT = 16;
export const QUAD_META_DIAG_FLIP = 1 << QUAD_META_DIAG_FLIP_BIT;

/** meta layout: aoPacked 16 (4 bits/corner) | diagFlip 1 | reserved 15.
 *  aoPacked is `ao0Bits | (ao1Bits<<4) | (ao2Bits<<8) | (ao3Bits<<12)` where
 *  each `aoNBits` ∈ [0..15] encodes brightness via
 *  `round((brightness - 0.5) * 30)`. shader recovers brightness as
 *  `bits/30 + 0.5`. bits 17..31 reserved for future per-quad metadata
 *  (foliage sway intensity, emissive boost, per-quad tint, etc.).
 *
 *  DIAGFLIP is Sodium's `ModelQuadOrientation.orientByBrightness`: put the
 *  triangulation seam through the brighter AO pair. Sodium breaks an AO tie
 *  with the corner LIGHT values, and this used to as well. That tiebreaker is
 *  deliberately gone: light is no longer known at mesh time, and more to the
 *  point a bake-time decision derived from light would go stale the moment
 *  light changed without a remesh, which is exactly what the light volume
 *  makes possible. AO ties now keep the unflipped diagonal. */
function packQuadMeta(aoPacked: number): number {
    const ao0 = aoPacked & 0xf;
    const ao1 = (aoPacked >>> 4) & 0xf;
    const ao2 = (aoPacked >>> 8) & 0xf;
    const ao3 = (aoPacked >>> 12) & 0xf;
    return (aoPacked & 0xffff) | (ao0 + ao2 < ao1 + ao3 ? QUAD_META_DIAG_FLIP : 0);
}

/** all 4 corners at full brightness (`round((1.0 - 0.5) * 30)` = 15 each).
 *  used by quads whose AO neighbourhood is meaningless because they sit
 *  inside a solid until a vertex animation pulls them out of it. */
const AO_PACKED_UNOCCLUDED = 0xffff;

/** voxels per encoded unit's reciprocal: positions are stored as
 *  `(v + POS_ORIGIN) * POS_SCALE` in a u16. A POWER OF TWO so every 1/16
 *  authoring position is an exact integer (2048/16 = 128) and a vertex on a
 *  chunk boundary encodes identically from either side. */
const POS_SCALE = 2048;
/** voxels of overhang below the chunk origin. With a u16 this buys [-8, +24),
 *  i.e. 8 voxels of reach past the chunk on every side, matching Sodium's
 *  MODEL_ORIGIN/MODEL_RANGE. */
const POS_ORIGIN = 8;

/**
 * integer hash of a WORLD block position, for per-position variation.
 *
 * World, never chunk-local: hashing local coords repeats the identical pattern
 * in every chunk, which reads as a 16-block grid and looks plausible enough to
 * miss. Modelled on minecraft's `Mth.getSeed`, kept in int32 throughout so it
 * is the same on every machine.
 *
 * Callers pass y = 0 for JITTER, so a vertical stack of one block shares an
 * offset and a two-block plant cannot tear apart. Variants pass the real y.
 */
function posHash(x: number, y: number, z: number): number {
    let h = (Math.imul(x, 3129871) ^ Math.imul(z, 116129781) ^ y) | 0;
    h = (Math.imul(h, h) + Math.imul(h, 11)) | 0;
    return (h >>> 16) | 0;
}

/** convert a chunk-local position component (voxels) to its u16 encoding.
 *  VS decodes with the inverse: `chunkLocal = half / POS_SCALE - POS_ORIGIN`. */
function posEncode(v: number): number {
    const i = Math.round((v + POS_ORIGIN) * POS_SCALE);
    return i < 0 ? 0 : i > 65535 ? 65535 : i;
}

/** integer fast path for `posEncode`. cube verts are always v in {0..16}
 *  (integer x,y,z + 0/1 from FACE_VERTS), so `Math.round` is wasted work and the
 *  result equals `POS_INT_LUT[v]`. Both scale and origin are integers, so every
 *  entry is exact. */
const POS_INT_LUT = /* @__PURE__ */ (() => {
    const lut = new Uint32Array(17);
    for (let i = 0; i <= 16; i++) lut[i] = (i + POS_ORIGIN) * POS_SCALE;
    return lut;
})();

/** write a unified quad header (9 u32) into a scratch bucket at quadIdx.
 *  positions are in chunk-local voxel space [0..16]; encoded as u8 per axis at 1/16 precision.
 *  (bx, by, bz) is the source block's chunk-local position [0..15], packed into
 *  the top 16 bits of u32[3] so the VS can reconstruct the block-center world
 *  pos. used for block-cohesive vertex anim (water/leaves ripple, plant sway
 *  phased per-block so crossed quads sway together). top 4 bits of u32[3] are
 *  reserved for a future `stackOffset` (multi-block stacked sway). */
function writeQuadHeader(
    s: QuadScratch,
    quadIdx: number,
    x0v: number,
    y0v: number,
    z0v: number,
    x1v: number,
    y1v: number,
    z1v: number,
    x2v: number,
    y2v: number,
    z2v: number,
    x3v: number,
    y3v: number,
    z3v: number,
    normalOct16: number,
    uvPacked0: number,
    uvPacked1: number,
    uvPacked2: number,
    uvPacked3: number,
    flags: number,
    metaWord: number,
    bx: number,
    by: number,
    bz: number,
): void {
    const off = quadIdx * QUAD_STRIDE_U32S;
    const x0 = posEncode(x0v),
        y0 = posEncode(y0v),
        z0 = posEncode(z0v);
    const x1 = posEncode(x1v),
        y1 = posEncode(y1v),
        z1 = posEncode(z1v);
    const x2 = posEncode(x2v),
        y2 = posEncode(y2v),
        z2 = posEncode(z2v);
    const x3 = posEncode(x3v),
        y3 = posEncode(y3v),
        z3 = posEncode(z3v);
    // 12 u16 across 6 u32, low half first: half index (corner*3 + axis).
    s.quads[off] = x0 | (y0 << 16);
    s.quads[off + 1] = z0 | (x1 << 16);
    s.quads[off + 2] = y1 | (z1 << 16);
    s.quads[off + 3] = x2 | (y2 << 16);
    s.quads[off + 4] = z2 | (x3 << 16);
    s.quads[off + 5] = y3 | (z3 << 16);
    s.quads[off + 6] = (normalOct16 & 0xffff) | ((bx & 0xf) << 16) | ((by & 0xf) << 20) | ((bz & 0xf) << 24);
    s.quads[off + 7] = uvPacked0;
    s.quads[off + 8] = uvPacked1;
    s.quads[off + 9] = uvPacked2;
    s.quads[off + 10] = uvPacked3;
    s.quads[off + 11] = flags;
    s.quads[off + 12] = metaWord;
}

/** identical to writeQuadHeader but uses `POS16_INT_LUT` instead of `pos16`.
 *  cube verts are always integer v ∈ {0..16}, so the LUT skips
 *  `Math.round` + clamp on 12 components per quad. */
function writeQuadHeaderInt(
    s: QuadScratch,
    quadIdx: number,
    x0v: number,
    y0v: number,
    z0v: number,
    x1v: number,
    y1v: number,
    z1v: number,
    x2v: number,
    y2v: number,
    z2v: number,
    x3v: number,
    y3v: number,
    z3v: number,
    normalOct16: number,
    uvPacked0: number,
    uvPacked1: number,
    uvPacked2: number,
    uvPacked3: number,
    flags: number,
    metaWord: number,
    bx: number,
    by: number,
    bz: number,
): void {
    const off = quadIdx * QUAD_STRIDE_U32S;
    const x0 = POS_INT_LUT[x0v]!,
        y0 = POS_INT_LUT[y0v]!,
        z0 = POS_INT_LUT[z0v]!;
    const x1 = POS_INT_LUT[x1v]!,
        y1 = POS_INT_LUT[y1v]!,
        z1 = POS_INT_LUT[z1v]!;
    const x2 = POS_INT_LUT[x2v]!,
        y2 = POS_INT_LUT[y2v]!,
        z2 = POS_INT_LUT[z2v]!;
    const x3 = POS_INT_LUT[x3v]!,
        y3 = POS_INT_LUT[y3v]!,
        z3 = POS_INT_LUT[z3v]!;
    // same 12 u16 across 6 u32 as `writeQuadHeader`, low half first.
    s.quads[off] = x0 | (y0 << 16);
    s.quads[off + 1] = z0 | (x1 << 16);
    s.quads[off + 2] = y1 | (z1 << 16);
    s.quads[off + 3] = x2 | (y2 << 16);
    s.quads[off + 4] = z2 | (x3 << 16);
    s.quads[off + 5] = y3 | (z3 << 16);
    s.quads[off + 6] = (normalOct16 & 0xffff) | ((bx & 0xf) << 16) | ((by & 0xf) << 20) | ((bz & 0xf) << 24);
    s.quads[off + 7] = uvPacked0;
    s.quads[off + 8] = uvPacked1;
    s.quads[off + 9] = uvPacked2;
    s.quads[off + 10] = uvPacked3;
    s.quads[off + 11] = flags;
    s.quads[off + 12] = metaWord;
}

/** classify a normal into one of the 7 facing slices.
 *  cardinals require |axis| > 0.999 (cosine within ~2.5° of an axis); else UNASSIGNED. */
function classifyFacing(nx: number, ny: number, nz: number): number {
    const ax = Math.abs(nx),
        ay = Math.abs(ny),
        az = Math.abs(nz);
    if (ax > 0.999) return nx > 0 ? FACING_POS_X : FACING_NEG_X;
    if (ay > 0.999) return ny > 0 ? FACING_POS_Y : FACING_NEG_Y;
    if (az > 0.999) return nz > 0 ? FACING_POS_Z : FACING_NEG_Z;
    return FACING_UNASSIGNED;
}

/** map cube face index (0=east..5=north) to facing slice. */
const FACE_TO_FACING = new Int32Array([
    FACING_POS_X, // 0 east  +x
    FACING_NEG_X, // 1 west  -x
    FACING_POS_Y, // 2 up    +y
    FACING_NEG_Y, // 3 down  -y
    FACING_POS_Z, // 4 south +z
    FACING_NEG_Z, // 5 north -z
]);

/** finalize one pass, concat 7 facing buckets into `target` and return a
 *  PassMesh whose `quads` field is a view into `target` covering only the
 *  written region. Capacity = `target.length / QUAD_STRIDE_U32S`; if the
 *  pass would exceed that, late facings are clipped and `faceCounts`
 *  reflects what was actually written. Returns null when the pass is
 *  empty. */
function finishPassMesh(passBase: number, target: Uint32Array): PassMesh | null {
    let total = 0;
    for (let f = 0; f < FACING_COUNT; f++) total += quadScratch[passBase + f]!.quadCount;
    if (total === 0) return null;

    const capQuads = (target.length / QUAD_STRIDE_U32S) | 0;

    const faceOffsets: [number, number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0, 0];
    const faceCounts: [number, number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0, 0];

    let cursor = 0;
    for (let f = 0; f < FACING_COUNT; f++) {
        const src = quadScratch[passBase + f]!;
        faceOffsets[f] = cursor;

        // truncate this facing to fit in the remaining cap. earlier
        // facings get priority; later facings are clipped or zeroed.
        const remaining = capQuads - cursor;
        const write = src.quadCount <= remaining ? src.quadCount : remaining;
        faceCounts[f] = write;
        if (write <= 0) continue;

        const srcQuads = src.quads;
        const qOff = cursor * QUAD_STRIDE_U32S;
        const qLen = write * QUAD_STRIDE_U32S;
        for (let i = 0; i < qLen; i++) target[qOff + i] = srcQuads[i]!;
        cursor += write;
    }

    if (cursor === 0) return null;

    return {
        quads: target.subarray(0, cursor * QUAD_STRIDE_U32S),
        quadCount: cursor,
        faceOffsets,
        faceCounts,
    };
}

// ── normal/uv packing for quad headers ──────────────────────────────

/** oct16 encode: arbitrary unit normal → low 16 bits of u32. */
export function encodeOct16(nx: number, ny: number, nz: number): number {
    const invL1 = 1 / (Math.abs(nx) + Math.abs(ny) + Math.abs(nz) + 1e-30);
    let ox = nx * invL1;
    let oy = ny * invL1;
    if (nz < 0) {
        const tx = (1 - Math.abs(oy)) * (ox >= 0 ? 1 : -1);
        const ty = (1 - Math.abs(ox)) * (oy >= 0 ? 1 : -1);
        ox = tx;
        oy = ty;
    }
    const u = Math.round((ox * 0.5 + 0.5) * 255) & 0xff;
    const v = Math.round((oy * 0.5 + 0.5) * 255) & 0xff;
    return u | (v << 8);
}

// pre-baked oct16 for the 6 cardinal face normals, used by MODEL_LIQUID.
// indexed by face: 0=east(+x), 1=west(-x), 2=up(+y), 3=down(-y),
// 4=south(+z), 5=north(-z).
const FACE_OCT16 = /* @__PURE__ */ (() => {
    const arr = new Uint32Array(6);
    for (let f = 0; f < 6; f++) {
        const nx = FACE_NORMAL[f * 3]!;
        const ny = FACE_NORMAL[f * 3 + 1]!;
        const nz = FACE_NORMAL[f * 3 + 2]!;
        arr[f] = encodeOct16(nx, ny, nz);
    }
    return arr;
})();

function packUV(u: number, v: number): number {
    const ui = Math.round(u * 65535) & 0xffff;
    const vi = Math.round(v * 65535) & 0xffff;
    return ui | (vi << 16);
}

/** how far each corner's UV moves toward the quad's UV centroid: a quarter of
 *  a texel on a 16-texel tile. The block atlas packs tiles edge to edge with no
 *  gutter, so a nearest tap at a quad's very edge can land in the neighbouring
 *  tile once the sampler's snap and the mip chain's half-texel offsets add up;
 *  pulling the edge in by less than a texel keeps every tap inside its own
 *  tile. Sodium does the same in its vertex format (`u_TexCoordShrink`); ours
 *  is baked here, per quad toward that quad's own centre, so sub-tile quads
 *  (`box()` local UVs) shrink toward their own rect and not the tile's. */
const UV_SHRINK = 1 / 64;

function shrinkToward(u: number, centre: number): number {
    const d = centre - u;
    return d > UV_SHRINK ? u + UV_SHRINK : d < -UV_SHRINK ? u - UV_SHRINK : centre;
}

/** packUV of four corners after the shrink, into `_uvPacked[0..3]`. */
const _uvPacked = new Uint32Array(4);
function packQuadUVs(u0: number, v0: number, u1: number, v1: number, u2: number, v2: number, u3: number, v3: number): void {
    const cu = (u0 + u1 + u2 + u3) * 0.25;
    const cv = (v0 + v1 + v2 + v3) * 0.25;
    _uvPacked[0] = packUV(shrinkToward(u0, cu), shrinkToward(v0, cv));
    _uvPacked[1] = packUV(shrinkToward(u1, cu), shrinkToward(v1, cv));
    _uvPacked[2] = packUV(shrinkToward(u2, cu), shrinkToward(v2, cv));
    _uvPacked[3] = packUV(shrinkToward(u3, cu), shrinkToward(v3, cv));
}

// scratch shared by the liquid corner loop and its diag-flip heuristic.
// stores brightness floats in [0.5, 1.0]; 4-bit quantize happens at bake.
const _liquidAoScratch = new Float32Array(4);
const _liquidUvRaw = new Float32Array(8); // (u, v) per corner, packed after the loop

// ── mesh input ──────────────────────────────────────────────────────

/** the slab-as-chunk view the mesher reads from. `blocks`/`light` are
 *  18³ slabs (host chunk + 1-cell padding from neighbours); `cx/cy/cz`
 *  is the host chunk's grid coord. Main-thread callers get a singleton
 *  wrapper around the module-scope scratch via `buildMeshInput`. */
export type MeshInput = {
    cx: number;
    cy: number;
    cz: number;
    blocks: Uint32Array; // 18³ globalStateIds, AIR for missing neighbours
    light: Uint16Array; // 18³ packed sky4|R4|G4|B4, sky=15 for missing neighbours
};

// shared main-thread MeshInput backed by module-scope slab scratch. each
// call to `buildMeshInput` overwrites the slab buffers in place and
// returns this same instance, no allocation per mesh.
const _meshInput: MeshInput = {
    cx: 0,
    cy: 0,
    cz: 0,
    blocks: _slab,
    light: _blockLightSlab,
};

/** build the mesher input for chunk `(cx,cy,cz)` by walking the 6 face/12 edge/8
 *  corner neighbours into the module-scope slab scratch. Pair with
 *  `meshChunk(input, registry)`. Used both on main (from `voxels`) and in the
 *  worker (from a MeshTasks-backed store). */
export function buildMeshInput(voxels: Voxels, cx: number, cy: number, cz: number): MeshInput {
    buildSlabs(voxels, cx, cy, cz, _slab, _blockLightSlab);
    _meshInput.cx = cx;
    _meshInput.cy = cy;
    _meshInput.cz = cz;
    return _meshInput;
}

// ── mesh a chunk ────────────────────────────────────────────────────

/**
 * mesh a chunk into six buckets: cube × {opaque, transparent, translucent}
 * and model × {opaque, transparent, translucent}. positions are chunk-local
 * (cube: 4-bit origin in header; model: f32 in [0..16]). returns null when
 * the chunk is entirely empty.
 *
 * zero allocations in the hot loop, all texture/model data is read from
 * flat typed arrays built at registry freeze time, all writes go into the
 * module-level scratch targets, and the returned ChunkMeshResult slices
 * out only the populated regions.
 */
export function meshChunk(out: MeshOutput, input: MeshInput, registry: Blocks): ChunkMeshResult | null {
    // main-thread invariant: `input.blocks === _slab` and `input.light
    // === _blockLightSlab` (via `buildMeshInput`). Worker stage will
    // swap the module scratch views to the transferred buffers before
    // calling.

    // world-space origin of this chunk, so per-position variation hashes world
    // coords. chunk-local would repeat the same pattern in every chunk.
    const wx0 = input.cx << CHUNK_BITS;
    const wy0 = input.cy << CHUNK_BITS;
    const wz0 = input.cz << CHUNK_BITS;

    const {
        cull: cullTable,
        blockTypeId: blockTypeIdTable,
        material: materialTable,
        modelType: modelTypeTable,
        cubeTexIndices,
        cubeFaceUVs,
        variantCount,
        variantBase,
        jitterXz,
        jitterY,
        meshId: meshIdTable,
        meshQuadMaterials,
        meshQuadUnshaded,
        meshTexIndices,
        meshQuadShape: meshQuadShapeTable,
        meshQuadFaceDir: meshQuadFaceDirTable,
        meshQuadCullFaceDir: meshQuadCullFaceDirTable,
        meshQuadDepth: meshQuadDepthTable,
        meshQuadVertDepth: meshQuadVertDepthTable,
        meshQuadVertNormal: meshQuadVertNormalTable,
        meshQuadCornerUV: meshQuadCornerUVTable,
        meshQuadCornerPos: meshQuadCornerPosTable,
        meshQuadCornerNormSq: meshQuadCornerNormSqTable,
        meshQuadNormal: meshQuadNormalTable,
        meshQuadUVs: meshQuadUVsTable,
        meshQuadVerts: meshQuadVertsTable,
        vertexAnimation: animTable,
        surfaceHeight: surfaceHeightTable,
        fluidGroup: fluidGroupTable,
        emissive: emissiveTable,
    } = registry;

    // populate _opaqueMaskSlab so mesh-quad shape dispatch (ALIGNED_*,
    // PARALLEL, NON_PARALLEL, IRREGULAR) can sample the same opaque
    // skip-mask the cube path uses inline. cube path still reads cullTable
    // inline; we don't double-write that loop.
    for (let i = 0; i < SLAB_VOLUME; i++) {
        _opaqueMaskSlab[i] = cullTable[_slab[i]!] === CULL_SOLID ? 1 : 0;
    }

    // reset all 21 unified scratch buckets (3 passes × 7 facings)
    for (let i = 0; i < SCRATCH_BUCKET_COUNT; i++) quadScratch[i]!.quadCount = 0;

    // aabb in chunk-local coords; promoted to world space at return.
    let aabbMinX = Infinity,
        aabbMinY = Infinity,
        aabbMinZ = Infinity;
    let aabbMaxX = -Infinity,
        aabbMaxY = -Infinity,
        aabbMaxZ = -Infinity;

    // ── main voxel iteration ────────────────────────────────────────

    for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const slabIdx = (y + 1) * SLAB_SIZE_SQ + (z + 1) * SLAB_SIZE + (x + 1);
                const stateId = _slab[slabIdx]!;

                if (stateId === AIR || stateId === MISSING) continue;

                const modelType = modelTypeTable[stateId]!;
                if (modelType === MODEL_NONE) continue;

                const myCull = cullTable[stateId]!;
                const myBlockTypeId = blockTypeIdTable[stateId]!;
                const animType = animTable[stateId]!;
                const materialKind = materialTable[stateId];

                // per-voxel: invalidate the 12 face caches so the first
                // emitQuadLightSmooth (or model AO bake) on this voxel
                // re-populates from this block's slab neighborhood. cache
                // key is (face, offset) only, without this, stale words
                // from previous voxels leak across blocks. cheap (26 byte
                // writes).
                resetFaceCaches();

                if (modelType === MODEL_CUBE) {
                    // ── cube path, unified quad emit ─────────────────
                    // bucket: pass × facing (FACE_TO_FACING). AO is no
                    // longer in the header, it's implicit in the
                    // smooth-light averaging baked into light.

                    const passBase =
                        materialKind === MAT_TRANSLUCENT
                            ? PASS_TRANSLUCENT_BASE
                            : materialKind === MAT_TRANSPARENT
                              ? PASS_TRANSPARENT_BASE
                              : PASS_OPAQUE_BASE;

                    // per-position variant: consecutive cube slots from variantBase.
                    const cubeVariants = variantCount[stateId]!;
                    const cubeSlot =
                        cubeVariants > 1 ? variantBase[stateId]! + (posHash(wx0 + x, wy0 + y, wz0 + z) % cubeVariants) : stateId;
                    const texBase = cubeSlot * 6;
                    const uvStateBase = cubeSlot * 48;

                    for (let face = 0; face < 6; face++) {
                        const faceStride = FACE_STRIDE[face]!;
                        const neighborId = _slab[slabIdx + faceStride]!;
                        const neighborCull = cullTable[neighborId] ?? CULL_NONE;
                        const neighborFluidGroup = fluidGroupTable[neighborId] ?? 0;
                        // ── cull type face culling ───────────────────
                        // should the face between this cube and the neighbor
                        // be hidden?
                        //   SOLID  (1): culls all. solid-solid = hidden.
                        //   SELF   (2): culled by solid. self-culls with same
                        //               block type id only. (leaves cull
                        //               leaves, water culls water, etc.)
                        //   PARTIAL(3): culled by solid. never culls others.
                        //   NONE   (0): never culls (air/missing).
                        // liquid neighbours don't cull cube faces, they
                        // occupy partial volume so the cube face stays
                        // visible through the empty band.
                        // a solid only hides the face if it shares this
                        // block's animType: differing types displace by
                        // different amounts in the shader, so the face has
                        // to survive as the cover for the sliver that opens
                        // when they separate. two static blocks are 0 === 0.
                        if (neighborFluidGroup === 0) {
                            if (neighborCull === CULL_SOLID && animTable[neighborId]! === animType) continue;
                            if (
                                neighborCull === CULL_SELF &&
                                myCull === CULL_SELF &&
                                myBlockTypeId === blockTypeIdTable[neighborId]!
                            )
                                continue;
                        }

                        // face survived a solid neighbour only because the two
                        // animate differently: it sits buried in that solid at
                        // rest, so its own cell lights it and nothing occludes
                        // it. sampling the neighbour would bake in the solid's
                        // black interior and show up the moment it separates.
                        const coversAnimSeam = neighborFluidGroup === 0 && neighborCull === CULL_SOLID;

                        const facing = FACE_TO_FACING[face]!;
                        const target = quadScratch[passBase + facing]!;
                        if (target.quadCount >= MAX_QUADS_PER_BUCKET) continue;

                        const textureIndex = cubeTexIndices[texBase + FACE_TEX_OFFSET[face]!]!;

                        // ── compute per-corner AO ─────────────────────
                        // Smooth light is emitted further down by
                        // `emitQuadLightSmooth/Emissive` reading the eager
                        // light slab. Sodium AoFaceData edge-share: 4 unique
                        // edges around the face-center cell, each shared by
                        // 2 corners. Diagonal sample is conditional, skip
                        // the read when both bracketing edges occlude
                        // (vertexAO returns 0).
                        const neighborSlabIdx = slabIdx + faceStride;
                        const edgeOffsetBase = face * 4;
                        const cornerEdgeBase = face * 8;
                        const eo0 = FACE_EDGE_OFFSETS[edgeOffsetBase]!;
                        const eo1 = FACE_EDGE_OFFSETS[edgeOffsetBase + 1]!;
                        const eo2 = FACE_EDGE_OFFSETS[edgeOffsetBase + 2]!;
                        const eo3 = FACE_EDGE_OFFSETS[edgeOffsetBase + 3]!;
                        _edgeOffset[0] = eo0;
                        _edgeOffset[1] = eo1;
                        _edgeOffset[2] = eo2;
                        _edgeOffset[3] = eo3;
                        _edgeOpaque[0] = cullTable[_slab[neighborSlabIdx + eo0]!] === CULL_SOLID ? 1 : 0;
                        _edgeOpaque[1] = cullTable[_slab[neighborSlabIdx + eo1]!] === CULL_SOLID ? 1 : 0;
                        _edgeOpaque[2] = cullTable[_slab[neighborSlabIdx + eo2]!] === CULL_SOLID ? 1 : 0;
                        _edgeOpaque[3] = cullTable[_slab[neighborSlabIdx + eo3]!] === CULL_SOLID ? 1 : 0;

                        const eA0 = FACE_CORNER_EDGES[cornerEdgeBase]!;
                        const eB0 = FACE_CORNER_EDGES[cornerEdgeBase + 1]!;
                        const eA1 = FACE_CORNER_EDGES[cornerEdgeBase + 2]!;
                        const eB1 = FACE_CORNER_EDGES[cornerEdgeBase + 3]!;
                        const eA2 = FACE_CORNER_EDGES[cornerEdgeBase + 4]!;
                        const eB2 = FACE_CORNER_EDGES[cornerEdgeBase + 5]!;
                        const eA3 = FACE_CORNER_EDGES[cornerEdgeBase + 6]!;
                        const eB3 = FACE_CORNER_EDGES[cornerEdgeBase + 7]!;

                        const sA0 = _edgeOpaque[eA0]!,
                            sB0 = _edgeOpaque[eB0]!;
                        const sA1 = _edgeOpaque[eA1]!,
                            sB1 = _edgeOpaque[eB1]!;
                        const sA2 = _edgeOpaque[eA2]!,
                            sB2 = _edgeOpaque[eB2]!;
                        const sA3 = _edgeOpaque[eA3]!,
                            sB3 = _edgeOpaque[eB3]!;

                        const c0 =
                            sA0 && sB0
                                ? 0
                                : cullTable[_slab[neighborSlabIdx + _edgeOffset[eA0]! + _edgeOffset[eB0]!]!] === CULL_SOLID
                                  ? 1
                                  : 0;
                        const c1 =
                            sA1 && sB1
                                ? 0
                                : cullTable[_slab[neighborSlabIdx + _edgeOffset[eA1]! + _edgeOffset[eB1]!]!] === CULL_SOLID
                                  ? 1
                                  : 0;
                        const c2 =
                            sA2 && sB2
                                ? 0
                                : cullTable[_slab[neighborSlabIdx + _edgeOffset[eA2]! + _edgeOffset[eB2]!]!] === CULL_SOLID
                                  ? 1
                                  : 0;
                        const c3 =
                            sA3 && sB3
                                ? 0
                                : cullTable[_slab[neighborSlabIdx + _edgeOffset[eA3]! + _edgeOffset[eB3]!]!] === CULL_SOLID
                                  ? 1
                                  : 0;

                        // raw occluder count → brightness via vanilla MC table
                        // (3 occluders → 0.5, 0 → 1.0). 4-bit quantized below.
                        const ao0 = sA0 && sB0 ? AO_BRIGHTNESS_TABLE[0]! : AO_BRIGHTNESS_TABLE[3 - sA0 - sB0 - c0]!;
                        const ao1 = sA1 && sB1 ? AO_BRIGHTNESS_TABLE[0]! : AO_BRIGHTNESS_TABLE[3 - sA1 - sB1 - c1]!;
                        const ao2 = sA2 && sB2 ? AO_BRIGHTNESS_TABLE[0]! : AO_BRIGHTNESS_TABLE[3 - sA2 - sB2 - c2]!;
                        const ao3 = sA3 && sB3 ? AO_BRIGHTNESS_TABLE[0]! : AO_BRIGHTNESS_TABLE[3 - sA3 - sB3 - c3]!;

                        // diagFlip lands in light[0] bit 29 inside
                        // `emitQuadLightSmooth` via `applyDiagFlipBit`.

                        // quantize brightness float in [0.5, 1.0] → 4 bits in [0, 15];
                        // shader recovers via bits/30 + 0.5.
                        const ao0Bits = Math.round((ao0 - 0.5) * 30) | 0;
                        const ao1Bits = Math.round((ao1 - 0.5) * 30) | 0;
                        const ao2Bits = Math.round((ao2 - 0.5) * 30) | 0;
                        const ao3Bits = Math.round((ao3 - 0.5) * 30) | 0;
                        const aoPacked = coversAnimSeam
                            ? AO_PACKED_UNOCCLUDED
                            : ao0Bits | (ao1Bits << 4) | (ao2Bits << 8) | (ao3Bits << 12);

                        const faceVertBase = face * 12;
                        const faceUvBase = uvStateBase + face * 8;
                        const normalPacked = FACE_OCT16[face]!;
                        const flags = packQuadFlags(textureIndex, animType, facing, emissiveTable[stateId]!);
                        const metaWord = packQuadMeta(aoPacked);
                        packQuadUVs(
                            cubeFaceUVs[faceUvBase]!,
                            cubeFaceUVs[faceUvBase + 1]!,
                            cubeFaceUVs[faceUvBase + 2]!,
                            cubeFaceUVs[faceUvBase + 3]!,
                            cubeFaceUVs[faceUvBase + 4]!,
                            cubeFaceUVs[faceUvBase + 5]!,
                            cubeFaceUVs[faceUvBase + 6]!,
                            cubeFaceUVs[faceUvBase + 7]!,
                        );

                        const quadIdx = target.quadCount;
                        writeQuadHeaderInt(
                            target,
                            quadIdx,
                            x + FACE_VERTS[faceVertBase]!,
                            y + FACE_VERTS[faceVertBase + 1]!,
                            z + FACE_VERTS[faceVertBase + 2]!,
                            x + FACE_VERTS[faceVertBase + 3]!,
                            y + FACE_VERTS[faceVertBase + 4]!,
                            z + FACE_VERTS[faceVertBase + 5]!,
                            x + FACE_VERTS[faceVertBase + 6]!,
                            y + FACE_VERTS[faceVertBase + 7]!,
                            z + FACE_VERTS[faceVertBase + 8]!,
                            x + FACE_VERTS[faceVertBase + 9]!,
                            y + FACE_VERTS[faceVertBase + 10]!,
                            z + FACE_VERTS[faceVertBase + 11]!,
                            normalPacked,
                            _uvPacked[0]!,
                            _uvPacked[1]!,
                            _uvPacked[2]!,
                            _uvPacked[3]!,
                            flags,
                            metaWord,
                            x,
                            y,
                            z,
                        );

                        target.quadCount++;

                        // aabb, cube cell spans (x..x+1, y..y+1, z..z+1)
                        if (x < aabbMinX) aabbMinX = x;
                        if (y < aabbMinY) aabbMinY = y;
                        if (z < aabbMinZ) aabbMinZ = z;
                        const xEnd = x + 1,
                            yEnd = y + 1,
                            zEnd = z + 1;
                        if (xEnd > aabbMaxX) aabbMaxX = xEnd;
                        if (yEnd > aabbMaxY) aabbMaxY = yEnd;
                        if (zEnd > aabbMaxZ) aabbMaxZ = zEnd;
                    }
                } else if (modelType === MODEL_LIQUID) {
                    // ── liquid path (model bucket) ────────────────────
                    //
                    // height-clipped cube. top quad sits at y + effectiveHeight,
                    // side quads clip V to match. same-fluid above merges
                    // upward (effectiveHeight = 1) so internal slabs vanish.

                    const passBase =
                        materialKind === MAT_TRANSLUCENT
                            ? PASS_TRANSLUCENT_BASE
                            : materialKind === MAT_TRANSPARENT
                              ? PASS_TRANSPARENT_BASE
                              : PASS_OPAQUE_BASE;

                    const texBase = stateId * 6;
                    const surfaceHeight = surfaceHeightTable[stateId]!;
                    const myFluidGroup = fluidGroupTable[stateId]!;

                    const upStride = FACE_STRIDE[2]!;
                    const aboveId = _slab[slabIdx + upStride]!;
                    // `top_is_same_liquid` (Luanti): the cell directly above is the
                    // same fluid, i.e. this cell is submerged in a merged column.
                    // gates same-fluid side culling + the surface height below.
                    const sameFluidAbove = myFluidGroup !== 0 && (fluidGroupTable[aboveId] ?? 0) === myFluidGroup;
                    // submerged cells fill the whole cell (merged column); an exposed
                    // cell sits at its surface level (meniscus). a non-fluid block
                    // above does NOT raise the surface, a lowered surface still shows
                    // its top through the gap beneath that block (Luanti getCornerLevel).
                    const effectiveHeight = sameFluidAbove ? 1 : surfaceHeight;

                    for (let face = 0; face < 6; face++) {
                        const faceStride = FACE_STRIDE[face]!;
                        const neighborId = _slab[slabIdx + faceStride]!;
                        const neighborCull = cullTable[neighborId] ?? CULL_NONE;
                        const neighborFluidGroup = fluidGroupTable[neighborId] ?? 0;
                        // `neighbor.top_is_same_liquid` (Luanti): the cell above the
                        // neighbour is the same fluid, i.e. the neighbour is itself
                        // submerged. only meaningful when the neighbour is same-fluid.
                        let sameFluidAboveNeighbor = false;
                        if (neighborFluidGroup !== 0) {
                            const aboveNeighborId = _slab[slabIdx + faceStride + upStride]!;
                            sameFluidAboveNeighbor = (fluidGroupTable[aboveNeighborId] ?? 0) === neighborFluidGroup;
                        }
                        // neighbour's exposed/merged surface height: a submerged neighbour
                        // fills its cell (1), an exposed one sits at its meniscus level.
                        // Only meaningful when the neighbour is the same fluid (a liquid).
                        const neighborEffectiveHeight = sameFluidAboveNeighbor ? 1 : (surfaceHeightTable[neighborId] ?? 0);
                        // ── face-aware cull for MODEL_LIQUID (Luanti) ─────
                        const sameFluid = myFluidGroup !== 0 && neighborFluidGroup === myFluidGroup;
                        // same rule as the cube path: a solid only occludes
                        // when it shares this block's animType, otherwise the
                        // two separate at runtime and the face is the cover.
                        const solidOccludes = neighborCull === CULL_SOLID && animTable[neighborId]! === animType;
                        const coversAnimSeam = neighborCull === CULL_SOLID && !solidOccludes;
                        if (face === 2) {
                            // TOP (drawLiquidTop: drawn iff !top_is_same_liquid).
                            // merged into the same-fluid column above → hidden.
                            // otherwise the surface shows, even under a solid block,
                            // a lowered surface is visible through the gap. only a
                            // full surface flush against a solid is occluded.
                            if (sameFluidAbove) continue;
                            if (effectiveHeight >= 1 && solidOccludes) continue;
                        } else if (face === 3) {
                            // BOTTOM (draw_bottom): hidden against same fluid below
                            // (merged column) or a solid floor.
                            if (sameFluid) continue;
                            if (solidOccludes) continue;
                        } else {
                            // SIDES (drawLiquidSides): a same-fluid side is the visible
                            // step down wherever OUR surface rises above the neighbour's,
                            // covering both a submerged column meeting a shallower pool
                            // (ours = 1) AND two exposed cells at different levels (e.g. a
                            // level-8 cell beside a level-4 one — neither submerged). Equal
                            // or higher neighbour → the face is interior, skip. `effective-
                            // Height` already folds the submerged case (== 1) and ignores a
                            // solid block above, so this stays a height test, not a flag.
                            // The riser is clipped to [neighbourSurface, ourSurface] below.
                            if (sameFluid) {
                                if (effectiveHeight <= neighborEffectiveHeight) continue;
                            } else if (solidOccludes) {
                                continue;
                            }
                        }

                        const facing = FACE_TO_FACING[face]!;
                        const target = quadScratch[passBase + facing]!;
                        if (target.quadCount >= MAX_QUADS_PER_BUCKET) continue;

                        const textureIndex = cubeTexIndices[texBase + FACE_TEX_OFFSET[face]!]!;
                        const neighborSlabIdx = slabIdx + faceStride;
                        const normalPacked = FACE_OCT16[face]!;
                        const faceVertBase = face * 12;
                        const faceUvBase = face * 8;
                        const isSide = face !== 2 && face !== 3;
                        // same-fluid step-down riser: clip the side's bottom to the
                        // neighbour's surface so the strip beneath (behind their body) isn't
                        // double-blended. 0 for air/solid-facing sides → full water column.
                        const sideBottom = isSide && sameFluid ? neighborEffectiveHeight : 0;
                        const topVClamp = isSide ? 1 - effectiveHeight : 0;

                        // Sodium AoFaceData edge-share: 4 unique edges around
                        // the face center, each shared by 2 corners; diagonal
                        // skipped when both bracketing edges occlude.
                        const edgeOffsetBase = face * 4;
                        const cornerEdgeBase = face * 8;
                        const eo0 = FACE_EDGE_OFFSETS[edgeOffsetBase]!;
                        const eo1 = FACE_EDGE_OFFSETS[edgeOffsetBase + 1]!;
                        const eo2 = FACE_EDGE_OFFSETS[edgeOffsetBase + 2]!;
                        const eo3 = FACE_EDGE_OFFSETS[edgeOffsetBase + 3]!;
                        _edgeOffset[0] = eo0;
                        _edgeOffset[1] = eo1;
                        _edgeOffset[2] = eo2;
                        _edgeOffset[3] = eo3;
                        _edgeOpaque[0] = cullTable[_slab[neighborSlabIdx + eo0]!] === CULL_SOLID ? 1 : 0;
                        _edgeOpaque[1] = cullTable[_slab[neighborSlabIdx + eo1]!] === CULL_SOLID ? 1 : 0;
                        _edgeOpaque[2] = cullTable[_slab[neighborSlabIdx + eo2]!] === CULL_SOLID ? 1 : 0;
                        _edgeOpaque[3] = cullTable[_slab[neighborSlabIdx + eo3]!] === CULL_SOLID ? 1 : 0;

                        let px0 = 0,
                            py0 = 0,
                            pz0 = 0;
                        let px1 = 0,
                            py1 = 0,
                            pz1 = 0;
                        let px2 = 0,
                            py2 = 0,
                            pz2 = 0;
                        let px3 = 0,
                            py3 = 0,
                            pz3 = 0;

                        // per-corner AO. positions/UVs stashed for writeQuadHeader below.
                        // Smooth light emitted further down via
                        // `emitQuadLightSmooth/Emissive` from the eager light slab.
                        for (let corner = 0; corner < 4; corner++) {
                            const edgeAIndex = FACE_CORNER_EDGES[cornerEdgeBase + corner * 2]!;
                            const edgeBIndex = FACE_CORNER_EDGES[cornerEdgeBase + corner * 2 + 1]!;
                            const side1 = _edgeOpaque[edgeAIndex]!;
                            const side2 = _edgeOpaque[edgeBIndex]!;
                            const bothOpaque = side1 && side2;
                            const ao = bothOpaque
                                ? AO_BRIGHTNESS_TABLE[0]!
                                : AO_BRIGHTNESS_TABLE[
                                      3 -
                                          side1 -
                                          side2 -
                                          (cullTable[
                                              _slab[neighborSlabIdx + _edgeOffset[edgeAIndex]! + _edgeOffset[edgeBIndex]!]!
                                          ] === CULL_SOLID
                                              ? 1
                                              : 0)
                                  ]!;

                            const vertOffset = faceVertBase + corner * 3;
                            const uvOffset = faceUvBase + corner * 2;
                            const cornerY = FACE_VERTS[vertOffset + 1]!;
                            const cornerV = FACE_UVS[uvOffset + 1]!;
                            const px = x + FACE_VERTS[vertOffset]!;
                            const py = y + (cornerY === 1 ? effectiveHeight : sideBottom);
                            const pz = z + FACE_VERTS[vertOffset + 2]!;
                            // side V spans [1-ourSurface, 1-sideBottom]; sideBottom=0 → V=1
                            // at the base as before, a clipped riser maps the strip's texture.
                            const finalV = isSide ? (cornerV === 0 ? topVClamp : 1 - sideBottom) : cornerV;

                            if (corner === 0) {
                                px0 = px;
                                py0 = py;
                                pz0 = pz;
                            } else if (corner === 1) {
                                px1 = px;
                                py1 = py;
                                pz1 = pz;
                            } else if (corner === 2) {
                                px2 = px;
                                py2 = py;
                                pz2 = pz;
                            } else {
                                px3 = px;
                                py3 = py;
                                pz3 = pz;
                            }

                            _liquidUvRaw[corner * 2] = FACE_UVS[uvOffset]!;
                            _liquidUvRaw[corner * 2 + 1] = finalV;
                            _liquidAoScratch[corner] = ao;

                            if (px < aabbMinX) aabbMinX = px;
                            if (py < aabbMinY) aabbMinY = py;
                            if (pz < aabbMinZ) aabbMinZ = pz;
                            if (px > aabbMaxX) aabbMaxX = px;
                            if (py > aabbMaxY) aabbMaxY = py;
                            if (pz > aabbMaxZ) aabbMaxZ = pz;
                        }

                        // diagFlip lands in light[0] bit 29 via
                        // `emitQuadLightSmooth` → `applyDiagFlipBit`.
                        const a0 = _liquidAoScratch[0]!;
                        const a1 = _liquidAoScratch[1]!;
                        const a2 = _liquidAoScratch[2]!;
                        const a3 = _liquidAoScratch[3]!;
                        const a0Bits = Math.round((a0 - 0.5) * 30) | 0;
                        const a1Bits = Math.round((a1 - 0.5) * 30) | 0;
                        const a2Bits = Math.round((a2 - 0.5) * 30) | 0;
                        const a3Bits = Math.round((a3 - 0.5) * 30) | 0;
                        const aoPacked = coversAnimSeam
                            ? AO_PACKED_UNOCCLUDED
                            : a0Bits | (a1Bits << 4) | (a2Bits << 8) | (a3Bits << 12);

                        const flags = packQuadFlags(textureIndex, animType, facing, emissiveTable[stateId]!);
                        const metaWord = packQuadMeta(aoPacked);
                        packQuadUVs(
                            _liquidUvRaw[0]!,
                            _liquidUvRaw[1]!,
                            _liquidUvRaw[2]!,
                            _liquidUvRaw[3]!,
                            _liquidUvRaw[4]!,
                            _liquidUvRaw[5]!,
                            _liquidUvRaw[6]!,
                            _liquidUvRaw[7]!,
                        );
                        const liquidQuadIdx = target.quadCount;
                        writeQuadHeader(
                            target,
                            liquidQuadIdx,
                            px0,
                            py0,
                            pz0,
                            px1,
                            py1,
                            pz1,
                            px2,
                            py2,
                            pz2,
                            px3,
                            py3,
                            pz3,
                            normalPacked,
                            _uvPacked[0]!,
                            _uvPacked[1]!,
                            _uvPacked[2]!,
                            _uvPacked[3]!,
                            flags,
                            metaWord,
                            x,
                            y,
                            z,
                        );
                        target.quadCount++;
                    }
                } else if (modelType === MODEL_MESH) {
                    // ── custom mesh path, sodium-style shape dispatch ─
                    // each BlockQuad → one quad in the (pass, facing) bucket.
                    // facing comes from the quad's normal (axis-aligned →
                    // cardinal, else UNASSIGNED). per-vertex smooth-light +
                    // AO dispatched on the registry's shape tag:
                    //   FLAT, host-cell light, no AO
                    //   ALIGNED_*, bilerp face cache at quad-vert (u,w)
                    //   PARALLEL, blend offset/non-offset by uniform depth
                    //   NON_PARALLEL, same blend, per-vertex depth
                    //   IRREGULAR, 3 axis face caches, weighted by n²
                    // render-only positional jitter. y is left OUT of the hash so a
                    // vertical stack shares one offset; the vertical component is
                    // downward only, so plants sink rather than float.
                    const jxzMax = jitterXz[stateId]!;
                    const jyMax = jitterY[stateId]!;
                    let jx = 0;
                    let jy = 0;
                    let jz = 0;
                    if (jxzMax !== 0 || jyMax !== 0) {
                        const jh = posHash(wx0 + x, 0, wz0 + z);
                        if (jxzMax !== 0) {
                            const scale = jxzMax / 255;
                            jx = (((jh & 0xf) / 15) * 2 - 1) * scale;
                            jz = ((((jh >>> 8) & 0xf) / 15) * 2 - 1) * scale;
                        }
                        if (jyMax !== 0) jy = -(((jh >>> 4) & 0xf) / 15) * (jyMax / 255);
                    }

                    // per-position variant: consecutive meshIds from variantBase.
                    const meshVariants = variantCount[stateId]!;
                    const meshId =
                        meshVariants > 1
                            ? variantBase[stateId]! + (posHash(wx0 + x, wy0 + y, wz0 + z) % meshVariants)
                            : meshIdTable[stateId]!;
                    const quadTexIndices = meshTexIndices[meshId]!;
                    const quadMaterials = meshQuadMaterials[meshId]!;
                    const qUnshaded = meshQuadUnshaded[meshId]!;
                    const qShape = meshQuadShapeTable[meshId]!;
                    const qFaceDir = meshQuadFaceDirTable[meshId]!;
                    const qCullFaceDir = meshQuadCullFaceDirTable[meshId]!;
                    const qDepth = meshQuadDepthTable[meshId]!;
                    const qVertDepth = meshQuadVertDepthTable[meshId]!;
                    const qVertNormal = meshQuadVertNormalTable[meshId]!;
                    const qCornerUV = meshQuadCornerUVTable[meshId]!;
                    const qCornerPos = meshQuadCornerPosTable[meshId]!;
                    const qCornerNormSq = meshQuadCornerNormSqTable[meshId]!;
                    const qNormal = meshQuadNormalTable[meshId]!;
                    const qUVs = meshQuadUVsTable[meshId]!;
                    const qVerts = meshQuadVertsTable[meshId]!;

                    const quadCount = qShape.length;
                    for (let qi = 0; qi < quadCount; qi++) {
                        const cfDir = qCullFaceDir[qi]!;
                        // same rule as the cube path: a solid neighbour only
                        // hides this quad when it shares the block's animType.
                        let coversAnimSeam = false;
                        if (cfDir !== FACE_DIR_NONE) {
                            const neighborId = _slab[slabIdx + FACE_STRIDE[cfDir]!]!;
                            const neighborCull = cullTable[neighborId] ?? CULL_NONE;
                            if (neighborCull === CULL_SOLID) {
                                if (animTable[neighborId]! === animType) continue;
                                coversAnimSeam = true;
                            }
                            if (
                                neighborCull === CULL_SELF &&
                                myCull === CULL_SELF &&
                                myBlockTypeId === blockTypeIdTable[neighborId]!
                            )
                                continue;
                        }

                        // per-quad material routing, a single block can emit
                        // into multiple passes (cauldron: opaque shell +
                        // translucent water).
                        const quadMaterial = quadMaterials[qi]!;
                        const passBase =
                            quadMaterial === MAT_TRANSLUCENT
                                ? PASS_TRANSLUCENT_BASE
                                : quadMaterial === MAT_TRANSPARENT
                                  ? PASS_TRANSPARENT_BASE
                                  : PASS_OPAQUE_BASE;

                        const nBase = qi * 3;
                        const nx = qNormal[nBase]!;
                        const ny = qNormal[nBase + 1]!;
                        const nz = qNormal[nBase + 2]!;
                        const facing = classifyFacing(nx, ny, nz);
                        const target = quadScratch[passBase + facing]!;
                        if (target.quadCount >= MAX_QUADS_PER_BUCKET) continue;

                        const textureIndex = quadTexIndices[qi]!;
                        const normalPacked = encodeOct16(nx, ny, nz);
                        const uvBase = qi * 8;

                        // ── per-vert AO via shape dispatch ────────────
                        // smooth-light is emitted further down via
                        // emitQuadLightSmooth/Flat/Emissive against the 18³
                        // light slab, so AO cache helpers here only consume
                        // the opaque-mask slab.
                        const shape = qShape[qi]!;
                        if (shape === SHAPE_FLAT) {
                            _meshAoScratch[0] =
                                _meshAoScratch[1] =
                                _meshAoScratch[2] =
                                _meshAoScratch[3] =
                                    AO_BRIGHTNESS_TABLE[3]!;
                        } else if (shape === SHAPE_IRREGULAR) {
                            // Sodium applyIrregularFace: per-vert weighted-mean over
                            // the 3 axis face caches, weights = n_a². face direction
                            // per axis is the sign of n_a. each axis's slot comes
                            // from gatherInsetFaceForAxis, a face-level depth blend
                            // (Sodium's gatherInsetFace) between offset_true and
                            // offset_false written into SLOT_SCRATCH. one bilerp per
                            // axis instead of two bilerps + 5-channel pasta.
                            for (let v = 0; v < 4; v++) {
                                const nsBase = qi * 12 + v * 3;
                                const nsx = qCornerNormSq[nsBase]!;
                                const nsy = qCornerNormSq[nsBase + 1]!;
                                const nsz = qCornerNormSq[nsBase + 2]!;
                                const nx = qVertNormal[nsBase]!;
                                const ny = qVertNormal[nsBase + 1]!;
                                const nz = qVertNormal[nsBase + 2]!;
                                const pBase = qi * 12 + v * 3;
                                const vx = qCornerPos[pBase]!;
                                const vy = qCornerPos[pBase + 1]!;
                                const vz = qCornerPos[pBase + 2]!;

                                let aoAcc = 0,
                                    wAcc = 0;

                                if (nsx > 0) {
                                    const positive = nx >= 0;
                                    const face = positive ? 0 : 1;
                                    const depth = positive ? 1 - vx : vx;
                                    const slot = gatherInsetFaceForAxis(slabIdx, face, depth, _opaqueMaskSlab);
                                    const fb = face * 8;
                                    const u0 = AO_FACE_UW_PER_CORNER[fb]!,
                                        w0p = AO_FACE_UW_PER_CORNER[fb + 1]!;
                                    const u1 = AO_FACE_UW_PER_CORNER[fb + 2]!,
                                        w1p = AO_FACE_UW_PER_CORNER[fb + 3]!;
                                    const u2 = AO_FACE_UW_PER_CORNER[fb + 4]!,
                                        w2p = AO_FACE_UW_PER_CORNER[fb + 5]!;
                                    const u3 = AO_FACE_UW_PER_CORNER[fb + 6]!,
                                        w3p = AO_FACE_UW_PER_CORNER[fb + 7]!;
                                    const bw0 = (1 - Math.abs(vz - u0)) * (1 - Math.abs(vy - w0p));
                                    const bw1 = (1 - Math.abs(vz - u1)) * (1 - Math.abs(vy - w1p));
                                    const bw2 = (1 - Math.abs(vz - u2)) * (1 - Math.abs(vy - w2p));
                                    const bw3 = (1 - Math.abs(vz - u3)) * (1 - Math.abs(vy - w3p));
                                    aoAcc += nsx * getBlendedAo(slot, bw0, bw1, bw2, bw3);
                                    wAcc += nsx;
                                }
                                if (nsy > 0) {
                                    const positive = ny >= 0;
                                    const face = positive ? 2 : 3;
                                    const depth = positive ? 1 - vy : vy;
                                    const slot = gatherInsetFaceForAxis(slabIdx, face, depth, _opaqueMaskSlab);
                                    const fb = face * 8;
                                    const u0 = AO_FACE_UW_PER_CORNER[fb]!,
                                        w0p = AO_FACE_UW_PER_CORNER[fb + 1]!;
                                    const u1 = AO_FACE_UW_PER_CORNER[fb + 2]!,
                                        w1p = AO_FACE_UW_PER_CORNER[fb + 3]!;
                                    const u2 = AO_FACE_UW_PER_CORNER[fb + 4]!,
                                        w2p = AO_FACE_UW_PER_CORNER[fb + 5]!;
                                    const u3 = AO_FACE_UW_PER_CORNER[fb + 6]!,
                                        w3p = AO_FACE_UW_PER_CORNER[fb + 7]!;
                                    const bw0 = (1 - Math.abs(vx - u0)) * (1 - Math.abs(vz - w0p));
                                    const bw1 = (1 - Math.abs(vx - u1)) * (1 - Math.abs(vz - w1p));
                                    const bw2 = (1 - Math.abs(vx - u2)) * (1 - Math.abs(vz - w2p));
                                    const bw3 = (1 - Math.abs(vx - u3)) * (1 - Math.abs(vz - w3p));
                                    aoAcc += nsy * getBlendedAo(slot, bw0, bw1, bw2, bw3);
                                    wAcc += nsy;
                                }
                                if (nsz > 0) {
                                    const positive = nz >= 0;
                                    const face = positive ? 4 : 5;
                                    const depth = positive ? 1 - vz : vz;
                                    const slot = gatherInsetFaceForAxis(slabIdx, face, depth, _opaqueMaskSlab);
                                    const fb = face * 8;
                                    const u0 = AO_FACE_UW_PER_CORNER[fb]!,
                                        w0p = AO_FACE_UW_PER_CORNER[fb + 1]!;
                                    const u1 = AO_FACE_UW_PER_CORNER[fb + 2]!,
                                        w1p = AO_FACE_UW_PER_CORNER[fb + 3]!;
                                    const u2 = AO_FACE_UW_PER_CORNER[fb + 4]!,
                                        w2p = AO_FACE_UW_PER_CORNER[fb + 5]!;
                                    const u3 = AO_FACE_UW_PER_CORNER[fb + 6]!,
                                        w3p = AO_FACE_UW_PER_CORNER[fb + 7]!;
                                    const bw0 = (1 - Math.abs(vx - u0)) * (1 - Math.abs(vy - w0p));
                                    const bw1 = (1 - Math.abs(vx - u1)) * (1 - Math.abs(vy - w1p));
                                    const bw2 = (1 - Math.abs(vx - u2)) * (1 - Math.abs(vy - w2p));
                                    const bw3 = (1 - Math.abs(vx - u3)) * (1 - Math.abs(vy - w3p));
                                    aoAcc += nsz * getBlendedAo(slot, bw0, bw1, bw2, bw3);
                                    wAcc += nsz;
                                }

                                if (wAcc > 0) {
                                    _meshAoScratch[v] = aoAcc / wAcc;
                                } else {
                                    _meshAoScratch[v] = AO_BRIGHTNESS_TABLE[3]!;
                                }
                            }
                        } else if (shape === SHAPE_ALIGNED_FULL) {
                            // Sodium applyAlignedFullFace: every quad-vert sits on
                            // exactly one face cache corner. Skip the bilerp pipeline
                            // entirely, direct cache slot read. Depth is either ≈0
                            // (offset_true) or ≈1 (offset_false), pick the right slot
                            // once for all 4 verts. Most common mesh shape (slabs,
                            // half-blocks, axis-aligned sub-regions).
                            const faceDir = qFaceDir[qi]!;
                            const offset = qDepth[qi]! > 0.5 ? 0 : 1;
                            const slot = ensureFaceCache(slabIdx, faceDir, offset, _opaqueMaskSlab);
                            const slotBase = slot * 4;
                            const hashBase = faceDir * 4;
                            for (let v = 0; v < 4; v++) {
                                const u = qCornerUV[qi * 8 + v * 2]!;
                                const w = qCornerUV[qi * 8 + v * 2 + 1]!;
                                const hash = (u >= 0.5 ? 2 : 0) | (w >= 0.5 ? 1 : 0);
                                const idx = slotBase + FACE_UV_HASH_TO_CORNER[hashBase + hash]!;
                                _meshAoScratch[v] = _faceCacheAo[idx]!;
                            }
                        } else {
                            // ALIGNED_PARTIAL | PARALLEL | NON_PARALLEL, Sodium's
                            // applyAlignedPartialFace / applyParallelFace / applyInsetPartialFaceVertex.
                            // Uniform-depth shapes blend once outside the loop;
                            // NON_PARALLEL blends per-vert into SLOT_SCRATCH.
                            const faceDir = qFaceDir[qi]!;
                            const uwBase = faceDir * 8;
                            const perVertDepth = shape === SHAPE_NON_PARALLEL;
                            const uniformSlot = perVertDepth
                                ? 0
                                : gatherInsetFaceForAxis(slabIdx, faceDir, qDepth[qi]!, _opaqueMaskSlab);

                            for (let v = 0; v < 4; v++) {
                                const u = qCornerUV[qi * 8 + v * 2]!;
                                const w = qCornerUV[qi * 8 + v * 2 + 1]!;
                                const slot = perVertDepth
                                    ? gatherInsetFaceForAxis(slabIdx, faceDir, qVertDepth[qi * 4 + v]!, _opaqueMaskSlab)
                                    : uniformSlot;

                                const u0 = AO_FACE_UW_PER_CORNER[uwBase]!,
                                    w0p = AO_FACE_UW_PER_CORNER[uwBase + 1]!;
                                const u1 = AO_FACE_UW_PER_CORNER[uwBase + 2]!,
                                    w1p = AO_FACE_UW_PER_CORNER[uwBase + 3]!;
                                const u2 = AO_FACE_UW_PER_CORNER[uwBase + 4]!,
                                    w2p = AO_FACE_UW_PER_CORNER[uwBase + 5]!;
                                const u3 = AO_FACE_UW_PER_CORNER[uwBase + 6]!,
                                    w3p = AO_FACE_UW_PER_CORNER[uwBase + 7]!;
                                const bw0 = (1 - Math.abs(u - u0)) * (1 - Math.abs(w - w0p));
                                const bw1 = (1 - Math.abs(u - u1)) * (1 - Math.abs(w - w1p));
                                const bw2 = (1 - Math.abs(u - u2)) * (1 - Math.abs(w - w2p));
                                const bw3 = (1 - Math.abs(u - u3)) * (1 - Math.abs(w - w3p));

                                _meshAoScratch[v] = getBlendedAo(slot, bw0, bw1, bw2, bw3);
                            }
                        }

                        // diagFlip is applied per-light by applyDiagFlipBit
                        // inside emitQuadLightSmooth/Flat (light[0].bit29).
                        const ao0 = _meshAoScratch[0]!;
                        const ao1 = _meshAoScratch[1]!;
                        const ao2 = _meshAoScratch[2]!;
                        const ao3 = _meshAoScratch[3]!;
                        const ao0Bits = Math.round((ao0 - 0.5) * 30) | 0;
                        const ao1Bits = Math.round((ao1 - 0.5) * 30) | 0;
                        const ao2Bits = Math.round((ao2 - 0.5) * 30) | 0;
                        const ao3Bits = Math.round((ao3 - 0.5) * 30) | 0;
                        const aoPacked = coversAnimSeam
                            ? AO_PACKED_UNOCCLUDED
                            : ao0Bits | (ao1Bits << 4) | (ao2Bits << 8) | (ao3Bits << 12);

                        const vBase = qi * 12;
                        const ox = x + jx,
                            oy = y + jy,
                            oz = z + jz;
                        const px0 = ox + qVerts[vBase]!,
                            py0 = oy + qVerts[vBase + 1]!,
                            pz0 = oz + qVerts[vBase + 2]!;
                        const px1 = ox + qVerts[vBase + 3]!,
                            py1 = oy + qVerts[vBase + 4]!,
                            pz1 = oz + qVerts[vBase + 5]!;
                        const px2 = ox + qVerts[vBase + 6]!,
                            py2 = oy + qVerts[vBase + 7]!,
                            pz2 = oz + qVerts[vBase + 8]!;
                        const px3 = ox + qVerts[vBase + 9]!,
                            py3 = oy + qVerts[vBase + 10]!,
                            pz3 = oz + qVerts[vBase + 11]!;

                        const flags = packQuadFlags(textureIndex, animType, facing, emissiveTable[stateId]!, qUnshaded[qi]!);
                        const metaWord = packQuadMeta(aoPacked);
                        packQuadUVs(
                            qUVs[uvBase]!,
                            qUVs[uvBase + 1]!,
                            qUVs[uvBase + 2]!,
                            qUVs[uvBase + 3]!,
                            qUVs[uvBase + 4]!,
                            qUVs[uvBase + 5]!,
                            qUVs[uvBase + 6]!,
                            qUVs[uvBase + 7]!,
                        );

                        const quadIdx = target.quadCount;
                        writeQuadHeader(
                            target,
                            quadIdx,
                            px0,
                            py0,
                            pz0,
                            px1,
                            py1,
                            pz1,
                            px2,
                            py2,
                            pz2,
                            px3,
                            py3,
                            pz3,
                            normalPacked,
                            _uvPacked[0]!,
                            _uvPacked[1]!,
                            _uvPacked[2]!,
                            _uvPacked[3]!,
                            flags,
                            metaWord,
                            x,
                            y,
                            z,
                        );

                        target.quadCount++;

                        if (px0 < aabbMinX) aabbMinX = px0;
                        if (py0 < aabbMinY) aabbMinY = py0;
                        if (pz0 < aabbMinZ) aabbMinZ = pz0;
                        if (px0 > aabbMaxX) aabbMaxX = px0;
                        if (py0 > aabbMaxY) aabbMaxY = py0;
                        if (pz0 > aabbMaxZ) aabbMaxZ = pz0;
                        if (px1 < aabbMinX) aabbMinX = px1;
                        if (py1 < aabbMinY) aabbMinY = py1;
                        if (pz1 < aabbMinZ) aabbMinZ = pz1;
                        if (px1 > aabbMaxX) aabbMaxX = px1;
                        if (py1 > aabbMaxY) aabbMaxY = py1;
                        if (pz1 > aabbMaxZ) aabbMaxZ = pz1;
                        if (px2 < aabbMinX) aabbMinX = px2;
                        if (py2 < aabbMinY) aabbMinY = py2;
                        if (pz2 < aabbMinZ) aabbMinZ = pz2;
                        if (px2 > aabbMaxX) aabbMaxX = px2;
                        if (py2 > aabbMaxY) aabbMaxY = py2;
                        if (pz2 > aabbMaxZ) aabbMaxZ = pz2;
                        if (px3 < aabbMinX) aabbMinX = px3;
                        if (py3 < aabbMinY) aabbMinY = py3;
                        if (pz3 < aabbMinZ) aabbMinZ = pz3;
                        if (px3 > aabbMaxX) aabbMaxX = px3;
                        if (py3 > aabbMaxY) aabbMaxY = py3;
                        if (pz3 > aabbMaxZ) aabbMaxZ = pz3;
                    }
                }
            }
        }
    }

    const opaque = finishPassMesh(PASS_OPAQUE_BASE, out.opaque);
    const transparent = finishPassMesh(PASS_TRANSPARENT_BASE, out.transparent);
    const translucent = finishPassMesh(PASS_TRANSLUCENT_BASE, out.translucent);

    if (!opaque && !transparent && !translucent) return null;

    // promote chunk-local aabb to world space (chunk origin + local).
    const worldX = input.cx << CHUNK_BITS;
    const worldY = input.cy << CHUNK_BITS;
    const worldZ = input.cz << CHUNK_BITS;
    const aabb = {
        min: [worldX + aabbMinX, worldY + aabbMinY, worldZ + aabbMinZ] as [number, number, number],
        max: [worldX + aabbMaxX, worldY + aabbMaxY, worldZ + aabbMaxZ] as [number, number, number],
    };

    return { opaque, transparent, translucent, aabb };
}
