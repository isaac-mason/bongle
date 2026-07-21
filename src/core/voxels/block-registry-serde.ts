// ── BlockRegistry serde (worker boundary) ──────────────────────────
//
// Encode the subset of `BlockRegistry` the mesher reads into one
// `ArrayBuffer` for transferable `postMessage`. Decode constructs
// typed-array views over the same buffer (no copies) and returns a
// partial `BlockRegistry`, only mesher-read fields are populated;
// physics/handle/Map fields stay undefined and the worker never
// touches them.
//
// To add a new mesher-read field: extend the header offsets table,
// the layout block, the write block, and the read block. Four edits,
// all visible in this file.

import type { Blocks } from './block-registry';

// stored as unsigned in the Uint32Array slot; compare unsigned-to-unsigned
// to avoid surprises with high-bit literals (`0xb7e61571 | 0` is negative).
const MAGIC = 0xb7e61571;

// ── header layout (u32 indices) ────────────────────────────────────

const H_MAGIC = 0;
const H_VERSION = 1;
const H_TOTAL_STATES = 2;
const H_MESH_COUNT = 3;
const H_TOTAL_QUADS = 4;
const H_MESH_QUAD_COUNT = 5; // Uint16Array[meshCount + 1], quads per mesh slot
// per-state byte offsets
const H_CULL = 6;
const H_BLOCK_TYPE_ID = 7;
const H_MATERIAL = 8;
const H_MODEL_TYPE = 9;
const H_CUBE_TEX_INDICES = 10;
const H_CUBE_FACE_UVS = 11;
const H_MESH_ID = 12;
const H_VERTEX_ANIMATION = 13;
const H_SURFACE_HEIGHT = 14;
const H_FLUID_GROUP = 15;
const H_EMISSIVE = 16;
// per-mesh byte offsets (each field is one concat blob across slots 1..meshCount)
const H_MESH_TEX_INDICES = 17;
const H_MESH_QUAD_MATERIALS = 18;
const H_MESH_QUAD_SHAPE = 19;
const H_MESH_QUAD_FACE_DIR = 20;
const H_MESH_QUAD_CULL_FACE_DIR = 21;
const H_MESH_QUAD_DEPTH = 22;
const H_MESH_QUAD_VERT_DEPTH = 23;
const H_MESH_QUAD_VERT_NORMAL = 24;
const H_MESH_QUAD_CORNER_UV = 25;
const H_MESH_QUAD_CORNER_POS = 26;
const H_MESH_QUAD_CORNER_NORM_SQ = 27;
const H_MESH_QUAD_NORMAL = 28;
const H_MESH_QUAD_UVS = 29;
const H_MESH_QUAD_VERTS = 30;

const HEADER_U32S = 31;
const HEADER_BYTES = HEADER_U32S * 4;

// per-quad element counts for per-mesh fields (stride × element size = bytes per quad)
const STRIDE_MESH_TEX_INDICES = 1;
const STRIDE_MESH_QUAD_MATERIALS = 1;
const STRIDE_MESH_QUAD_SHAPE = 1;
const STRIDE_MESH_QUAD_FACE_DIR = 1;
const STRIDE_MESH_QUAD_CULL_FACE_DIR = 1;
const STRIDE_MESH_QUAD_DEPTH = 1;
const STRIDE_MESH_QUAD_VERT_DEPTH = 4;
const STRIDE_MESH_QUAD_VERT_NORMAL = 12;
const STRIDE_MESH_QUAD_CORNER_UV = 8;
const STRIDE_MESH_QUAD_CORNER_POS = 12;
const STRIDE_MESH_QUAD_CORNER_NORM_SQ = 12;
const STRIDE_MESH_QUAD_NORMAL = 3;
const STRIDE_MESH_QUAD_UVS = 8;
const STRIDE_MESH_QUAD_VERTS = 12;

function align8(n: number): number {
    return (n + 7) & ~7;
}

function copyBytes(dst: Uint8Array, src: ArrayBufferView, dstOffset: number): void {
    dst.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength), dstOffset);
}

// ── encode ─────────────────────────────────────────────────────────

export function serializeBlockRegistryForWorker(reg: Blocks, version: number): ArrayBuffer {
    const totalStates = reg.totalStates;
    const meshCount = reg.meshQuads.length - 1; // slot 0 is sentinel

    // sum of per-slot quad counts (drives every per-mesh field's blob length).
    let totalQuads = 0;
    for (let m = 1; m <= meshCount; m++) totalQuads += reg.meshQuadShape[m]!.length;

    // ── phase 1: layout ────────────────────────────────────────────
    let c = HEADER_BYTES;

    c = align8(c);
    const oMeshQuadCount = c;
    c += (meshCount + 1) * 2;

    c = align8(c);
    const oCull = c;
    c += totalStates * 1;
    c = align8(c);
    const oBlockTypeId = c;
    c += totalStates * 2;
    c = align8(c);
    const oMaterial = c;
    c += totalStates * 1;
    c = align8(c);
    const oModelType = c;
    c += totalStates * 1;
    c = align8(c);
    const oCubeTexIndices = c;
    c += totalStates * 6 * 2;
    c = align8(c);
    const oCubeFaceUVs = c;
    c += totalStates * 48 * 1;
    c = align8(c);
    const oMeshId = c;
    c += totalStates * 2;
    c = align8(c);
    const oVertexAnimation = c;
    c += totalStates * 1;
    c = align8(c);
    const oSurfaceHeight = c;
    c += totalStates * 4;
    c = align8(c);
    const oFluidGroup = c;
    c += totalStates * 2;
    c = align8(c);
    const oEmissive = c;
    c += totalStates * 1;

    c = align8(c);
    const oMeshTexIndices = c;
    c += totalQuads * STRIDE_MESH_TEX_INDICES * 2;
    c = align8(c);
    const oMeshQuadMaterials = c;
    c += totalQuads * STRIDE_MESH_QUAD_MATERIALS * 1;
    c = align8(c);
    const oMeshQuadShape = c;
    c += totalQuads * STRIDE_MESH_QUAD_SHAPE * 1;
    c = align8(c);
    const oMeshQuadFaceDir = c;
    c += totalQuads * STRIDE_MESH_QUAD_FACE_DIR * 1;
    c = align8(c);
    const oMeshQuadCullFaceDir = c;
    c += totalQuads * STRIDE_MESH_QUAD_CULL_FACE_DIR * 1;
    c = align8(c);
    const oMeshQuadDepth = c;
    c += totalQuads * STRIDE_MESH_QUAD_DEPTH * 4;
    c = align8(c);
    const oMeshQuadVertDepth = c;
    c += totalQuads * STRIDE_MESH_QUAD_VERT_DEPTH * 4;
    c = align8(c);
    const oMeshQuadVertNormal = c;
    c += totalQuads * STRIDE_MESH_QUAD_VERT_NORMAL * 4;
    c = align8(c);
    const oMeshQuadCornerUV = c;
    c += totalQuads * STRIDE_MESH_QUAD_CORNER_UV * 4;
    c = align8(c);
    const oMeshQuadCornerPos = c;
    c += totalQuads * STRIDE_MESH_QUAD_CORNER_POS * 4;
    c = align8(c);
    const oMeshQuadCornerNormSq = c;
    c += totalQuads * STRIDE_MESH_QUAD_CORNER_NORM_SQ * 4;
    c = align8(c);
    const oMeshQuadNormal = c;
    c += totalQuads * STRIDE_MESH_QUAD_NORMAL * 4;
    c = align8(c);
    const oMeshQuadUVs = c;
    c += totalQuads * STRIDE_MESH_QUAD_UVS * 4;
    c = align8(c);
    const oMeshQuadVerts = c;
    c += totalQuads * STRIDE_MESH_QUAD_VERTS * 4;

    const buf = new ArrayBuffer(align8(c));
    const u32 = new Uint32Array(buf);
    const u8 = new Uint8Array(buf);

    // ── phase 2: header ────────────────────────────────────────────
    u32[H_MAGIC] = MAGIC;
    u32[H_VERSION] = version | 0;
    u32[H_TOTAL_STATES] = totalStates;
    u32[H_MESH_COUNT] = meshCount;
    u32[H_TOTAL_QUADS] = totalQuads;
    u32[H_MESH_QUAD_COUNT] = oMeshQuadCount;
    u32[H_CULL] = oCull;
    u32[H_BLOCK_TYPE_ID] = oBlockTypeId;
    u32[H_MATERIAL] = oMaterial;
    u32[H_MODEL_TYPE] = oModelType;
    u32[H_CUBE_TEX_INDICES] = oCubeTexIndices;
    u32[H_CUBE_FACE_UVS] = oCubeFaceUVs;
    u32[H_MESH_ID] = oMeshId;
    u32[H_VERTEX_ANIMATION] = oVertexAnimation;
    u32[H_SURFACE_HEIGHT] = oSurfaceHeight;
    u32[H_FLUID_GROUP] = oFluidGroup;
    u32[H_EMISSIVE] = oEmissive;
    u32[H_MESH_TEX_INDICES] = oMeshTexIndices;
    u32[H_MESH_QUAD_MATERIALS] = oMeshQuadMaterials;
    u32[H_MESH_QUAD_SHAPE] = oMeshQuadShape;
    u32[H_MESH_QUAD_FACE_DIR] = oMeshQuadFaceDir;
    u32[H_MESH_QUAD_CULL_FACE_DIR] = oMeshQuadCullFaceDir;
    u32[H_MESH_QUAD_DEPTH] = oMeshQuadDepth;
    u32[H_MESH_QUAD_VERT_DEPTH] = oMeshQuadVertDepth;
    u32[H_MESH_QUAD_VERT_NORMAL] = oMeshQuadVertNormal;
    u32[H_MESH_QUAD_CORNER_UV] = oMeshQuadCornerUV;
    u32[H_MESH_QUAD_CORNER_POS] = oMeshQuadCornerPos;
    u32[H_MESH_QUAD_CORNER_NORM_SQ] = oMeshQuadCornerNormSq;
    u32[H_MESH_QUAD_NORMAL] = oMeshQuadNormal;
    u32[H_MESH_QUAD_UVS] = oMeshQuadUVs;
    u32[H_MESH_QUAD_VERTS] = oMeshQuadVerts;

    // ── phase 3: meshQuadCount + per-state bodies ─────────────────
    const meshQuadCountView = new Uint16Array(buf, oMeshQuadCount, meshCount + 1);
    for (let m = 1; m <= meshCount; m++) meshQuadCountView[m] = reg.meshQuadShape[m]!.length;

    copyBytes(u8, reg.cull, oCull);
    copyBytes(u8, reg.blockTypeId, oBlockTypeId);
    copyBytes(u8, reg.material, oMaterial);
    copyBytes(u8, reg.modelType, oModelType);
    copyBytes(u8, reg.cubeTexIndices, oCubeTexIndices);
    copyBytes(u8, reg.cubeFaceUVs, oCubeFaceUVs);
    copyBytes(u8, reg.meshId, oMeshId);
    copyBytes(u8, reg.vertexAnimation, oVertexAnimation);
    copyBytes(u8, reg.surfaceHeight, oSurfaceHeight);
    copyBytes(u8, reg.fluidGroup, oFluidGroup);
    copyBytes(u8, reg.emissive, oEmissive);

    // ── phase 4: per-mesh bodies (concat slots 1..meshCount) ──────
    let qti = oMeshTexIndices;
    let qmm = oMeshQuadMaterials;
    let qms = oMeshQuadShape;
    let qmf = oMeshQuadFaceDir;
    let qmc = oMeshQuadCullFaceDir;
    let qmd = oMeshQuadDepth;
    let qmvd = oMeshQuadVertDepth;
    let qmvn = oMeshQuadVertNormal;
    let qmcu = oMeshQuadCornerUV;
    let qmcp = oMeshQuadCornerPos;
    let qmcn = oMeshQuadCornerNormSq;
    let qmn = oMeshQuadNormal;
    let qmu = oMeshQuadUVs;
    let qmv = oMeshQuadVerts;
    for (let m = 1; m <= meshCount; m++) {
        const t = reg.meshTexIndices[m]!;
        copyBytes(u8, t, qti);
        qti += t.byteLength;
        const mm = reg.meshQuadMaterials[m]!;
        copyBytes(u8, mm, qmm);
        qmm += mm.byteLength;
        const ms = reg.meshQuadShape[m]!;
        copyBytes(u8, ms, qms);
        qms += ms.byteLength;
        const mf = reg.meshQuadFaceDir[m]!;
        copyBytes(u8, mf, qmf);
        qmf += mf.byteLength;
        const mc = reg.meshQuadCullFaceDir[m]!;
        copyBytes(u8, mc, qmc);
        qmc += mc.byteLength;
        const md = reg.meshQuadDepth[m]!;
        copyBytes(u8, md, qmd);
        qmd += md.byteLength;
        const mvd = reg.meshQuadVertDepth[m]!;
        copyBytes(u8, mvd, qmvd);
        qmvd += mvd.byteLength;
        const mvn = reg.meshQuadVertNormal[m]!;
        copyBytes(u8, mvn, qmvn);
        qmvn += mvn.byteLength;
        const mcu = reg.meshQuadCornerUV[m]!;
        copyBytes(u8, mcu, qmcu);
        qmcu += mcu.byteLength;
        const mcp = reg.meshQuadCornerPos[m]!;
        copyBytes(u8, mcp, qmcp);
        qmcp += mcp.byteLength;
        const mcn = reg.meshQuadCornerNormSq[m]!;
        copyBytes(u8, mcn, qmcn);
        qmcn += mcn.byteLength;
        const mn = reg.meshQuadNormal[m]!;
        copyBytes(u8, mn, qmn);
        qmn += mn.byteLength;
        const mu = reg.meshQuadUVs[m]!;
        copyBytes(u8, mu, qmu);
        qmu += mu.byteLength;
        const mv = reg.meshQuadVerts[m]!;
        copyBytes(u8, mv, qmv);
        qmv += mv.byteLength;
    }

    return buf;
}

// ── decode ─────────────────────────────────────────────────────────

export type DeserializedBlockRegistry = Partial<Blocks> & {
    totalStates: number;
    version: number;
};

export function deserializeBlockRegistryForWorker(buf: ArrayBuffer): DeserializedBlockRegistry {
    const u32 = new Uint32Array(buf);
    if (u32[H_MAGIC] !== MAGIC) {
        throw new Error(`block-registry-serde: bad magic 0x${u32[H_MAGIC]!.toString(16)}`);
    }
    const version = u32[H_VERSION]!;
    const totalStates = u32[H_TOTAL_STATES]!;
    const meshCount = u32[H_MESH_COUNT]!;

    const meshQuadCount = new Uint16Array(buf, u32[H_MESH_QUAD_COUNT]!, meshCount + 1);

    // per-state views
    const cull = new Uint8Array(buf, u32[H_CULL]!, totalStates);
    const blockTypeId = new Uint16Array(buf, u32[H_BLOCK_TYPE_ID]!, totalStates);
    const material = new Uint8Array(buf, u32[H_MATERIAL]!, totalStates);
    const modelType = new Uint8Array(buf, u32[H_MODEL_TYPE]!, totalStates);
    const cubeTexIndices = new Uint16Array(buf, u32[H_CUBE_TEX_INDICES]!, totalStates * 6);
    const cubeFaceUVs = new Uint8Array(buf, u32[H_CUBE_FACE_UVS]!, totalStates * 48);
    const meshId = new Uint16Array(buf, u32[H_MESH_ID]!, totalStates);
    const vertexAnimation = new Uint8Array(buf, u32[H_VERTEX_ANIMATION]!, totalStates);
    const surfaceHeight = new Float32Array(buf, u32[H_SURFACE_HEIGHT]!, totalStates);
    const fluidGroup = new Uint16Array(buf, u32[H_FLUID_GROUP]!, totalStates);
    const emissive = new Uint8Array(buf, u32[H_EMISSIVE]!, totalStates);

    // per-mesh: rebuild slot arrays as views into each field's concat blob.
    const meshTexIndices: Uint16Array[] = new Array(meshCount + 1);
    const meshQuadMaterials: Uint8Array[] = new Array(meshCount + 1);
    const meshQuadShape: Uint8Array[] = new Array(meshCount + 1);
    const meshQuadFaceDir: Uint8Array[] = new Array(meshCount + 1);
    const meshQuadCullFaceDir: Uint8Array[] = new Array(meshCount + 1);
    const meshQuadDepth: Float32Array[] = new Array(meshCount + 1);
    const meshQuadVertDepth: Float32Array[] = new Array(meshCount + 1);
    const meshQuadVertNormal: Float32Array[] = new Array(meshCount + 1);
    const meshQuadCornerUV: Float32Array[] = new Array(meshCount + 1);
    const meshQuadCornerPos: Float32Array[] = new Array(meshCount + 1);
    const meshQuadCornerNormSq: Float32Array[] = new Array(meshCount + 1);
    const meshQuadNormal: Float32Array[] = new Array(meshCount + 1);
    const meshQuadUVs: Float32Array[] = new Array(meshCount + 1);
    const meshQuadVerts: Float32Array[] = new Array(meshCount + 1);

    // slot 0 sentinels (zero-length views; mesher only reads via 1-based meshId).
    meshTexIndices[0] = new Uint16Array(0);
    meshQuadMaterials[0] = new Uint8Array(0);
    meshQuadShape[0] = new Uint8Array(0);
    meshQuadFaceDir[0] = new Uint8Array(0);
    meshQuadCullFaceDir[0] = new Uint8Array(0);
    meshQuadDepth[0] = new Float32Array(0);
    meshQuadVertDepth[0] = new Float32Array(0);
    meshQuadVertNormal[0] = new Float32Array(0);
    meshQuadCornerUV[0] = new Float32Array(0);
    meshQuadCornerPos[0] = new Float32Array(0);
    meshQuadCornerNormSq[0] = new Float32Array(0);
    meshQuadNormal[0] = new Float32Array(0);
    meshQuadUVs[0] = new Float32Array(0);
    meshQuadVerts[0] = new Float32Array(0);

    let qti = u32[H_MESH_TEX_INDICES]!;
    let qmm = u32[H_MESH_QUAD_MATERIALS]!;
    let qms = u32[H_MESH_QUAD_SHAPE]!;
    let qmf = u32[H_MESH_QUAD_FACE_DIR]!;
    let qmc = u32[H_MESH_QUAD_CULL_FACE_DIR]!;
    let qmd = u32[H_MESH_QUAD_DEPTH]!;
    let qmvd = u32[H_MESH_QUAD_VERT_DEPTH]!;
    let qmvn = u32[H_MESH_QUAD_VERT_NORMAL]!;
    let qmcu = u32[H_MESH_QUAD_CORNER_UV]!;
    let qmcp = u32[H_MESH_QUAD_CORNER_POS]!;
    let qmcn = u32[H_MESH_QUAD_CORNER_NORM_SQ]!;
    let qmn = u32[H_MESH_QUAD_NORMAL]!;
    let qmu = u32[H_MESH_QUAD_UVS]!;
    let qmv = u32[H_MESH_QUAD_VERTS]!;
    for (let m = 1; m <= meshCount; m++) {
        const n = meshQuadCount[m]!;
        meshTexIndices[m] = new Uint16Array(buf, qti, n * STRIDE_MESH_TEX_INDICES);
        qti += n * STRIDE_MESH_TEX_INDICES * 2;
        meshQuadMaterials[m] = new Uint8Array(buf, qmm, n * STRIDE_MESH_QUAD_MATERIALS);
        qmm += n * STRIDE_MESH_QUAD_MATERIALS;
        meshQuadShape[m] = new Uint8Array(buf, qms, n * STRIDE_MESH_QUAD_SHAPE);
        qms += n * STRIDE_MESH_QUAD_SHAPE;
        meshQuadFaceDir[m] = new Uint8Array(buf, qmf, n * STRIDE_MESH_QUAD_FACE_DIR);
        qmf += n * STRIDE_MESH_QUAD_FACE_DIR;
        meshQuadCullFaceDir[m] = new Uint8Array(buf, qmc, n * STRIDE_MESH_QUAD_CULL_FACE_DIR);
        qmc += n * STRIDE_MESH_QUAD_CULL_FACE_DIR;
        meshQuadDepth[m] = new Float32Array(buf, qmd, n * STRIDE_MESH_QUAD_DEPTH);
        qmd += n * STRIDE_MESH_QUAD_DEPTH * 4;
        meshQuadVertDepth[m] = new Float32Array(buf, qmvd, n * STRIDE_MESH_QUAD_VERT_DEPTH);
        qmvd += n * STRIDE_MESH_QUAD_VERT_DEPTH * 4;
        meshQuadVertNormal[m] = new Float32Array(buf, qmvn, n * STRIDE_MESH_QUAD_VERT_NORMAL);
        qmvn += n * STRIDE_MESH_QUAD_VERT_NORMAL * 4;
        meshQuadCornerUV[m] = new Float32Array(buf, qmcu, n * STRIDE_MESH_QUAD_CORNER_UV);
        qmcu += n * STRIDE_MESH_QUAD_CORNER_UV * 4;
        meshQuadCornerPos[m] = new Float32Array(buf, qmcp, n * STRIDE_MESH_QUAD_CORNER_POS);
        qmcp += n * STRIDE_MESH_QUAD_CORNER_POS * 4;
        meshQuadCornerNormSq[m] = new Float32Array(buf, qmcn, n * STRIDE_MESH_QUAD_CORNER_NORM_SQ);
        qmcn += n * STRIDE_MESH_QUAD_CORNER_NORM_SQ * 4;
        meshQuadNormal[m] = new Float32Array(buf, qmn, n * STRIDE_MESH_QUAD_NORMAL);
        qmn += n * STRIDE_MESH_QUAD_NORMAL * 4;
        meshQuadUVs[m] = new Float32Array(buf, qmu, n * STRIDE_MESH_QUAD_UVS);
        qmu += n * STRIDE_MESH_QUAD_UVS * 4;
        meshQuadVerts[m] = new Float32Array(buf, qmv, n * STRIDE_MESH_QUAD_VERTS);
        qmv += n * STRIDE_MESH_QUAD_VERTS * 4;
    }

    return {
        version,
        totalStates,
        cull,
        blockTypeId,
        material,
        modelType,
        cubeTexIndices,
        cubeFaceUVs,
        meshId,
        vertexAnimation,
        surfaceHeight,
        fluidGroup,
        emissive,
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
    };
}
