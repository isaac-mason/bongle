// cloud-shapes.ts
//
// the N deterministic cloud "puff" voxel grids the cloud system instances.
// each shape's occupancy is `inside(union of K random ellipsoid blobs)`:
// one big primary blob anchors the body and K-1 smaller satellites are
// scattered around it within an upper-biased region. voxel is "on" iff
// it falls inside any blob; an edge-erosion pass roughens the surface
// stochastically so the silhouette reads as fractal-grained, not stamped.
// this gives the classic clustered-marshmallow cumulus look with ~8
// cheap squared-distance tests per voxel (no fbm, no trilerp).
//
// all shapes are generated once at init then greedy-meshed into one
// shared uber geometry (rebased indices so a single index buffer + flat
// baseVertex=0 indirect draws work uniformly). per-shape metadata
// records the index range + half-extents so the cull compute can build
// draw-indirect entries and reject out-of-frustum slots.

import * as gpu from 'gpucat';
import { meshOccupancy } from '../core/voxels/greedy-mesh';

// 24 unique puffs masks repetition at typical instance counts (~400).
export const N_CLOUD_SHAPES = 24;

// per-shape voxel grid dims. small enough to mesh fast, large enough
// for ~3-4 visible lobes per side at the chosen blob radii.
export const CLOUD_DIM_X = 24;
export const CLOUD_DIM_Y = 10;
export const CLOUD_DIM_Z = 24;

// world units per voxel — bumps the visual block size without producing
// more polygons. higher = chunkier, more minecraft-y. effective cloud
// world-extent is CLOUD_DIM_* × CLOUD_VOXEL_SCALE.
const CLOUD_VOXEL_SCALE = 4;

// hierarchical blob counts:
//   1 primary anchor blob
// + N_SATELLITES medium blobs offset from the centre
// + N_SATELLITES × N_MICROS_PER_SATELLITE small "bumps" on each
//   satellite's surface
// the micros are what give clouds their cauliflower silhouette — each
// satellite gets a few smaller bumps clustered on its outside, so the
// union surface has detail at two scales instead of one.
const N_SATELLITES = 7;
const N_MICROS_PER_SATELLITE = 3;
const BLOBS_PER_SHAPE = 1 + N_SATELLITES + N_SATELLITES * N_MICROS_PER_SATELLITE;

// per-voxel stochastic erosion at the boundary: voxels just inside the
// surface get a small random chance of dropping out. roughens edges so
// cloud silhouettes look fractal-grained, not like a sphere union.
// expressed as a band of squared-distance ∈ [1 - EDGE_NOISE, 1] where
// erosion can fire (1 = surface, 0 = core).
const EDGE_NOISE = 0.18;

// upper-bias for satellite Y placement (fraction up the grid). clouds
// have flat bottoms and domed tops, so satellites cluster above middle.
const Y_BODY_CENTER = 0.55;

// integer 3D hash → [0,1). mulberry-ish; cheap and good enough for a
// one-shot init-time fill.
function hash3i(x: number, y: number, z: number, seed: number): number {
    let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647) + Math.imul(seed | 0, 2654435761);
    n = (n ^ (n >>> 13)) >>> 0;
    n = Math.imul(n, 1274126177) >>> 0;
    n = (n ^ (n >>> 16)) >>> 0;
    return n / 4294967296;
}

function shapeIndex(x: number, y: number, z: number): number {
    return x + y * CLOUD_DIM_X + z * CLOUD_DIM_X * CLOUD_DIM_Y;
}

// place hierarchical ellipsoid blobs deterministically from shapeIdx.
// data layout per blob is 9 floats: [cx, cy, cz, rx, ry, rz, invRx,
// invRy, invRz]. rx/ry/rz drive a cheap AABB pre-reject (most voxels
// are outside the AABB of any given micro-blob); invR* are reused in
// the squared-distance test for blobs that survive the reject.
type BlobField = {
    n: number;
    data: Float32Array;
};
const BLOB_STRIDE = 9;

function writeBlob(data: Float32Array, idx: number, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): void {
    const o = idx * BLOB_STRIDE;
    data[o]     = cx;  data[o + 1] = cy;  data[o + 2] = cz;
    data[o + 3] = rx;  data[o + 4] = ry;  data[o + 5] = rz;
    data[o + 6] = 1 / rx; data[o + 7] = 1 / ry; data[o + 8] = 1 / rz;
}

function generateBlobs(shapeIdx: number): BlobField {
    const seed = shapeIdx * 17 + 1;
    const data = new Float32Array(BLOBS_PER_SHAPE * BLOB_STRIDE);
    let cursor = 0;

    // primary central blob — anchors the body, big enough to overlap
    // all satellites so the union reads as one cloud not many.
    writeBlob(data, cursor++,
        CLOUD_DIM_X * 0.5, CLOUD_DIM_Y * Y_BODY_CENTER, CLOUD_DIM_Z * 0.5,
        CLOUD_DIM_X * 0.32, CLOUD_DIM_Y * 0.42, CLOUD_DIM_Z * 0.32);

    // satellites — wide xy-range, narrow y-range so they stay in the
    // body band. each gets a few micro-blobs jittered around its
    // surface for the cauliflower silhouette.
    for (let i = 0; i < N_SATELLITES; i++) {
        const s = seed + (i + 1) * 31;
        const ox = (hash3i(s, 1, 0, 0) * 2 - 1) * 0.42;
        const oy = (hash3i(s, 2, 0, 0) * 2 - 1) * 0.22;
        const oz = (hash3i(s, 3, 0, 0) * 2 - 1) * 0.42;
        const r  = 0.18 + hash3i(s, 4, 0, 0) * 0.14;

        const scx = CLOUD_DIM_X * (0.5 + ox);
        const scy = CLOUD_DIM_Y * (Y_BODY_CENTER + oy);
        const scz = CLOUD_DIM_Z * (0.5 + oz);
        const srx = CLOUD_DIM_X * r;
        const sry = CLOUD_DIM_Y * r * 1.1;
        const srz = CLOUD_DIM_Z * r;
        writeBlob(data, cursor++, scx, scy, scz, srx, sry, srz);

        // micros — small bumps placed near the parent's surface. each
        // is 30..55% of the parent's radii and offset by ~1 parent
        // radius in a random direction (slight upward bias keeps the
        // silhouette domed rather than spiky on all sides).
        for (let m = 0; m < N_MICROS_PER_SATELLITE; m++) {
            const ms = s + (m + 1) * 13;
            const dx = hash3i(ms, 5, 0, 0) * 2 - 1;
            const dy = (hash3i(ms, 6, 0, 0) * 2 - 1) * 0.6 + 0.25;
            const dz = hash3i(ms, 7, 0, 0) * 2 - 1;
            const mr = 0.30 + hash3i(ms, 8, 0, 0) * 0.25;

            writeBlob(data, cursor++,
                scx + dx * srx, scy + dy * sry, scz + dz * srz,
                srx * mr, sry * mr, srz * mr);
        }
    }

    return { n: BLOBS_PER_SHAPE, data };
}

// generate one shape's occupancy from the blob-union. for each voxel,
// find the minimum normalised squared distance to any blob centre. <1
// means we're inside at least one ellipsoid; the headroom (1 - minD2)
// drives the stochastic edge erosion that gives the surface its grain.
function generateOccupancy(shapeIdx: number): Uint8Array {
    const grid = new Uint8Array(CLOUD_DIM_X * CLOUD_DIM_Y * CLOUD_DIM_Z);
    const seed = shapeIdx * 17 + 1;
    const blobs = generateBlobs(shapeIdx);
    const bn = blobs.n;
    const bd = blobs.data;

    for (let z = 0; z < CLOUD_DIM_Z; z++) {
        const pz = z + 0.5;
        for (let y = 0; y < CLOUD_DIM_Y; y++) {
            const py = y + 0.5;
            for (let x = 0; x < CLOUD_DIM_X; x++) {
                const px = x + 0.5;

                // find the minimum normalised squared distance to any
                // blob centre. AABB pre-reject skips the squared-distance
                // test for blobs whose extents don't enclose the voxel —
                // critical for micros (~21 of the ~29 blobs are tiny).
                let minD2 = Infinity;
                for (let b = 0; b < bn; b++) {
                    const o = b * BLOB_STRIDE;
                    const dx = px - bd[o]!;
                    const rx = bd[o + 3]!;
                    if (dx < -rx || dx > rx) continue;
                    const dy = py - bd[o + 1]!;
                    const ry = bd[o + 4]!;
                    if (dy < -ry || dy > ry) continue;
                    const dz = pz - bd[o + 2]!;
                    const rz = bd[o + 5]!;
                    if (dz < -rz || dz > rz) continue;
                    const nx = dx * bd[o + 6]!;
                    const ny = dy * bd[o + 7]!;
                    const nz = dz * bd[o + 8]!;
                    const d2 = nx * nx + ny * ny + nz * nz;
                    if (d2 < minD2) minD2 = d2;
                }
                if (minD2 >= 1) continue;

                // edge erosion: surface voxels (headroom near 0) get a
                // high chance of dropping out; deep-core voxels (headroom
                // near EDGE_NOISE) almost never do. this is what turns a
                // smooth sphere-union into a grainy cumulus silhouette.
                const headroom = 1 - minD2;
                if (headroom < EDGE_NOISE && hash3i(x, y, z, seed + 999) > headroom / EDGE_NOISE) continue;

                grid[shapeIndex(x, y, z)] = 1;
            }
        }
    }
    return grid;
}

export type CloudShapeMeta = {
    indexStart: number;
    indexCount: number;
    // half-extents of the cloud shape's centred AABB in world units (1
    // voxel = 1 world unit at the shape's authoring scale; instance
    // transforms scale the cloud at render time if needed).
    halfExtentX: number;
    halfExtentY: number;
    halfExtentZ: number;
};

export type CloudUberGeometry = {
    geometry: gpu.Geometry;
    shapes: CloudShapeMeta[];
    // packed [indexStart, indexCount, halfX, halfY, halfZ, _pad, _pad, _pad]
    // for upload to a storage buffer the cull compute reads. 8 floats per
    // shape keeps the struct 32-byte aligned for std430.
    shapeMetaPacked: Float32Array;
    // raw arrays exposed for storage-buffer uploads (vertex-pull path).
    positions: Float32Array;
    normals: Float32Array;
    // index array is padded to `lastShapeIndexStart + maxIndexCount` so any
    // (shape.indexStart + vertexIndex) read in the VS stays in-bounds; pad
    // values are 0 (the VS short-circuits past shape.indexCount anyway).
    indices: Uint32Array;
    maxIndexCount: number;
};

// CPU-side build product — renderer-agnostic, so we cache this at module
// scope and rebuild the cheap gpu.Geometry wrapper per call. fbm +
// greedy-mesh is the expensive part (hundreds of ms); GPU buffer
// construction is microseconds.
type CloudCpuBuild = {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    shapes: CloudShapeMeta[];
    shapeMetaPacked: Float32Array;
};

let cachedCpu: CloudCpuBuild | null = null;

function buildCloudCpu(): CloudCpuBuild {
    const positionChunks: Float32Array[] = [];
    const normalChunks: Float32Array[] = [];
    const indexChunks: Uint32Array[] = [];
    const shapes: CloudShapeMeta[] = [];

    let vertexOffset = 0;
    let indexOffset = 0;

    for (let s = 0; s < N_CLOUD_SHAPES; s++) {
        const grid = generateOccupancy(s);
        const mesh = meshOccupancy({
            occ: (x, y, z) => {
                if (x < 0 || y < 0 || z < 0) return false;
                if (x >= CLOUD_DIM_X || y >= CLOUD_DIM_Y || z >= CLOUD_DIM_Z) return false;
                return grid[shapeIndex(x, y, z)] === 1;
            },
            min: [0, 0, 0],
            max: [CLOUD_DIM_X - 1, CLOUD_DIM_Y - 1, CLOUD_DIM_Z - 1],
            emitNormals: true,
        });

        // pathological case: a shape's hash gated everything out. unlikely
        // with current params but cheap to handle — emit an empty range so
        // its slots draw nothing (instanceCount=0 in the indirect entry).
        if (!mesh || !mesh.normals) {
            shapes.push({
                indexStart: indexOffset,
                indexCount: 0,
                halfExtentX: 0,
                halfExtentY: 0,
                halfExtentZ: 0,
            });
            continue;
        }

        // anchor positions: X and Z centred on the shape origin so wind
        // and placement transforms feel symmetric; Y base-anchored at 0
        // so the cloud sits ABOVE its world anchor. this gives
        // cloudsAltitude the meaning "cloud floor altitude" — a bigger
        // cloud reaches higher into the sky, never down into the world.
        const cx = CLOUD_DIM_X * 0.5;
        const cz = CLOUD_DIM_Z * 0.5;
        const centred = new Float32Array(mesh.positions.length);
        for (let i = 0; i < mesh.positions.length; i += 3) {
            centred[i] = (mesh.positions[i]! - cx) * CLOUD_VOXEL_SCALE;
            centred[i + 1] = mesh.positions[i + 1]! * CLOUD_VOXEL_SCALE;
            centred[i + 2] = (mesh.positions[i + 2]! - cz) * CLOUD_VOXEL_SCALE;
        }

        // rebase indices: add the running vertexOffset so all shapes share
        // one flat index buffer and indirect draws can baseVertex=0.
        const rebased = new Uint32Array(mesh.indices.length);
        for (let i = 0; i < mesh.indices.length; i++) {
            rebased[i] = mesh.indices[i]! + vertexOffset;
        }

        positionChunks.push(centred);
        normalChunks.push(mesh.normals);
        indexChunks.push(rebased);

        shapes.push({
            indexStart: indexOffset,
            indexCount: mesh.indices.length,
            halfExtentX: CLOUD_DIM_X * 0.5 * CLOUD_VOXEL_SCALE,
            halfExtentY: CLOUD_DIM_Y * 0.5 * CLOUD_VOXEL_SCALE,
            halfExtentZ: CLOUD_DIM_Z * 0.5 * CLOUD_VOXEL_SCALE,
        });

        vertexOffset += centred.length / 3;
        indexOffset += mesh.indices.length;
    }

    const positions = concatF32(positionChunks);
    const normals = concatF32(normalChunks);
    const indices = concatU32(indexChunks);

    const shapeMetaPacked = new Float32Array(shapes.length * 8);
    for (let i = 0; i < shapes.length; i++) {
        const s = shapes[i]!;
        const base = i * 8;
        shapeMetaPacked[base] = s.indexStart;
        shapeMetaPacked[base + 1] = s.indexCount;
        shapeMetaPacked[base + 2] = s.halfExtentX;
        shapeMetaPacked[base + 3] = s.halfExtentY;
        shapeMetaPacked[base + 4] = s.halfExtentZ;
        // [5..7] reserved padding.
    }

    return { positions, normals, indices, shapes, shapeMetaPacked };
}

// build the shared uber geometry. lazily computes CPU data the first
// time and reuses it across rooms; the gpu.Geometry wrapper is rebuilt
// per call so each renderer/room owns its own GPU buffers.
//
// vertex-pull path: the returned geometry has NO vertex attributes and
// NO index buffer. The cloud material reads positions/normals/indices
// from storage buffers via vertexIndex + per-instance shape lookup, so
// gpucat issues a single non-indexed `drawIndirect` against the empty
// geometry. The raw arrays come back on the result for the caller to
// wrap in storage buffers.
export function buildCloudUberGeometry(): CloudUberGeometry {
    if (!cachedCpu) cachedCpu = buildCloudCpu();
    const { positions, normals, indices, shapes, shapeMetaPacked } = cachedCpu;

    let maxIndexCount = 0;
    for (const s of shapes) if (s.indexCount > maxIndexCount) maxIndexCount = s.indexCount;

    // pad index array so any (shape.indexStart + vertexIndex) read with
    // vertexIndex < maxIndexCount stays in-bounds, even for the last
    // shape. WebGPU clamps out-of-bounds storage reads, but a clean pad
    // makes the bound explicit. Pad with 0; the VS discards past
    // shape.indexCount.
    const lastShape = shapes[shapes.length - 1]!;
    const requiredIndexLen = lastShape.indexStart + maxIndexCount;
    const paddedIndices = indices.length >= requiredIndexLen
        ? indices
        : (() => {
            const padded = new Uint32Array(requiredIndexLen);
            padded.set(indices);
            return padded;
        })();

    const geometry = new gpu.Geometry();
    geometry.drawRange = { start: 0, count: maxIndexCount };

    return { geometry, shapes, shapeMetaPacked, positions, normals, indices: paddedIndices, maxIndexCount };
}

function concatF32(chunks: Float32Array[]): Float32Array {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

function concatU32(chunks: Uint32Array[]): Uint32Array {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint32Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}
