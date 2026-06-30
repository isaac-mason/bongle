// selection, sparse chunk bitset for voxels + set of node ids.
//
// voxel part mirrors the VoxelsState chunk map structure so the representation is
// familiar and the coordinate maths are identical.
//
// each chunk is a 16×16×16 bit grid packed into a Uint32Array of 128 words
// (4096 bits). chunk keys use the same "cx,cy,cz" string format as voxels.ts.
//
// design:
//   - unlimited coordinate range (chunk coords are plain js numbers)
//   - O(1) set / get / has via chunk map + bit index
//   - iteration is tile-by-tile, then bit-scan within each tile
//   - nudge allocates a new Selection (unavoidable O(filled chunks))
//   - merge is O(filled chunks of source), just OR the bit words
//   - no per-voxel object allocation anywhere
//
// node part is a simple Set<number> of scene graph node ids.
//
// usage: import * as Selection from './selection'

import { CHUNK_BITS, CHUNK_SIZE, chunkKey, toChunkCoord, toLocalCoord, voxelIndex } from '../voxels/voxels';

// 4096 bits / 32 bits per word = 128 words per chunk
const WORDS_PER_CHUNK = (CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE) >> 5; // 128

export type Chunk = {
    // bit[voxelIndex(lx, ly, lz)] = 1 → selected
    bits: Uint32Array; // length 128
};

export type Selection = {
    chunks: Map<string, Chunk>;
    nodes: Set<number>;
};

// ── construction ───────────────────────────────────────────────────

export function create(): Selection {
    return { chunks: new Map(), nodes: new Set() };
}

export function clone(src: Selection): Selection {
    const dst: Selection = { chunks: new Map(), nodes: new Set(src.nodes) };
    for (const [key, chunk] of src.chunks) {
        dst.chunks.set(key, { bits: new Uint32Array(chunk.bits) });
    }
    return dst;
}

// ── chunk helpers ──────────────────────────────────────────────────

function ensureChunk(sel: Selection, cx: number, cy: number, cz: number): Chunk {
    const key = chunkKey(cx, cy, cz);
    let chunk = sel.chunks.get(key);
    if (!chunk) {
        chunk = { bits: new Uint32Array(WORDS_PER_CHUNK) };
        sel.chunks.set(key, chunk);
    }
    return chunk;
}

function getChunk(sel: Selection, cx: number, cy: number, cz: number): Chunk | undefined {
    return sel.chunks.get(chunkKey(cx, cy, cz));
}

// ── single-voxel ops ───────────────────────────────────────────────

export function set(sel: Selection, wx: number, wy: number, wz: number): void {
    const cx = toChunkCoord(wx);
    const cy = toChunkCoord(wy);
    const cz = toChunkCoord(wz);
    const chunk = ensureChunk(sel, cx, cy, cz);
    const bit = voxelIndex(toLocalCoord(wx), toLocalCoord(wy), toLocalCoord(wz));
    chunk.bits[bit >> 5] |= 1 << (bit & 31);
}

export function unset(sel: Selection, wx: number, wy: number, wz: number): void {
    const chunk = getChunk(sel, toChunkCoord(wx), toChunkCoord(wy), toChunkCoord(wz));
    if (!chunk) return;
    const bit = voxelIndex(toLocalCoord(wx), toLocalCoord(wy), toLocalCoord(wz));
    chunk.bits[bit >> 5] &= ~(1 << (bit & 31));
}

export function has(sel: Selection, wx: number, wy: number, wz: number): boolean {
    const chunk = getChunk(sel, toChunkCoord(wx), toChunkCoord(wy), toChunkCoord(wz));
    if (!chunk) return false;
    const bit = voxelIndex(toLocalCoord(wx), toLocalCoord(wy), toLocalCoord(wz));
    return (chunk.bits[bit >> 5]! & (1 << (bit & 31))) !== 0;
}

// ── node ops ───────────────────────────────────────────────────────

export function addNode(sel: Selection, nodeId: number): void {
    sel.nodes.add(nodeId);
}

export function removeNode(sel: Selection, nodeId: number): void {
    sel.nodes.delete(nodeId);
}

export function hasNode(sel: Selection, nodeId: number): boolean {
    return sel.nodes.has(nodeId);
}

export function clearNodes(sel: Selection): void {
    sel.nodes.clear();
}

// ── combined isEmpty ───────────────────────────────────────────────

export function isEmpty(sel: Selection): boolean {
    if (sel.nodes.size > 0) return false;
    for (const chunk of sel.chunks.values()) {
        for (let w = 0; w < WORDS_PER_CHUNK; w++) {
            if (chunk.bits[w]) return false;
        }
    }
    return true;
}

// ── fill an AABB ───────────────────────────────────────────────────
//
// core primitive used by box-select. works chunk-by-chunk so that the
// x-run within each row is filled with word-level OR masks rather than
// per-voxel calls.

export function setAABB(
    sel: Selection,
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
): void {
    const cxMin = toChunkCoord(minX);
    const cyMin = toChunkCoord(minY);
    const czMin = toChunkCoord(minZ);
    const cxMax = toChunkCoord(maxX);
    const cyMax = toChunkCoord(maxY);
    const czMax = toChunkCoord(maxZ);

    for (let cy = cyMin; cy <= cyMax; cy++) {
        for (let cz = czMin; cz <= czMax; cz++) {
            for (let cx = cxMin; cx <= cxMax; cx++) {
                const chunk = ensureChunk(sel, cx, cy, cz);
                const wxBase = cx << CHUNK_BITS;
                const wyBase = cy << CHUNK_BITS;
                const wzBase = cz << CHUNK_BITS;

                const lxMin = Math.max(0, minX - wxBase);
                const lyMin = Math.max(0, minY - wyBase);
                const lzMin = Math.max(0, minZ - wzBase);
                const lxMax = Math.min(CHUNK_SIZE - 1, maxX - wxBase);
                const lyMax = Math.min(CHUNK_SIZE - 1, maxY - wyBase);
                const lzMax = Math.min(CHUNK_SIZE - 1, maxZ - wzBase);

                for (let ly = lyMin; ly <= lyMax; ly++) {
                    for (let lz = lzMin; lz <= lzMax; lz++) {
                        // voxelIndex = ly*(16*16) + lz*16 + lx, so the x-run
                        // [lxMin..lxMax] is a contiguous bit range.
                        const bitStart = voxelIndex(lxMin, ly, lz);
                        const bitEnd = voxelIndex(lxMax, ly, lz);
                        const wStart = bitStart >> 5;
                        const wEnd = bitEnd >> 5;
                        if (wStart === wEnd) {
                            const lo = bitStart & 31;
                            const hi = bitEnd & 31;
                            const mask = hi === 31 ? 0xffffffff << lo : ((1 << (hi + 1)) - 1) & ~((1 << lo) - 1);
                            chunk.bits[wStart] |= mask >>> 0;
                        } else {
                            chunk.bits[wStart] |= (0xffffffff << (bitStart & 31)) >>> 0;
                            for (let w = wStart + 1; w < wEnd; w++) {
                                chunk.bits[w] = 0xffffffff;
                            }
                            const lastBits = (bitEnd & 31) + 1;
                            chunk.bits[wEnd] |= lastBits === 32 ? 0xffffffff : (1 << lastBits) - 1;
                        }
                    }
                }
            }
        }
    }
}

// ── merge ──────────────────────────────────────────────────────────
//
// OR all bits from src into dst. O(filled chunks of src).

export function merge(dst: Selection, src: Selection): void {
    for (const [key, srcChunk] of src.chunks) {
        let dstChunk = dst.chunks.get(key);
        if (!dstChunk) {
            dstChunk = { bits: new Uint32Array(WORDS_PER_CHUNK) };
            dst.chunks.set(key, dstChunk);
        }
        for (let w = 0; w < WORDS_PER_CHUNK; w++) {
            dstChunk.bits[w] |= srcChunk.bits[w]!;
        }
    }
    for (const nodeId of src.nodes) {
        dst.nodes.add(nodeId);
    }
}

// ── subtract ───────────────────────────────────────────────────────
//
// dst ←  dst ∖ src. AND-NOT each shared chunk; remove shared nodes;
// prune fully-empty chunks from dst.

export function subtract(dst: Selection, src: Selection): void {
    for (const [key, srcChunk] of src.chunks) {
        const dstChunk = dst.chunks.get(key);
        if (!dstChunk) continue;
        let any = 0;
        for (let w = 0; w < WORDS_PER_CHUNK; w++) {
            const v = dstChunk.bits[w]! & ~srcChunk.bits[w]!;
            dstChunk.bits[w] = v;
            any |= v;
        }
        if (!any) dst.chunks.delete(key);
    }
    for (const nodeId of src.nodes) {
        dst.nodes.delete(nodeId);
    }
}

// ── intersect ──────────────────────────────────────────────────────
//
// dst ← dst ∩ src. AND each shared chunk; drop dst chunks that src
// doesn't have; intersect node sets.

export function intersect(dst: Selection, src: Selection): void {
    for (const key of [...dst.chunks.keys()]) {
        const srcChunk = src.chunks.get(key);
        const dstChunk = dst.chunks.get(key)!;
        if (!srcChunk) {
            dst.chunks.delete(key);
            continue;
        }
        let any = 0;
        for (let w = 0; w < WORDS_PER_CHUNK; w++) {
            const v = dstChunk.bits[w]! & srcChunk.bits[w]!;
            dstChunk.bits[w] = v;
            any |= v;
        }
        if (!any) dst.chunks.delete(key);
    }
    for (const nodeId of [...dst.nodes]) {
        if (!src.nodes.has(nodeId)) dst.nodes.delete(nodeId);
    }
}

// ── nudge ──────────────────────────────────────────────────────────
//
// translate all selected voxels by (dx, dy, dz) into `out` (which is
// cleared first). for each set bit, decode world coords, re-set with
// delta applied. O(set voxels), unavoidable for arbitrary deltas.

export function nudge(out: Selection, src: Selection, dx: number, dy: number, dz: number): void {
    out.chunks.clear();
    out.nodes.clear();

    for (const [key, chunk] of src.chunks) {
        const parts = key.split(',');
        const cx = parseInt(parts[0]!, 10);
        const cy = parseInt(parts[1]!, 10);
        const cz = parseInt(parts[2]!, 10);
        const wxBase = cx << CHUNK_BITS;
        const wyBase = cy << CHUNK_BITS;
        const wzBase = cz << CHUNK_BITS;

        for (let w = 0; w < WORDS_PER_CHUNK; w++) {
            let word = chunk.bits[w]!;
            if (!word) continue;
            const bitBase = w << 5;
            while (word) {
                const lowestBit = word & -word;
                const bitIdx = 31 - Math.clz32(lowestBit);
                word &= ~lowestBit;

                const vi = bitBase + bitIdx;
                const lx = vi & (CHUNK_SIZE - 1);
                const lz = (vi >> CHUNK_BITS) & (CHUNK_SIZE - 1);
                const ly = vi >> (CHUNK_BITS + CHUNK_BITS);

                set(out, wxBase + lx + dx, wyBase + ly + dy, wzBase + lz + dz);
            }
        }
    }
}

// ── count ──────────────────────────────────────────────────────────

export function countVoxels(sel: Selection): number {
    let n = 0;
    for (const chunk of sel.chunks.values()) {
        for (let w = 0; w < WORDS_PER_CHUNK; w++) {
            let v = chunk.bits[w]!;
            v = v - ((v >> 1) & 0x55555555);
            v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
            n += (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
        }
    }
    return n;
}

export function count(sel: Selection): number {
    return countVoxels(sel) + sel.nodes.size;
}

// ── bounds ─────────────────────────────────────────────────────────
// computes the tight axis-aligned bounding box of all set voxels.
// returns null if the selection has no voxels.

export type Bounds = {
    min: [number, number, number];
    max: [number, number, number];
    dimensions: [number, number, number];
};

export function bounds(sel: Selection): Bounds | null {
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    let found = false;

    for (const [key, chunk] of sel.chunks) {
        const parts = key.split(',');
        const wxBase = parseInt(parts[0]!, 10) << CHUNK_BITS;
        const wyBase = parseInt(parts[1]!, 10) << CHUNK_BITS;
        const wzBase = parseInt(parts[2]!, 10) << CHUNK_BITS;

        for (let w = 0; w < WORDS_PER_CHUNK; w++) {
            let word = chunk.bits[w]!;
            if (!word) continue;
            const bitBase = w << 5;
            while (word) {
                const lowestBit = word & -word;
                const bitIdx = 31 - Math.clz32(lowestBit);
                word &= ~lowestBit;

                const vi = bitBase + bitIdx;
                const lx = vi & (CHUNK_SIZE - 1);
                const lz = (vi >> CHUNK_BITS) & (CHUNK_SIZE - 1);
                const ly = vi >> (CHUNK_BITS + CHUNK_BITS);

                const wx = wxBase + lx;
                const wy = wyBase + ly;
                const wz = wzBase + lz;

                if (wx < minX) minX = wx;
                if (wx > maxX) maxX = wx;
                if (wy < minY) minY = wy;
                if (wy > maxY) maxY = wy;
                if (wz < minZ) minZ = wz;
                if (wz > maxZ) maxZ = wz;
                found = true;
            }
        }
    }

    if (!found) return null;

    return {
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
        dimensions: [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1],
    };
}

// ── forEach ────────────────────────────────────────────────────────
//
// calls cb(wx, wy, wz) for each set voxel. no allocation.

export function forEach(sel: Selection, cb: (wx: number, wy: number, wz: number) => void): void {
    for (const [key, chunk] of sel.chunks) {
        const parts = key.split(',');
        const cx = parseInt(parts[0]!, 10);
        const cy = parseInt(parts[1]!, 10);
        const cz = parseInt(parts[2]!, 10);
        const wxBase = cx << CHUNK_BITS;
        const wyBase = cy << CHUNK_BITS;
        const wzBase = cz << CHUNK_BITS;

        for (let w = 0; w < WORDS_PER_CHUNK; w++) {
            let word = chunk.bits[w]!;
            if (!word) continue;
            const bitBase = w << 5;
            while (word) {
                const lowestBit = word & -word;
                const bitIdx = 31 - Math.clz32(lowestBit);
                word &= ~lowestBit;

                const vi = bitBase + bitIdx;
                const lx = vi & (CHUNK_SIZE - 1);
                const lz = (vi >> CHUNK_BITS) & (CHUNK_SIZE - 1);
                const ly = vi >> (CHUNK_BITS + CHUNK_BITS);

                cb(wxBase + lx, wyBase + ly, wzBase + lz);
            }
        }
    }
}
