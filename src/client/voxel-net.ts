import type * as Protocol from '../core/protocol';
import { AIR, MISSING } from '../core/voxels/block-registry';
import { CullType } from '../core/voxels/blocks';
import { decodeChunk, decodeLight } from '../core/voxels/chunk-codec';
import * as Voxels from '../core/voxels/voxels';
import type { ClientNet } from './net';
import * as Net from './net';

type ChunkCoord = { cx: number; cy: number; cz: number };

export type VoxelNet = {
    /** chunks decoded + applied per player since the last flush, drained into one
     *  voxel_ack each to release the server's in-flight backpressure slots. */
    ackBuffer: Map<number, ChunkCoord[]>;
};

export function init(): VoxelNet {
    return { ackBuffer: new Map() };
}

export function flushAcks(voxelNet: VoxelNet, net: ClientNet): void {
    for (const [playerId, full] of voxelNet.ackBuffer) {
        if (full.length === 0) continue;
        Net.send(net, { type: 'voxel_ack', playerId, full });
    }
    voxelNet.ackBuffer.clear();
}

function queueAck(voxelNet: VoxelNet, playerId: number, coord: ChunkCoord): void {
    let buf = voxelNet.ackBuffer.get(playerId);
    if (!buf) {
        buf = [];
        voxelNet.ackBuffer.set(playerId, buf);
    }
    buf.push({ cx: coord.cx, cy: coord.cy, cz: coord.cz });
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

export function applyChunkFull(voxelNet: VoxelNet, voxels: Voxels.Voxels, message: Protocol.VoxelChunkFull): void {
    const { data, light } = decodeChunk(message.compressed);
    const key = Voxels.chunkKey(message.cx, message.cy, message.cz);

    let chunk = voxels.chunks.get(key);
    if (!chunk) {
        chunk = Voxels.createChunk(message.cx, message.cy, message.cz);
        voxels.chunks.set(key, chunk);
        Voxels.linkChunkNeighbors(voxels, chunk);
    }

    chunk.data = data;
    chunk.light = light;

    // wire carries registry-global state ids; map each back to its durable key so
    // the palette survives registry hot-reload. unknown ids (skew) fall back to ''.
    const stateToKey = voxels.registry.stateToKey;
    chunk.paletteKeys = message.palette.map((id) => stateToKey[id] ?? '');
    chunk.paletteMap = new Map();
    for (let i = 0; i < chunk.paletteKeys.length; i++) {
        chunk.paletteMap.set(chunk.paletteKeys[i]!, i);
    }

    Voxels.resolveChunk(chunk, voxels.registry);
    Voxels.markChunkDirty(voxels, chunk);
    dirtyAllNeighbors(voxels, chunk);

    queueAck(voxelNet, message.playerId, message);
}

export function applyChunkOps(voxels: Voxels.Voxels, message: Protocol.VoxelChunkOps): void {
    for (const entry of message.chunks) {
        const key = Voxels.chunkKey(entry.cx, entry.cy, entry.cz);
        const chunk = voxels.chunks.get(key);
        if (!chunk) continue;

        // COW out of the shared empty-stub array before mutating: chunks promoted
        // from voxel_chunk_empty alias Voxels.EMPTY_DATA.
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

export function applyChunkDel(voxels: Voxels.Voxels, message: Protocol.VoxelChunkDel): void {
    const key = Voxels.chunkKey(message.cx, message.cy, message.cz);
    const chunk = voxels.chunks.get(key);
    if (chunk) {
        Voxels.unlinkChunkNeighbors(chunk);
        voxels.dirty.blocks.delete(chunk);
    }
    voxels.chunks.delete(key);
    voxels.dirty.removed.add(key);
}

export function applyChunkEmpty(voxels: Voxels.Voxels, message: Protocol.VoxelChunkEmpty): void {
    for (const c of message.chunks) {
        const key = Voxels.chunkKey(c.cx, c.cy, c.cz);
        // a real chunk already present (full upgrade arrived first) wins.
        if (voxels.chunks.has(key)) continue;
        const chunk = Voxels.createEmptyChunk(c.cx, c.cy, c.cz);
        voxels.chunks.set(key, chunk);
        Voxels.linkChunkNeighbors(voxels, chunk);
    }
}
