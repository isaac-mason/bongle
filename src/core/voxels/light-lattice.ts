// ── chunk light tile ────────────────────────────────────────────────
//
// A per-chunk 16^3 tile of RAW cell light plus a solidity bit per cell, the CPU
// half of the GPU light volume (see `llm/plan-voxel-light-volume.md`). Exactly
// the chunk's own cells: no borrowed shell.
//
// WHY RAW CELLS AND NOT A PRE-BLENDED CORNER LATTICE. This used to bake a 17^3
// corner lattice, one value per block corner blended from the 8 cells touching
// it, so every face sharing that corner read one texel and could never disagree.
// That shape leaks: a corner is shared by cells
// light cannot travel between, so a sealed pocket and a lit shaft meeting only at
// a corner diagonal need 0 and 15 from the SAME number. Pre-blending is lossy, so
// nothing at sample time recovers it. Terrain shades a SURFACE, which has a side;
// it wants the four cells on the normal's side, which is the mesher's
// centre/edgeA/edgeB/diagonal tap and cannot leak because the far side is never
// read.
//
// WHY NO PADDED SHELL. The tile was briefly 18^3, the chunk plus one cell
// borrowed from each of the 26 neighbours, so a boundary face could be shaded
// with a single residency lookup. That shell DUPLICATED every boundary cell into
// up to 8 tiles, and every consequence of that duplication cost us:
//
//   - one cell changing made up to 8 tiles stale, which is the "apron"
//   - a chunk arriving invalidated 26 neighbours' shells, so a streaming chunk
//     rebaked up to 27 times before settling
//   - a shell that had not caught up IS a seam, the whole class of them
//   - 45% of the tile was duplicated neighbour data, which made a pool sized to
//     match the mesh arena unaffordable
//
// Without it a cell change dirties exactly ONE tile, and the cost moves to the
// shader: a tap outside the chunk resolves its own chunk through the residency
// grid. That only happens for boundary-adjacent blocks.

import { CullType } from './blocks';
import { CHUNK_VOLUME, type Chunk, getChunk, type Voxels, voxelIndex } from './voxels';

/** packed u16 with sky=15, rgb=0. Matches `chunk-mesher`'s
 *  PACKED_LIGHT_SKY_FULL and Sodium's "no chunk = sky-lit void" fallback, and is
 *  what a consumer reads when a chunk is not resident. */
export const SKY_FULL = 0xf000;

/** cells per tile, and the u32 each half occupies. CHUNK_VOLUME is a multiple of
 *  32, so the solidity bitset needs no tail handling. */
export const TILE_CELLS = CHUNK_VOLUME; // 4096
export const TILE_LIGHT_U32S = TILE_CELLS / 2; // 2048
export const TILE_SOLID_U32S = TILE_CELLS / 32; // 128

/** palette slot -> 1 when that block is a full opaque cube. Module scratch: one
 *  tile write at a time per thread. Keeps the inner loop to one lookup instead of
 *  the `cull[palette[data[i]]]` chain, which is three indirections per cell. */
let _paletteSolid = new Uint8Array(256);

/**
 * Write `chunk`'s light and solidity into a tile.
 *
 * `outLight` is indexed in cells (a u16 view), `outSolid` in u32 words (the
 * bitset), each from its own base, so this writes STRAIGHT INTO the GPU tile
 * through views of the same buffer. A separate pack step measured three times
 * the cost of producing the data.
 *
 * The solidity bit is what lets a consumer's blend tell "solid, no data" from
 * "open but genuinely dark". Without it a blend substituting zeros fills a sealed
 * cell in with its brightest neighbour, which is a leak.
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

    // bits accumulated as the cells are walked, so there is no second pass and no
    // per-bit bounds check.
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

// ── the anchored blend ──────────────────────────────────────────────
//
// The mesher's `blendCornerBrightness`, restated over world cells so the CPU and
// the GPU run the identical rule. The CPU form reads `voxels` directly rather
// than a tile; it is the reference the shader is ported from and what the tests
// assert against.

/** min-non-zero substitution over 4 inputs, per the mesher: a zero is "no data"
 *  and takes the smallest non-zero, then a plain mean. All zero stays 0. */
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
 * The light a face with normal `(nx, ny, nz)` on the block at world `(bx, by, bz)`
 * shows at the corner offset `(ou, ov)` in its plane.
 *
 * Reads only the four cells on the face's own side, so light from behind the
 * surface is never in the input set and cannot leak across a corner diagonal.
 * When BOTH edge cells are opaque the diagonal is replaced by the first edge,
 * which is the mesher's anti-leak fixup.
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

    // centre is the cell BEYOND the face, which is what the mesher sampled
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
