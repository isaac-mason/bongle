import { CullType } from './blocks';
import { CHUNK_VOLUME, type Chunk, getChunk, type Voxels, voxelIndex } from './voxels';

/** packed u16 with sky=15, rgb=0; read when a chunk is not resident. */
export const SKY_FULL = 0xf000;

/** CHUNK_VOLUME is a multiple of 32, so the solidity bitset needs no tail handling. */
export const TILE_CELLS = CHUNK_VOLUME; // 4096
export const TILE_LIGHT_U32S = TILE_CELLS / 2; // 2048
export const TILE_SOLID_U32S = TILE_CELLS / 32; // 128

// palette slot -> 1 when that block is a full opaque cube; module scratch, single tile write at a time per thread.
let _paletteSolid = new Uint8Array(256);

/**
 * Writes `chunk`'s light and solidity straight into the GPU tile through views of the same buffer.
 * The solidity bit lets a blend tell "solid, no data" from "open but dark" instead of leaking a neighbour's light into a sealed cell.
 */
export function writeChunkLightTile(
    voxels: Voxels,
    chunk: Chunk,
    outLight: Uint16Array,
    lightBase: number,
    outSolid: Uint32Array,
    solidBase: number,
): void {
    // the whole 16^3 is contiguous in both, so this is one memcpy-shaped call
    outLight.set(chunk.light, lightBase);

    const palette = chunk.palette;
    const cull = voxels.registry.cull;
    if (palette.length > _paletteSolid.length) _paletteSolid = new Uint8Array(palette.length);
    for (let i = 0; i < palette.length; i++) _paletteSolid[i] = cull[palette[i]!] === CullType.SOLID ? 1 : 0;

    const data = chunk.data;
    let word = 0;
    let bit = 0;
    let wi = solidBase;
    for (let i = 0; i < TILE_CELLS; i++) {
        word |= _paletteSolid[data[i]!]! << bit;
        if (++bit === 32) {
            outSolid[wi++] = word >>> 0;
            word = 0;
            bit = 0;
        }
    }
}

/** min-non-zero substitution over 4 inputs: zero means "no data" and is replaced by the smallest non-zero, then averaged. All-zero stays 0. */
function blendChannel4(a: number, b: number, c: number, d: number): number {
    let m = 16;
    if (a !== 0 && a < m) m = a;
    if (b !== 0 && b < m) m = b;
    if (c !== 0 && c < m) m = c;
    if (d !== 0 && d < m) m = d;
    if (m === 16) return 0;
    return ((a || m) + (b || m) + (c || m) + (d || m)) >> 2;
}

/** one world cell's light, or SKY_FULL when its chunk is absent. */
function worldCellLight(voxels: Voxels, wx: number, wy: number, wz: number): number {
    const c = getChunk(voxels, wx >> 4, wy >> 4, wz >> 4);
    return c === undefined ? SKY_FULL : c.light[voxelIndex(wx & 15, wy & 15, wz & 15)]!;
}

/** whether a world cell is a full opaque cube. Absent chunks are not solid, so a
 *  face at the world edge shades against open sky rather than a wall. */
function worldCellSolid(voxels: Voxels, wx: number, wy: number, wz: number): boolean {
    const c = getChunk(voxels, wx >> 4, wy >> 4, wz >> 4);
    if (c === undefined) return false;
    return voxels.registry.cull[c.palette[c.data[voxelIndex(wx & 15, wy & 15, wz & 15)]!]!] === CullType.SOLID;
}

/**
 * Mirrors the mesher's `blendCornerBrightness` over world cells; the CPU reference the shader is ported from.
 * Light for a face with normal (nx, ny, nz) on block (bx, by, bz), at corner offset (ou, ov) in its plane.
 * Reads only the four cells on the face's own side, so light cannot leak across the corner diagonal; when both edge cells are opaque the diagonal is replaced by the first edge.
 */
export function blendAnchoredCorner(
    voxels: Voxels,
    bx: number,
    by: number,
    bz: number,
    nx: number,
    ny: number,
    nz: number,
    ou: number,
    ov: number,
): number {
    // in-plane basis, chosen per normal so neither axis is the normal
    const ux = nx === 0 ? 1 : 0;
    const uy = nx !== 0 ? 1 : 0;
    const vy = nz !== 0 ? 1 : 0;
    const vz = nz === 0 ? 1 : 0;

    // centre is the cell beyond the face, matching what the mesher sampled
    const cx = bx + nx;
    const cy = by + ny;
    const cz = bz + nz;
    const e0x = cx + ux * ou;
    const e0y = cy + uy * ou;
    const e1y = cy + vy * ov;
    const e1z = cz + vz * ov;

    // the diagonal is centre + u*ou + v*ov
    const dgx = cx + ux * ou;
    const dgy = cy + uy * ou + vy * ov;
    const dgz = cz + vz * ov;

    const e0Solid = worldCellSolid(voxels, e0x, e0y, cz);
    const e1Solid = worldCellSolid(voxels, cx, e1y, e1z);

    const w0 = worldCellLight(voxels, cx, cy, cz);
    const w1 = worldCellLight(voxels, e0x, e0y, cz);
    const w2 = worldCellLight(voxels, cx, e1y, e1z);
    // both edges opaque: the diagonal is unreachable, so substitute an edge
    const w3 = e0Solid && e1Solid ? w1 : worldCellLight(voxels, dgx, dgy, dgz);

    return (
        (blendChannel4((w0 >>> 12) & 0xf, (w1 >>> 12) & 0xf, (w2 >>> 12) & 0xf, (w3 >>> 12) & 0xf) << 12) |
        (blendChannel4((w0 >>> 8) & 0xf, (w1 >>> 8) & 0xf, (w2 >>> 8) & 0xf, (w3 >>> 8) & 0xf) << 8) |
        (blendChannel4((w0 >>> 4) & 0xf, (w1 >>> 4) & 0xf, (w2 >>> 4) & 0xf, (w3 >>> 4) & 0xf) << 4) |
        blendChannel4(w0 & 0xf, w1 & 0xf, w2 & 0xf, w3 & 0xf)
    );
}
