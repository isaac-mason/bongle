import type { BodyId } from './aabb-world';

// pack 3 signed 17-bit cell coords into a plain Number (51 bits used; JS safe-int is 53).
// +/-65536 cells * cellSize=2 = +/-131k world units, way beyond any realistic voxel world.
// BigInt was about 10x slower here and allocated per call; this is alloc-free.
const CELL_BITS = 17;
const CELL_MASK = (1 << CELL_BITS) - 1; // 0x1ffff
const CELL_MULT_Y = 1 << CELL_BITS; // 2^17
const CELL_MULT_X = CELL_MULT_Y * CELL_MULT_Y; // 2^34 (must use mul, JS << is 32-bit)

export function hashKey(ix: number, iy: number, iz: number): number {
    return (ix & CELL_MASK) * CELL_MULT_X + (iy & CELL_MASK) * CELL_MULT_Y + (iz & CELL_MASK);
}

export type SpatialHash = {
    cellSize: number;
    invCellSize: number;
    cells: Map<number, BodyId[]>;
    /** scratch buffer reused per query. */
    _queryHits: BodyId[];
    /** dedup within one query (a body can fall into multiple cells). */
    _seen: Set<BodyId>;
};

export function createSpatialHash(cellSize: number): SpatialHash {
    return {
        cellSize,
        invCellSize: 1 / cellSize,
        cells: new Map(),
        _queryHits: [],
        _seen: new Set(),
    };
}

export function clearSpatialHash(h: SpatialHash): void {
    h.cells.clear();
}

export function removeBodyFromBucket(h: SpatialHash, key: number, id: BodyId): void {
    const bucket = h.cells.get(key);
    if (!bucket) return;
    // swap-remove. buckets are small (typically 1-3 ids per cell), so a linear
    // indexOf is faster than maintaining per-bucket maps.
    const idx = bucket.indexOf(id);
    if (idx === -1) return;
    const last = bucket.length - 1;
    if (idx !== last) bucket[idx] = bucket[last]!;
    bucket.pop();
    if (bucket.length === 0) h.cells.delete(key);
}

/** collect ids in any cell overlapping [min..max]. dedup via `_seen`. result is `h._queryHits`. */
export function querySpatialHash(
    h: SpatialHash,
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
): BodyId[] {
    const inv = h.invCellSize;
    const ix0 = Math.floor(minX * inv);
    const iy0 = Math.floor(minY * inv);
    const iz0 = Math.floor(minZ * inv);
    const ix1 = Math.floor(maxX * inv);
    const iy1 = Math.floor(maxY * inv);
    const iz1 = Math.floor(maxZ * inv);

    h._queryHits.length = 0;
    h._seen.clear();

    for (let iz = iz0; iz <= iz1; iz++) {
        for (let iy = iy0; iy <= iy1; iy++) {
            for (let ix = ix0; ix <= ix1; ix++) {
                const bucket = h.cells.get(hashKey(ix, iy, iz));
                if (!bucket) continue;
                for (let i = 0; i < bucket.length; i++) {
                    const id = bucket[i]!;
                    if (h._seen.has(id)) continue;
                    h._seen.add(id);
                    h._queryHits.push(id);
                }
            }
        }
    }
    return h._queryHits;
}
