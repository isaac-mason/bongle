import type * as Protocol from '../core/protocol';
import { AIR, MISSING } from '../core/voxels/block-registry';
import { CullType } from '../core/voxels/blocks';
import { decodeChunk, decodeLight } from '../core/voxels/chunk-codec';
import * as Voxels from '../core/voxels/voxels';
import type { ClientNet } from './net';
import * as Net from './net';
import * as Pacing from './voxel-pacing';

type ChunkCoord = { cx: number; cy: number; cz: number };
type RegionCoord = { rx: number; ry: number; rz: number };

export type VoxelNet = {
    /** individual chunk coords decoded + applied since the last flush —
     *  PROMOTION channel only (voxel_chunk_full: an already-known chunk
     *  re-sent after too many block-ops). drained into one voxel_ack.full
     *  each, to release the server's per-chunk in-flight slots. */
    ackBuffer: Map<number, ChunkCoord[]>;
    /** region coords decoded + applied since the last flush — DISCOVERY
     *  channel (voxel_region_full). drained into one voxel_ack.regions each,
     *  to release the server's per-region in-flight slots. */
    regionAckBuffer: Map<number, RegionCoord[]>;
    /** per-player adaptive region-decode pacing (see voxel-pacing.ts). */
    pacing: Map<number, Pacing.RegionBatchPacing>;
    /** decode wall-clock (ns) accumulated per player across the current
     *  processInbox pass, via `recordRegionDecodeTime`. paired with the same
     *  player's `regionAckBuffer` length (one decoded region = one ack entry)
     *  for the pacing sample, then reset by flushAcks. promotion's individual
     *  voxel_chunk_full isn't timed — it's a fixed-rate channel, not adaptive
     *  (see discovery.ts's FULL_CHUNKS_PER_CLIENT_PER_TICK). */
    batchNanos: Map<number, number>;
};

export function init(): VoxelNet {
    return { ackBuffer: new Map(), regionAckBuffer: new Map(), pacing: new Map(), batchNanos: new Map() };
}

/** record one voxel_region_full's decode wall-clock against this player's
 *  running batch total. call around `applyRegionFull`. */
export function recordRegionDecodeTime(voxelNet: VoxelNet, playerId: number, elapsedMs: number): void {
    voxelNet.batchNanos.set(playerId, (voxelNet.batchNanos.get(playerId) ?? 0) + elapsedMs * 1_000_000);
}

export function flushAcks(voxelNet: VoxelNet, net: ClientNet): void {
    const playerIds = new Set<number>([...voxelNet.ackBuffer.keys(), ...voxelNet.regionAckBuffer.keys()]);
    for (const playerId of playerIds) {
        const full = voxelNet.ackBuffer.get(playerId) ?? [];
        const regions = voxelNet.regionAckBuffer.get(playerId) ?? [];
        if (full.length === 0 && regions.length === 0) continue;

        let pacing = voxelNet.pacing.get(playerId);
        if (!pacing) {
            pacing = Pacing.init();
            voxelNet.pacing.set(playerId, pacing);
        }
        Pacing.recordBatch(pacing, regions.length, voxelNet.batchNanos.get(playerId) ?? 0);

        Net.send(net, {
            type: 'voxel_ack',
            playerId,
            full,
            regions,
            desiredRegionsPerTick: Pacing.desiredRegionsPerTick(pacing),
        });
    }
    voxelNet.batchNanos.clear();
    voxelNet.ackBuffer.clear();
    voxelNet.regionAckBuffer.clear();
}

function queueAck(voxelNet: VoxelNet, playerId: number, coord: ChunkCoord): void {
    let buf = voxelNet.ackBuffer.get(playerId);
    if (!buf) {
        buf = [];
        voxelNet.ackBuffer.set(playerId, buf);
    }
    buf.push(coord);
}

function queueRegionAck(voxelNet: VoxelNet, playerId: number, coord: RegionCoord): void {
    let buf = voxelNet.regionAckBuffer.get(playerId);
    if (!buf) {
        buf = [];
        voxelNet.regionAckBuffer.set(playerId, buf);
    }
    buf.push(coord);
}

// the mesher reads a 1-voxel apron from all 26 neighbours (6 faces + 12 edges +
// 8 corners) for AO + smooth light, so a whole-chunk replacement must remesh
// every one or stale light lingers at chunk edges. follows neighbour pointers,
// so the chunk must already be linked.
function dirtyAllNeighbors(voxels: Voxels.Voxels, chunk: Voxels.Chunk): void {
    for (let i = 0; i < chunk.neighbors.length; i++) {
        const n = chunk.neighbors[i];
        if (n) Voxels.markChunkDirty(voxels, n);
    }
}

/** decode + apply one occupied chunk's payload, whether it arrived as an
 *  individual voxel_chunk_full (promotion) or as one entry in a
 *  voxel_region_full bundle (discovery) — same chunk data, same application
 *  logic either way, just a different envelope. */
function applyOneChunkFull(
    voxels: Voxels.Voxels,
    cx: number,
    cy: number,
    cz: number,
    palette: number[],
    compressed: Uint8Array,
): void {
    const { data, light } = decodeChunk(compressed);
    const key = Voxels.chunkKey(cx, cy, cz);

    let chunk = voxels.chunks.get(key);
    if (!chunk) {
        chunk = Voxels.createChunk(cx, cy, cz);
        voxels.chunks.set(key, chunk);
        Voxels.linkChunkNeighbors(voxels, chunk);
    }

    chunk.data = data;
    chunk.light = light;

    // wire carries registry-global state ids; map each back to its durable key so
    // the palette survives registry hot-reload. unknown ids (skew) fall back to ''.
    const stateToKey = voxels.registry.stateToKey;
    chunk.paletteKeys = palette.map((id) => stateToKey[id] ?? '');
    chunk.paletteMap = new Map();
    for (let i = 0; i < chunk.paletteKeys.length; i++) {
        chunk.paletteMap.set(chunk.paletteKeys[i]!, i);
    }

    Voxels.resolveChunk(chunk, voxels.registry);
    Voxels.markChunkDirty(voxels, chunk);
    dirtyAllNeighbors(voxels, chunk);
}

/** create the all-air stub for one chunk slot known to be empty, whether it
 *  arrived as a voxel_region_full unset bit (discovery) — the only source
 *  today, promotion never announces empty slots. a real chunk already present
 *  (a full upgrade arrived first) wins, never overwritten by a later empty
 *  marker for the same slot. */
function applyOneChunkEmpty(voxels: Voxels.Voxels, cx: number, cy: number, cz: number): void {
    const key = Voxels.chunkKey(cx, cy, cz);
    if (voxels.chunks.has(key)) return;
    const chunk = Voxels.createEmptyChunk(cx, cy, cz);
    voxels.chunks.set(key, chunk);
    Voxels.linkChunkNeighbors(voxels, chunk);
}

/** drop one chunk slot, whether evicted individually (no longer reachable —
 *  eviction is region-bundled today, see applyRegionDel) or as part of a
 *  region's worth of removals. a no-op if the slot was never known (the
 *  common case for a region's air slots — most of a region's REGION_VOLUME
 *  local positions never had a chunk at all). */
function applyOneChunkDel(voxels: Voxels.Voxels, cx: number, cy: number, cz: number): void {
    const key = Voxels.chunkKey(cx, cy, cz);
    const chunk = voxels.chunks.get(key);
    if (!chunk) return;
    Voxels.unlinkChunkNeighbors(chunk);
    voxels.dirty.blocks.delete(chunk);
    voxels.chunks.delete(key);
    voxels.dirty.removed.add(key);
}

/** PROMOTION channel: an already-known chunk re-sent in full (too many
 *  block-ops landed in it server-side this tick). fixed-rate, not adaptive —
 *  see discovery.ts's FULL_CHUNKS_PER_CLIENT_PER_TICK — so this isn't timed
 *  for pacing the way applyRegionFull is. */
export function applyChunkFull(voxelNet: VoxelNet, voxels: Voxels.Voxels, message: Protocol.VoxelChunkFull): void {
    applyOneChunkFull(voxels, message.cx, message.cy, message.cz, message.palette, message.compressed);
    queueAck(voxelNet, message.playerId, { cx: message.cx, cy: message.cy, cz: message.cz });
}

/** DISCOVERY channel: a newly-known region's worth of chunks bundled into one
 *  message — a presence bitmask over the region's REGION_VOLUME local chunk
 *  slots (`REGION_LOCAL_CHUNK_OFFSETS` order, shared with the server) plus a
 *  dense list of only the occupied slots' payloads. no per-chunk coordinates
 *  on the wire: this walk reconstructs each slot's (cx,cy,cz) from the
 *  region's origin + its position in the shared fixed order. */
export function applyRegionFull(voxelNet: VoxelNet, voxels: Voxels.Voxels, message: Protocol.VoxelRegionFull): void {
    const bx = message.rx * Voxels.REGION_CHUNKS_PER_AXIS;
    const by = message.ry * Voxels.REGION_CHUNKS_PER_AXIS;
    const bz = message.rz * Voxels.REGION_CHUNKS_PER_AXIS;

    let chunkIdx = 0;
    for (let i = 0; i < Voxels.REGION_LOCAL_CHUNK_OFFSETS.length; i++) {
        const [lx, ly, lz] = Voxels.REGION_LOCAL_CHUNK_OFFSETS[i]!;
        const cx = bx + lx;
        const cy = by + ly;
        const cz = bz + lz;
        if (message.occupied[i]) {
            const payload = message.chunks[chunkIdx++]!;
            applyOneChunkFull(voxels, cx, cy, cz, payload.palette, payload.compressed);
        } else {
            applyOneChunkEmpty(voxels, cx, cy, cz);
        }
    }

    queueRegionAck(voxelNet, message.playerId, { rx: message.rx, ry: message.ry, rz: message.rz });
}

/** DISCOVERY channel's eviction counterpart: drop every chunk slot in a
 *  region the client drifted out of range of. no per-chunk coordinate list
 *  needed — walks the same shared REGION_LOCAL_CHUNK_OFFSETS order and drops
 *  whatever's actually present (most slots in a typical region are already
 *  air and were never a real chunk, applyOneChunkDel no-ops for those). */
export function applyRegionDel(voxels: Voxels.Voxels, message: Protocol.VoxelRegionDel): void {
    const bx = message.rx * Voxels.REGION_CHUNKS_PER_AXIS;
    const by = message.ry * Voxels.REGION_CHUNKS_PER_AXIS;
    const bz = message.rz * Voxels.REGION_CHUNKS_PER_AXIS;

    for (const [lx, ly, lz] of Voxels.REGION_LOCAL_CHUNK_OFFSETS) {
        applyOneChunkDel(voxels, bx + lx, by + ly, bz + lz);
    }
}

export function applyChunkOps(voxels: Voxels.Voxels, message: Protocol.VoxelChunkOps): void {
    for (const entry of message.chunks) {
        const key = Voxels.chunkKey(entry.cx, entry.cy, entry.cz);
        const chunk = voxels.chunks.get(key);
        if (!chunk) continue;

        // COW out of the shared empty-stub array before mutating: chunks promoted
        // from a voxel_region_full empty slot alias Voxels.EMPTY_DATA.
        if (chunk.data === Voxels.EMPTY_DATA) chunk.data = new Uint16Array(Voxels.EMPTY_DATA);

        // each change carries a registry-global state id, interned into THIS
        // chunk's own local palette slot so a client palette that diverged from
        // the server's reconciles cleanly instead of drifting.
        const registry = voxels.registry;
        const stateToKey = registry.stateToKey;
        const cull = registry.cull;
        let faces = 0;
        for (const change of entry.changes) {
            // explicit `: number` cuts the inference chain: `change` is a recursive
            // pack.SchemaType and chaining locals off it trips a tsgo circular bail.
            const oldPaletteIdx: number = chunk.data[change.index]!;
            const newStateId: number = change.stateId;
            const newPaletteIdx: number = Voxels.ensureChunkPaletteSlot(chunk, stateToKey[newStateId] ?? '', registry);
            chunk.data[change.index] = newPaletteIdx;

            const oldId = chunk.palette[oldPaletteIdx]!;
            const newId = chunk.palette[newPaletteIdx]!;
            const wasAir = oldId === AIR || oldId === MISSING;
            const isAir = newId === AIR || newId === MISSING;
            if (wasAir && !isAir) chunk.nonAirCount++;
            else if (!wasAir && isAir) chunk.nonAirCount--;

            const wasSolid = cull[oldId] === CullType.SOLID;
            const isSolid = cull[newId] === CullType.SOLID;
            if (!wasSolid && isSolid) chunk.solidCount++;
            else if (wasSolid && !isSolid) chunk.solidCount--;

            const x = change.index & 0xf;
            const y = change.index >> 8;
            const z = (change.index >> 4) & 0xf;
            if (x === 0) faces |= 1;
            if (x === 15) faces |= 2;
            if (y === 0) faces |= 4;
            if (y === 15) faces |= 8;
            if (z === 0) faces |= 16;
            if (z === 15) faces |= 32;
        }

        dirtyTouchedNeighbors(voxels, entry, faces);

        chunk.version++;
        Voxels.markChunkDirty(voxels, chunk);
    }
}

function dirtyTouchedNeighbors(voxels: Voxels.Voxels, entry: ChunkCoord, faces: number): void {
    const dirty = (dx: number, dy: number, dz: number): void => {
        const c = voxels.chunks.get(Voxels.chunkKey(entry.cx + dx, entry.cy + dy, entry.cz + dz));
        if (c) Voxels.markChunkDirty(voxels, c);
    };
    if (faces & 1) dirty(-1, 0, 0);
    if (faces & 2) dirty(1, 0, 0);
    if (faces & 4) dirty(0, -1, 0);
    if (faces & 8) dirty(0, 1, 0);
    if (faces & 16) dirty(0, 0, -1);
    if (faces & 32) dirty(0, 0, 1);
}

export function applyChunkLight(voxels: Voxels.Voxels, message: Protocol.VoxelChunkLight): void {
    const key = Voxels.chunkKey(message.cx, message.cy, message.cz);
    const chunk = voxels.chunks.get(key);
    if (!chunk) return;

    chunk.light = decodeLight(message.sky, message.rgb);
    chunk.version++;

    Voxels.markChunkDirty(voxels, chunk);
    dirtyAllNeighbors(voxels, chunk);
}

// scratch 3×3×3 neighbour mask, indexed (dz+1)*9 + (dy+1)*3 + (dx+1), reused
// across the delta loop to avoid per-chunk allocation.
const neighbourCellMask = new Uint8Array(27);

export function applyChunkLightDelta(voxels: Voxels.Voxels, message: Protocol.VoxelChunkLightDelta): void {
    const key = Voxels.chunkKey(message.cx, message.cy, message.cz);
    const chunk = voxels.chunks.get(key);
    if (!chunk) return;

    neighbourCellMask.fill(0);

    for (const change of message.changes) {
        chunk.light[change.index] = change.light;

        const idx = change.index;
        const x = idx & 0xf;
        const z = (idx >> 4) & 0xf;
        const y = idx >> 8;

        const dxLo = x === 0 ? -1 : 0;
        const dxHi = x === 15 ? 1 : 0;
        const dyLo = y === 0 ? -1 : 0;
        const dyHi = y === 15 ? 1 : 0;
        const dzLo = z === 0 ? -1 : 0;
        const dzHi = z === 15 ? 1 : 0;

        for (let dz = dzLo; dz <= dzHi; dz++) {
            for (let dy = dyLo; dy <= dyHi; dy++) {
                for (let dx = dxLo; dx <= dxHi; dx++) {
                    neighbourCellMask[(dz + 1) * 9 + (dy + 1) * 3 + (dx + 1)] = 1;
                }
            }
        }
    }

    chunk.version++;
    Voxels.markChunkDirty(voxels, chunk);

    for (let i = 0; i < 27; i++) {
        if (i === 13) continue;
        if (neighbourCellMask[i] === 0) continue;
        const dx = (i % 3) - 1;
        const dy = (((i / 3) | 0) % 3) - 1;
        const dz = ((i / 9) | 0) - 1;
        const nc = voxels.chunks.get(Voxels.chunkKey(message.cx + dx, message.cy + dy, message.cz + dz));
        if (nc) Voxels.markChunkDirty(voxels, nc);
    }
}
