// binary greedy mesher for uniform-type voxel occupancy.
//
// 6 face passes; within each pass sweep slices along the normal axis.
// for each slice, build a uint32 bitmask row per v-row of exposed faces
// (voxel present, neighbour in normal direction absent). then greedy-merge:
// for each unvisited bit in a row, extend the run along u (consecutive set
// bits), then extend along v (next rows must contain the same run mask).
// emit one quad per merged rectangle.
//
// callers supply:
//   - occ(x,y,z): a callback returning true if a voxel exists there.
//     called in tight loops — prefer a closed dense-array lookup.
//   - min/max: inclusive AABB in occupancy-space coords to mesh.
//   - emitNormals: write a per-vertex normals buffer. true for shaded meshes
//     (clouds, voxel models); false for flat-colour (editor selection) saves
//     12 bytes/vertex and the allocation.

import { createIndexBuffer, createVertexBuffer, d, Geometry } from 'gpucat';

export type Occ = (x: number, y: number, z: number) => boolean;

export type GreedyMesh = {
    positions: Float32Array;
    normals: Float32Array | null;
    indices: Uint32Array;
};

// face directions: 0=+X 1=-X 2=+Y 3=-Y 4=+Z 5=-Z.
// for each face: [nAxis, uAxis, vAxis, nDir]
//   nAxis: the normal axis (0=X, 1=Y, 2=Z), swept per slice
//   uAxis: first tangent (bitmask bits)
//   vAxis: second tangent (rows)
//   nDir:  sign of the outward normal (+1 or -1)
//
// uAxis/vAxis are chosen so cross(u,v) = +nAxis in a right-handed frame —
// keeps emitted quads front-facing under cullMode:'back'. for X faces:
// Y×Z=+X. for Z faces: X×Y=+Z. for Y faces we must use uAxis=Z, vAxis=X
// (Z×X=+Y) — using X×Z would emit -Y normals and back-face-cull the
// top/bottom of meshed shapes.
const FACE_AXES: readonly (readonly [number, number, number, number])[] = [
    [0, 1, 2, +1], // +X
    [0, 1, 2, -1], // -X
    [1, 2, 0, +1], // +Y
    [1, 2, 0, -1], // -Y
    [2, 0, 1, +1], // +Z
    [2, 0, 1, -1], // -Z
];

const FACE_NORMALS: readonly (readonly [number, number, number])[] = [
    [+1, 0, 0],
    [-1, 0, 0],
    [0, +1, 0],
    [0, -1, 0],
    [0, 0, +1],
    [0, 0, -1],
];

// emit 4 positions + (optional) 4 normals + 6 indices for one merged quad.
function emitQuad(
    positions: number[],
    normals: number[] | null,
    indices: number[],
    faceIdx: number,
    nAxis: number,
    uAxis: number,
    vAxis: number,
    nOffset: number,
    nSlice: number,
    uStart: number,
    vStart: number,
    du: number,
    dv: number,
    originN: number,
    originU: number,
    originV: number,
): void {
    const base = positions.length / 3;
    const nWorld = originN + nSlice + nOffset;
    const u0 = originU + uStart;
    const u1 = u0 + du;
    const v0 = originV + vStart;
    const v1 = v0 + dv;

    const corners: [number, number, number][] = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
    ];

    // +normal face: viewed from the +nDir side — ccw means u increases,
    // then v increases (right-hand rule with outward normal).
    // -normal face: flip u to keep winding ccw from outside.
    const uCoords = nOffset === 1 ? [u0, u1, u1, u0] : [u1, u0, u0, u1];
    const vCoords = [v0, v0, v1, v1];

    for (let i = 0; i < 4; i++) {
        corners[i]![nAxis] = nWorld;
        corners[i]![uAxis] = uCoords[i]!;
        corners[i]![vAxis] = vCoords[i]!;
        positions.push(corners[i]![0]!, corners[i]![1]!, corners[i]![2]!);
    }

    if (normals) {
        const [nx, ny, nz] = FACE_NORMALS[faceIdx]!;
        for (let i = 0; i < 4; i++) normals.push(nx, ny, nz);
    }

    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

export function meshOccupancy(opts: {
    occ: Occ;
    min: readonly [number, number, number];
    max: readonly [number, number, number];
    emitNormals?: boolean;
}): GreedyMesh | null {
    const { occ, min, max, emitNormals = true } = opts;

    const sizeX = max[0] - min[0] + 1;
    const sizeY = max[1] - min[1] + 1;
    const sizeZ = max[2] - min[2] + 1;
    if (sizeX <= 0 || sizeY <= 0 || sizeZ <= 0) return null;

    const DIM: readonly [number, number, number] = [sizeX, sizeY, sizeZ];
    const ORIGIN: readonly [number, number, number] = [min[0], min[1], min[2]];

    const positions: number[] = [];
    const normals: number[] | null = emitNormals ? [] : null;
    const indices: number[] = [];

    for (let face = 0; face < 6; face++) {
        const [nAxis, uAxis, vAxis, nDir] = FACE_AXES[face]!;
        const nSize = DIM[nAxis]!;
        const uSize = DIM[uAxis]!;
        const vSize = DIM[vAxis]!;
        const nOffset = nDir === 1 ? 1 : 0;

        const originN = ORIGIN[nAxis]!;
        const originU = ORIGIN[uAxis]!;
        const originV = ORIGIN[vAxis]!;

        // bitmask rows: wordsPerRow uint32 words per v-row
        const wordsPerRow = Math.ceil(uSize / 32);

        const exposed = new Uint32Array(vSize * wordsPerRow);
        const visited = new Uint32Array(vSize * wordsPerRow);

        const c: [number, number, number] = [0, 0, 0];
        const cn: [number, number, number] = [0, 0, 0];

        for (let n = 0; n < nSize; n++) {
            exposed.fill(0);

            for (let v = 0; v < vSize; v++) {
                for (let u = 0; u < uSize; u++) {
                    c[nAxis] = originN + n;
                    c[uAxis] = originU + u;
                    c[vAxis] = originV + v;
                    if (!occ(c[0], c[1], c[2])) continue;

                    cn[nAxis] = originN + n + nDir;
                    cn[uAxis] = originU + u;
                    cn[vAxis] = originV + v;
                    if (occ(cn[0], cn[1], cn[2])) continue;

                    exposed[v * wordsPerRow + (u >> 5)] |= 1 << (u & 31);
                }
            }

            visited.fill(0);

            for (let v0 = 0; v0 < vSize; v0++) {
                for (let w = 0; w < wordsPerRow; w++) {
                    const rowBase = v0 * wordsPerRow + w;
                    let bits = exposed[rowBase]! & ~visited[rowBase]!;

                    while (bits !== 0) {
                        const startBit = bits & -bits;
                        const bitIdx = 31 - Math.clz32(startBit);

                        let runMask = startBit;
                        let uLen = 1;
                        while (bitIdx + uLen < 32) {
                            const nextBit = startBit << uLen;
                            if (!(bits & nextBit)) break;
                            runMask |= nextBit;
                            uLen++;
                        }

                        const uStart = w * 32 + bitIdx;

                        let vLen = 1;
                        while (v0 + vLen < vSize) {
                            const nextRowBase = (v0 + vLen) * wordsPerRow + w;
                            const available = exposed[nextRowBase]! & ~visited[nextRowBase]!;
                            if ((available & runMask) !== runMask) break;
                            vLen++;
                        }

                        for (let dv = 0; dv < vLen; dv++) {
                            visited[(v0 + dv) * wordsPerRow + w] |= runMask;
                        }

                        emitQuad(
                            positions,
                            normals,
                            indices,
                            face,
                            nAxis,
                            uAxis,
                            vAxis,
                            nOffset,
                            n,
                            uStart,
                            v0,
                            uLen,
                            vLen,
                            originN,
                            originU,
                            originV,
                        );

                        bits &= ~runMask;
                    }
                }
            }
        }
    }

    if (indices.length === 0) return null;

    return {
        positions: new Float32Array(positions),
        normals: normals ? new Float32Array(normals) : null,
        indices: new Uint32Array(indices),
    };
}

// build a gpu.Geometry from a mesh result. `normal` buffer is only attached
// when normals were emitted — saves the slot for flat-colour materials.
export function meshToGeometry(mesh: GreedyMesh): Geometry {
    const geo = new Geometry();
    geo.setBuffer('position', createVertexBuffer(d.vec3f, mesh.positions));
    if (mesh.normals) {
        geo.setBuffer('normal', createVertexBuffer(d.vec3f, mesh.normals));
    }
    geo.setIndex(createIndexBuffer(mesh.indices));
    geo.drawRange = { start: 0, count: mesh.indices.length };
    return geo;
}
