import type { Camera, Material, NonIndexedMeshDraw } from 'gpucat';
import { BufferLifecycle, d, Geometry, GpuBuffer, packTo } from 'gpucat';
import type { Vec3 } from 'math';
import type { Resources } from '../../core/resources';
import type { Blocks } from '../../core/voxels/block-registry';
import { buildMeshInput, type ChunkMeshResult, type MeshOutput, meshChunk, type PassMesh } from '../../core/voxels/chunk-mesher';
import { CHUNK_SIZE, type Chunk, chunkKey, markChunkDirty, type Voxels } from '../../core/voxels/voxels';
import type { EnvironmentResources } from '../environment/environment';
import type { TimeResources } from '../time';
import { createMesher, disposeMesher, loadMeshWorker, type Mesher, resetMeshCaches, setMeshRegistry } from './mesher';
import {
    arenaAlloc,
    arenaDispose,
    arenaFree,
    arenaWrite,
    buildCullView,
    type ChunkAlloc,
    ChunkInfo,
    CULL_VIEW_FLOATS,
    createQuadArena,
    hasNoVisibleSurface,
    PASSES,
    type QuadArena,
    type SectionEntryFields,
    type VoxelArenaBudget,
} from './voxel-arena';
import { lightVolumeConfigOf, routeLightVolumeBuffers } from './voxel-light-sample';
import { createLightVolume, evictChunkLightByKey, type LightVolume } from './voxel-light-volume';
import { createCpuQuadMaterial, type VoxelPass } from './voxel-material';
import {
    createVoxelTextures,
    loadAtlasMeta,
    loadVoxelTextures,
    type TileAtlasMetadata,
    type VoxelTextures,
} from './voxel-textures';
import type { VoxelVisuals } from './voxel-visuals';

// This backend owns its arena end to end (quad arena, per-pass CPU section tables,
// residency/eviction packer), independent of the WebGPU producer's mirror implementation.

// Plain state; sectionAllocSlot/sectionFreeSlot/sectionWriteEntry/sectionDispose are standalone functions over it.
type CpuSectionTable = {
    readonly slotCount: number;
    /** ChunkInfo {origin, arenaBase}, bound as 'chunkInfo' on each pass geometry. */
    readonly buffer: GpuBuffer;
    readonly dataU32: Uint32Array;
    readonly entryU32s: number;
    readonly cpuDataCount: Uint32Array; // 1 per slot (translucent slice quadCount)
    readonly cpuFaceOffsets: Uint32Array; // 7 per slot (localBase per facing)
    readonly cpuFaceCounts: Uint32Array; // 7 per slot
    // Last stamped (dataStart, dataCount) per slot; sentinel 0xffffffff means unstamped/free.
    readonly stampedBase: Uint32Array;
    readonly stampedCount: Uint32Array;
    /** free slot indices (LIFO); a slot is live iff it's not on the stack. */
    readonly freeStack: number[];
};

function createCpuSectionTable(slotCount: number): CpuSectionTable {
    // GPU side-table holds only origin + arenaBase (16B/entry); face offsets/counts and dataCount live in the CPU mirrors below.
    const buffer = new GpuBuffer(d.array(ChunkInfo), {
        count: slotCount,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const arrF32 = buffer.array as Float32Array;
    const dataU32 = new Uint32Array(arrF32.buffer, arrF32.byteOffset, arrF32.length);
    const freeStack: number[] = new Array(slotCount);
    for (let i = 0; i < slotCount; i++) freeStack[i] = slotCount - 1 - i;
    return {
        slotCount,
        buffer,
        dataU32,
        entryU32s: arrF32.length / slotCount,
        cpuDataCount: new Uint32Array(slotCount),
        cpuFaceOffsets: new Uint32Array(slotCount * 7),
        cpuFaceCounts: new Uint32Array(slotCount * 7),
        stampedBase: new Uint32Array(slotCount).fill(0xffffffff),
        stampedCount: new Uint32Array(slotCount).fill(0xffffffff),
        freeStack,
    };
}

function sectionAllocSlot(t: CpuSectionTable): number {
    const slot = t.freeStack.pop();
    if (slot === undefined) throw new Error(`SectionTable OOM at ${t.slotCount}`);
    return slot;
}

function sectionFreeSlot(t: CpuSectionTable, slot: number): void {
    const base = slot * t.entryU32s;
    for (let i = 0; i < t.entryU32s; i++) t.dataU32[base + i] = 0;
    t.buffer.addUpdateRange(base, t.entryU32s);
    // zero the CPU mirrors too, so a stale read can't sneak through.
    t.cpuDataCount[slot] = 0;
    const facingBase = slot * 7;
    for (let i = 0; i < 7; i++) {
        t.cpuFaceOffsets[facingBase + i] = 0;
        t.cpuFaceCounts[facingBase + i] = 0;
    }
    t.stampedBase[slot] = 0xffffffff;
    t.stampedCount[slot] = 0xffffffff;
    t.freeStack.push(slot);
}

function sectionWriteEntry(t: CpuSectionTable, slot: number, entry: SectionEntryFields): void {
    const base = slot * t.entryU32s;
    packTo(ChunkInfo, t.dataU32, base * 4, {
        origin: [entry.originX, entry.originY, entry.originZ],
        arenaBase: entry.dataStart,
    });
    t.buffer.addUpdateRange(base, t.entryU32s);
    t.cpuDataCount[slot] = entry.dataCount;
    const facingBase = slot * 7;
    for (let i = 0; i < 7; i++) {
        t.cpuFaceOffsets[facingBase + i] = entry.faceOffsets[i]!;
        t.cpuFaceCounts[facingBase + i] = entry.faceCounts[i]!;
    }
}

function sectionDispose(t: CpuSectionTable): void {
    t.buffer.dispose();
}

// The arena is its own residency manager: the packer* functions below are the residency layer over the raw quadArena slab + section tables.
type CpuVoxelArena = {
    quadArena: QuadArena;
    tables: Record<VoxelPass, CpuSectionTable>;
    /** keyed by bare chunk coord key (arena holds one world at a time). */
    allocs: Map<string, ChunkAlloc>;
    residentKeys: Set<string>;
    /** dense list of held ChunkAllocs; `cullEmit` iterates it. swap-pop on evict. */
    chunks: ChunkAlloc[];
    /** per-chunk worldspace min corner; consumed by OOM eviction (farthest-first). */
    origins: Map<string, [number, number, number]>;
    /** camera position, so eviction measures distance in world space. null offline. */
    camera: Vec3 | null;
    /** chunk keys evicted under memory pressure this frame, self-heal re-dirties them. */
    evicted: Set<string>;
};

function createCpuVoxelArena(budget: VoxelArenaBudget): CpuVoxelArena {
    const quadArena = createQuadArena(budget.quadArenaBytes, budget.maxAllocs);
    return {
        quadArena,
        tables: {
            opaque: createCpuSectionTable(budget.maxSections),
            transparent: createCpuSectionTable(budget.maxSections),
            translucent: createCpuSectionTable(budget.maxSections),
        },
        allocs: new Map(),
        residentKeys: new Set(),
        chunks: [],
        origins: new Map(),
        camera: null,
        evicted: new Set(),
    };
}

function packerFreePass(packer: CpuVoxelArena, pass: VoxelPass, a: { sectionSlot: number; dataStart: number }): void {
    arenaFree(packer.quadArena, a.dataStart);
    sectionFreeSlot(packer.tables[pass], a.sectionSlot);
}

// Swap-pop packer.chunks[idx]: the last chunk backfills the hole and its chunkIndex is updated.
function removeChunkAt(packer: CpuVoxelArena, idx: number): void {
    if (idx < 0) return;
    const last = packer.chunks.pop()!;
    const lastIdx = packer.chunks.length;
    if (idx < lastIdx) {
        packer.chunks[idx] = last;
        last.chunkIndex = idx;
    }
}

function packerUpsertChunk(packer: CpuVoxelArena, key: string, origin: [number, number, number], mesh: ChunkMeshResult): void {
    const prev = packer.allocs.get(key);
    const next: ChunkAlloc = prev ?? {
        opaque: null,
        transparent: null,
        translucent: null,
        aabb: [0, 0, 0, 0, 0, 0],
        key,
        chunkIndex: -1,
    };
    const meshAabb = mesh.aabb;
    if (meshAabb) {
        next.aabb[0] = meshAabb.min[0];
        next.aabb[1] = meshAabb.min[1];
        next.aabb[2] = meshAabb.min[2];
        next.aabb[3] = meshAabb.max[0];
        next.aabb[4] = meshAabb.max[1];
        next.aabb[5] = meshAabb.max[2];
    } else {
        next.aabb[0] = 0;
        next.aabb[1] = 0;
        next.aabb[2] = 0;
        next.aabb[3] = 0;
        next.aabb[4] = 0;
        next.aabb[5] = 0;
    }

    for (const pass of PASSES) {
        const passMesh: PassMesh | null = mesh[pass];
        const cur = next[pass];

        if (!passMesh || passMesh.quadCount === 0) {
            if (cur) {
                packerFreePass(packer, pass, cur);
                next[pass] = null;
            }
            continue;
        }

        const needQuads = passMesh.quadCount;
        // free cur's prior quad range up front (re-upsert reallocates it below).
        if (cur) arenaFree(packer.quadArena, cur.dataStart);
        const dataStart = packerAllocWithEviction(packer, key, needQuads);
        // graceful degrade: arena full and nothing evictable, drop this pass.
        if (dataStart < 0) {
            if (cur) sectionFreeSlot(packer.tables[pass], cur.sectionSlot);
            next[pass] = null;
            continue;
        }
        arenaWrite(packer.quadArena, 'quads', dataStart, needQuads, passMesh.quads);

        const table = packer.tables[pass];
        const sectionSlot = cur?.sectionSlot ?? packerAllocSlotWithEviction(packer, key, pass);
        if (sectionSlot < 0) {
            arenaFree(packer.quadArena, dataStart);
            next[pass] = null;
            continue;
        }

        sectionWriteEntry(table, sectionSlot, {
            originX: origin[0],
            originY: origin[1],
            originZ: origin[2],
            dataStart,
            dataCount: needQuads,
            faceOffsets: passMesh.faceOffsets,
            faceCounts: passMesh.faceCounts,
            flags: 1, // bit 0 = occupied
        });
        next[pass] = { sectionSlot, dataStart, dataCount: needQuads };
    }

    const empty = !next.opaque && !next.transparent && !next.translucent;
    if (empty) {
        if (prev) removeChunkAt(packer, prev.chunkIndex);
        packer.allocs.delete(key);
        packer.origins.delete(key);
        packer.residentKeys.delete(key);
    } else {
        if (!prev) {
            next.chunkIndex = packer.chunks.length;
            packer.chunks.push(next);
        }
        packer.allocs.set(key, next);
        packer.origins.set(key, origin);
        packer.residentKeys.add(key);
    }
}

function packerClearAll(packer: CpuVoxelArena): void {
    for (const alloc of packer.allocs.values()) {
        for (const pass of PASSES) {
            const a = alloc[pass];
            if (a) packerFreePass(packer, pass, a);
        }
    }
    packer.allocs.clear();
    packer.origins.clear();
    packer.residentKeys.clear();
    packer.chunks.length = 0;
    packer.evicted.clear();
}

function packerEvictChunk(packer: CpuVoxelArena, key: string): void {
    const cur = packer.allocs.get(key);
    if (!cur) return;
    for (const pass of PASSES) {
        const a = cur[pass];
        if (a) packerFreePass(packer, pass, a);
    }
    removeChunkAt(packer, cur.chunkIndex);
    packer.allocs.delete(key);
    packer.origins.delete(key);
    packer.residentKeys.delete(key);
}

function packerHas(packer: CpuVoxelArena, key: string): boolean {
    return packer.allocs.has(key);
}

// Picks the chunk farthest from the camera to evict, excluding excludeKey; returns null when nothing else is resident.
function evictionVictim(packer: CpuVoxelArena, excludeKey: string): string | null {
    const cam = packer.camera;
    let bestKey: string | null = null;
    let bestDistSq = -1;
    for (const [key, origin] of packer.origins) {
        if (key === excludeKey) continue;
        const distSq = cam
            ? (origin[0] + CHUNK_SIZE * 0.5 - cam[0]) ** 2 +
              (origin[1] + CHUNK_SIZE * 0.5 - cam[1]) ** 2 +
              (origin[2] + CHUNK_SIZE * 0.5 - cam[2]) ** 2
            : Number.POSITIVE_INFINITY; // no camera (offline): evict first
        if (distSq > bestDistSq) {
            bestDistSq = distSq;
            bestKey = key;
        }
    }
    return bestKey;
}

// Queues a pressure-evicted chunk to re-mesh next frame; deliberate evicts (reconcile, clearAll) must not call this.
function recordEviction(packer: CpuVoxelArena, key: string): void {
    if (packer.allocs.has(key)) packer.evicted.add(key);
}

function packerAllocWithEviction(packer: CpuVoxelArena, upsertKey: string, slots: number): number {
    for (;;) {
        try {
            return arenaAlloc(packer.quadArena, slots);
        } catch {
            const victim = evictionVictim(packer, upsertKey);
            if (!victim) return -1;
            recordEviction(packer, victim);
            packerEvictChunk(packer, victim);
        }
    }
}

function packerAllocSlotWithEviction(packer: CpuVoxelArena, upsertKey: string, pass: VoxelPass): number {
    for (;;) {
        try {
            return sectionAllocSlot(packer.tables[pass]);
        } catch {
            const victim = evictionVictim(packer, upsertKey);
            if (!victim) return -1;
            recordEviction(packer, victim);
            packerEvictChunk(packer, victim);
        }
    }
}

// One shared 6-vert instanced geometry per pass; no geometry.indirect, since WebGL2 rejects it and mesh.draws carries the draw args instead.
function createGeometries(arenas: CpuVoxelArena, quadSlot: GpuBuffer, lightVolume: LightVolume): Record<VoxelPass, Geometry> {
    const out = {} as Record<VoxelPass, Geometry>;
    for (const pass of PASSES) {
        const g = new Geometry();
        g.setBuffer('quads', arenas.quadArena.buffers.quads);
        // quadSlot is the per-quad section-slot table; the vertex shader reads quadSlot[instanceIndex].
        g.setBuffer('quadSlot', quadSlot);
        // chunkInfo is per-slot {origin, arenaBase}; the vertex shader reads chunkInfo[slot].origin.
        g.setBuffer('chunkInfo', arenas.tables[pass].buffer);
        routeLightVolumeBuffers(g, lightVolume);
        out[pass] = g;
    }
    return out;
}

// The WebGL voxel resource handle: atlas, arena, mesher, per-pass geometries/materials, and this backend's CPU cull scratch.
export type VoxelResources = {
    /** block texture array + texture-animation metadata + atlas load lifecycle. */
    textures: VoxelTextures;
    /** unified per-pass quad materials, bound on each per-room `Mesh` alongside `geometries`. */
    quadMaterials: Record<VoxelPass, Material>;
    /** engine-global per-pass geometry (WebGL binds mesh.draws + quadSlot). */
    geometries: Record<VoxelPass, Geometry>;
    /** this backend's owned arena: quadArena + per-pass CPU section tables + residency/eviction packer. */
    arenas: CpuVoxelArena;
    /** off-thread mesh worker pool. null on asset-pipeline paths (workerCount=0). */
    meshDispatcher: Mesher | null;
    /** GPU-resident per-chunk light tiles + residency grid; a chunk may be lit without a mesh, but never meshed without light. */
    lightVolume: LightVolume;

    /** per-quad to section-slot table (one u32 per quad slot), bound as 'quadSlot' on every pass geometry. */
    quadSlot: { data: Uint32Array; buffer: GpuBuffer };
    /** per-pass reusable `mesh.draws` arrays, cleared and repopulated by cullEmit each frame. */
    draws: Record<VoxelPass, NonIndexedMeshDraw[]>;
};

export function init(registry: Blocks, env: EnvironmentResources, budget: VoxelArenaBudget, time: TimeResources): VoxelResources {
    console.log(`[cpu-voxel-frame] init, ${registry.textures.length} textures, ${registry.totalStates} states`);

    const textures = createVoxelTextures(registry);

    const elapsedTime = time.elapsedTime;
    const quadMaterials: Record<VoxelPass, Material> = {
        opaque: createCpuQuadMaterial({ textures, pass: 'opaque', elapsedTime, env }),
        transparent: createCpuQuadMaterial({ textures, pass: 'transparent', elapsedTime, env }),
        translucent: createCpuQuadMaterial({ textures, pass: 'translucent', elapsedTime, env }),
    };

    const arenas = createCpuVoxelArena(budget);

    // Owned here (not the packer); MANUAL lifecycle + explicit Uint32Array so the per-section fill(slot) bit-copies exactly.
    const quadSlotData = new Uint32Array(arenas.quadArena.slotCount);
    const quadSlotBuffer = new GpuBuffer(d.array(d.u32), {
        data: quadSlotData,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const quadSlot = { data: quadSlotData, buffer: quadSlotBuffer };

    // Built before the geometries, which bind its buffers by name.
    const lightVolume = createLightVolume(budget.lightGridChunkRadius, budget.maxLightTiles);
    env.lightVolumeConfig.value = lightVolumeConfigOf(lightVolume);
    const geometries = createGeometries(arenas, quadSlotBuffer, lightVolume);

    const draws: Record<VoxelPass, NonIndexedMeshDraw[]> = {
        opaque: [],
        transparent: [],
        translucent: [],
    };

    return {
        textures,
        quadMaterials,
        geometries,
        arenas,
        quadSlot,
        draws,
        meshDispatcher: null,
        lightVolume,
    };
}

// Fetches the atlas manifest, uploads atlas pixels, and spawns the mesh worker pool; mutates res in place.
export async function load(
    res: VoxelResources,
    registry: Blocks,
    workerCount: number,
    workerQueueDepth: number,
    resources: Resources,
    meta?: TileAtlasMetadata | null,
): Promise<void> {
    await loadVoxelTextures(res.textures, registry, resources.loader, meta);

    if (workerCount > 0 && typeof Worker !== 'undefined') {
        // Guarded by typeof Worker so runtimes that never spawn workers (asset pipeline, node/happy-dom) fall through to inline meshing.
        await loadMeshWorker();
        const meshDispatcher = createMesher({ workerCount, queueDepth: workerQueueDepth });
        setMeshRegistry(meshDispatcher, registry);
        res.meshDispatcher = meshDispatcher;
    }
}

// Builds new resources, or reuses prev if the atlas and animation metadata are unchanged.
export async function refresh(
    prev: VoxelResources | null,
    registry: Blocks,
    env: EnvironmentResources,
    budget: VoxelArenaBudget,
    time: TimeResources,
    workerCount: number,
    workerQueueDepth: number,
    resources: Resources,
): Promise<{ resources: VoxelResources; changed: boolean }> {
    const meta = await loadAtlasMeta(resources.loader);
    if (
        prev &&
        meta !== null &&
        prev.textures.hash !== null &&
        meta.hash === prev.textures.hash &&
        f32Equal(prev.textures.texAnimData, registry.texAnimData)
    ) {
        // The registry may have been rebuilt, so push it to the workers; in-flight jobs finish with the old registry and get gen-dropped by callers.
        if (prev.meshDispatcher) setMeshRegistry(prev.meshDispatcher, registry);
        return { resources: prev, changed: false };
    }
    // Build and load the replacement before disposing prev, since the caller keeps rendering prev across load's async gap.
    const built = init(registry, env, budget, time);
    await load(built, registry, workerCount, workerQueueDepth, resources, meta);
    if (prev) dispose(prev);
    return { resources: built, changed: true };
}

function f32Equal(a: Float32Array, b: Float32Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

export function dispose(state: VoxelResources): void {
    state.textures.atlas.dispose();
    state.textures.entriesBuffer.dispose();
    state.quadMaterials.opaque.dispose();
    state.quadMaterials.transparent.dispose();
    state.quadMaterials.translucent.dispose();
    for (const pass of PASSES) state.geometries[pass].dispose();
    arenaDispose(state.arenas.quadArena);
    for (const pass of PASSES) sectionDispose(state.arenas.tables[pass]);
    state.quadSlot.buffer.dispose();
    if (state.meshDispatcher) disposeMesher(state.meshDispatcher);
}

// The CPU counterpart of the GPU cull-emit chain (createCullCompute/createEmitCompute in voxel-resources-gpu); keep in sync.
const HALF = CHUNK_SIZE * 0.5;
const NEG_HALF = -CHUNK_SIZE * 0.5;

// Per-frame cull scratch shared across rooms; safe because cullEmit runs synchronously with no await between fill and use.
const _cullView = new Float32Array(CULL_VIEW_FLOATS);
// Back-to-front translucent-sort scratch: resident translucent sections' chunk indices and squared camera distances.
const _tsortIdx: number[] = [];
const _tsortDist: number[] = [];

// Frustum plane test; planes live at cullView[0..19] (5 vec4s), section half-extent folded into .w.
function frustumIn(view: Float32Array, rx: number, ry: number, rz: number): boolean {
    for (let i = 0; i < 5; i++) {
        const b = i * 4;
        if (view[b]! * rx + view[b + 1]! * ry + view[b + 2]! * rz + view[b + 3]! < 0) return false;
    }
    return true;
}

// Facings 0-5 are +X/-X/+Y/-Y/+Z/-Z; facing 6 (UNASSIGNED) never reaches here since callers emit it unconditionally.
function facingVisible(rx: number, ry: number, rz: number, f: number): boolean {
    const axisVal = f < 2 ? rx : f < 4 ? ry : rz;
    const isPlus = f % 2 === 0;
    return isPlus ? axisVal < HALF : axisVal > NEG_HALF;
}

// Re-fills quadSlot[base..+count] = slot and marks the GPU updateRange only when the stamped range has changed.
function stampQuadSlot(res: VoxelResources, pass: VoxelPass, slot: number, base: number, count: number): void {
    const table = res.arenas.tables[pass];
    if (table.stampedBase[slot] === base && table.stampedCount[slot] === count) return;
    res.quadSlot.data.fill(slot, base, base + count);
    res.quadSlot.buffer.addUpdateRange(base, count);
    table.stampedBase[slot] = base;
    table.stampedCount[slot] = count;
}

// Per-frame producer: frustum/distance/cone culls resident sections and writes mesh.draws per pass (translucent sorted back-to-front, others per-facing).
export function cullEmit(res: VoxelResources, visuals: VoxelVisuals, camera: Camera, viewRadius: number): void {
    const view = _cullView;
    buildCullView(view, camera, viewRadius);
    const camCx = view[20]!;
    const camCy = view[21]!;
    const camCz = view[22]!;
    const camFracX = view[24]!;
    const camFracY = view[25]!;
    const camFracZ = view[26]!;
    const viewRadiusSq = view[27]!;

    const packer = res.arenas;
    const chunks = packer.chunks;
    const origins = packer.origins;
    const tables = res.arenas.tables;

    for (const pass of PASSES) {
        const draws = res.draws[pass];
        draws.length = 0;
        const table = tables[pass];
        const cpuFaceOffsets = table.cpuFaceOffsets;
        const cpuFaceCounts = table.cpuFaceCounts;
        const cpuDataCount = table.cpuDataCount;

        if (pass === 'translucent') {
            const idx = _tsortIdx;
            const dist = _tsortDist;
            idx.length = 0;
            dist.length = 0;
            for (let c = 0; c < chunks.length; c++) {
                const alloc = chunks[c]!;
                const t = alloc.translucent;
                if (!t) continue;
                const slot = t.sectionSlot;
                const n = cpuDataCount[slot]!;
                if (n === 0) continue;
                const origin = origins.get(alloc.key);
                if (!origin) continue;
                // camera-relative section center (matches the GPU cull's `rel`).
                const rx = (origin[0]! / CHUNK_SIZE - camCx) * CHUNK_SIZE + (HALF - camFracX);
                const ry = (origin[1]! / CHUNK_SIZE - camCy) * CHUNK_SIZE + (HALF - camFracY);
                const rz = (origin[2]! / CHUNK_SIZE - camCz) * CHUNK_SIZE + (HALF - camFracZ);
                const distSq = rx * rx + ry * ry + rz * rz;
                if (distSq > viewRadiusSq) continue;
                if (!frustumIn(view, rx, ry, rz)) continue;
                idx.push(c);
                dist.push(distSq);
            }
            // Insertion sort (list is small) avoids a comparator closure allocation on the hot path.
            for (let i = 1; i < idx.length; i++) {
                const di = dist[i]!;
                const ii = idx[i]!;
                let j = i - 1;
                while (j >= 0 && dist[j]! < di) {
                    dist[j + 1] = dist[j]!;
                    idx[j + 1] = idx[j]!;
                    j--;
                }
                dist[j + 1] = di;
                idx[j + 1] = ii;
            }
            for (let k = 0; k < idx.length; k++) {
                const alloc = chunks[idx[k]!]!;
                const t = alloc.translucent!;
                const slot = t.sectionSlot;
                const n = cpuDataCount[slot]!;
                stampQuadSlot(res, 'translucent', slot, t.dataStart, n);
                draws.push({ vertexCount: 6, instanceCount: n, firstVertex: 0, firstInstance: t.dataStart });
            }
        } else {
            for (let c = 0; c < chunks.length; c++) {
                const alloc = chunks[c]!;
                const a = alloc[pass];
                if (!a) continue;
                const slot = a.sectionSlot;
                const origin = origins.get(alloc.key);
                if (!origin) continue;
                const rx = (origin[0]! / CHUNK_SIZE - camCx) * CHUNK_SIZE + (HALF - camFracX);
                const ry = (origin[1]! / CHUNK_SIZE - camCy) * CHUNK_SIZE + (HALF - camFracY);
                const rz = (origin[2]! / CHUNK_SIZE - camCz) * CHUNK_SIZE + (HALF - camFracZ);
                const distSq = rx * rx + ry * ry + rz * rz;
                if (distSq > viewRadiusSq) continue;
                if (!frustumIn(view, rx, ry, rz)) continue;

                stampQuadSlot(res, pass, slot, a.dataStart, cpuDataCount[slot]!);

                const arenaBase = a.dataStart; // == section arenaBase (ChunkInfo).
                const facingBase = slot * 7;
                for (let f = 0; f < 7; f++) {
                    const cnt = cpuFaceCounts[facingBase + f]!;
                    if (cnt === 0) continue;
                    if (f < 6 && !facingVisible(rx, ry, rz, f)) continue;
                    const off = cpuFaceOffsets[facingBase + f]!;
                    draws.push({ vertexCount: 6, instanceCount: cnt, firstVertex: 0, firstInstance: arenaBase + off });
                }
            }
        }

        visuals.meshes[pass].draws = draws;
    }
}

// Upserts a mesh result into this backend's arena, or evicts if the chunk is all-air or has no geometry.
export function upsertChunk(res: VoxelResources, key: string, chunk: Chunk, mesh: ChunkMeshResult | null): void {
    const packer = res.arenas;
    if (mesh === null || chunk.nonAirCount === 0 || mesh.aabb === null) {
        if (packerHas(packer, key)) packerEvictChunk(packer, key);
        return;
    }
    packerUpsertChunk(packer, key, [chunk.wx, chunk.wy, chunk.wz], mesh);
}

// Removes a chunk from the arena and releases its light tile so light residency stays bounded by the mesh budget.
export function removeChunk(res: VoxelResources, key: string): void {
    const packer = res.arenas;
    if (packerHas(packer, key)) packerEvictChunk(packer, key);
    evictChunkLightByKey(res.lightVolume, key);
}

// Synchronously meshes a chunk (unless all-air or fully occluded) and upserts it into the arena; used by offline icon bakers instead of the worker pool.
export function remeshChunkInto(
    res: VoxelResources,
    voxels: Voxels,
    registry: Blocks,
    chunk: Chunk,
    meshOutput: MeshOutput,
): ChunkMeshResult | null {
    const mesh =
        chunk.nonAirCount === 0 || hasNoVisibleSurface(chunk)
            ? null
            : meshChunk(meshOutput, buildMeshInput(voxels, chunk.cx, chunk.cy, chunk.cz), registry);
    upsertChunk(res, chunkKey(chunk.cx, chunk.cy, chunk.cz), chunk, mesh);
    return mesh;
}

// Drains mesher results into the arena, reconciles residency against voxels/AOI eviction, and re-dirties pressure-evicted chunks to self-heal.
export function consume(res: VoxelResources, mesher: Mesher, voxels: Voxels, cameraPos: Vec3, toForget: string[]): void {
    const packer = res.arenas;
    packer.camera = cameraPos;

    // Drops stale results whose gen no longer matches chunk.meshGen (the chunk was re-dirtied since dispatch).
    if (mesher.results.length > 0) {
        const results = mesher.results;
        for (let i = 0; i < results.length; i++) {
            const result = results[i]!;
            const chunk = voxels.chunks.get(result.chunkKey);
            if (!chunk) continue;
            if (chunk.meshGen !== result.gen) continue;
            upsertChunk(res, result.chunkKey, chunk, result);
        }
        results.length = 0;
    }

    // Evict meshes for chunks the server dropped (voxel_region_del queued their keys).
    if (voxels.dirty.removed.size > 0) {
        for (const key of voxels.dirty.removed) {
            removeChunk(res, key);
            evictChunkLightByKey(res.lightVolume, key);
        }
        voxels.dirty.removed.clear();
    }

    // Evict the empty / fully-occluded chunks the AOI forgot this frame.
    for (let i = 0; i < toForget.length; i++) removeChunk(res, toForget[i]!);

    // Server discovery owns chunk membership; evict any arena-held chunk it has dropped from voxels.chunks.
    for (const key of packer.residentKeys) {
        if (!voxels.chunks.has(key)) {
            packerEvictChunk(packer, key);
            evictChunkLightByKey(res.lightVolume, key);
        }
    }

    // Self-heal: re-dirty still-present chunks lost to memory pressure so they re-mesh instead of leaving a hole.
    if (packer.evicted.size > 0) {
        for (const key of packer.evicted) {
            const chunk = voxels.chunks.get(key);
            if (chunk) markChunkDirty(voxels, chunk);
        }
        packer.evicted.clear();
    }
}

// Clears the active world from this backend's arena and mesh worker cache; voxel data survives in voxels.chunks.
export function unmountRoom(res: VoxelResources, mesher: Mesher | null): void {
    packerClearAll(res.arenas);
    // The mesh worker holds one world at a time; drop its cache and queued results.
    if (mesher !== null) resetMeshCaches(mesher);
}
