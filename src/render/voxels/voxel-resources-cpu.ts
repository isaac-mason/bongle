// voxel-resources-cpu.ts — WebGL-only voxel frame producer (CPU cull → mesh.draws).
//
// The WebGL counterpart of voxel-resources-gpu.ts. It builds the same substrate
// (atlas + texAnimBuffer + quad arena + mesher + per-pass geometries + materials)
// but has no compute chain: instead of the ~15-dispatch GPU cull/emit/radix-sort
// producer, `cullEmit` walks the resident sections on the CPU each frame — frustum +
// per-facing back-face cone-cull — and pushes one `mesh.draws` entry per surviving
// (section, facing) range onto the per-room voxel meshes. Static: quad bytes,
// chunkInfo, atlas; per-frame: buildCullView + the walk rebuilding three reusable
// draws arrays (+ a lazy `quadSlot` re-stamp only for sections whose arena range
// changed). No per-quad GPU upload.
//
// Value-imported ONLY by render/webgl/*. Shared voxel files may `import type` from
// here but must not value-import it (mirroring voxel-resources-gpu). The materials
// resolve `chunkInfo[quadSlot[instanceIndex]]` (createCpuQuadMaterial) — `mesh.draws`'s
// base-inclusive `firstInstance` makes `instanceIndex` the absolute arena quad id, so
// there's no per-frame slotMap and no `visibleQuads` table.

import type { Camera, Material, NonIndexedMeshDraw } from 'gpucat';
import { BufferLifecycle, d, Geometry, GpuBuffer, packTo } from 'gpucat';
import type { Vec3 } from 'mathcat';
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
import { createCpuQuadMaterial, type VoxelPass } from './voxel-material';
import {
    type BlockTextureAtlasMetadata,
    createVoxelTextures,
    loadAtlasMeta,
    loadVoxelTextures,
    type VoxelTextures,
} from './voxel-textures';
import type { VoxelVisuals } from './voxel-visuals';

// ── CPU-owned arena (residency + eviction + CPU face mirrors) ─────────
//
// This backend owns its arena end to end: the quad SegmentArena (a shared leaf
// tool), a per-pass section table carrying the CPU face mirrors + the ChunkInfo GPU
// side-table (no GPU cull metaBuffer), and the residency/eviction packer (no GPU
// cull-record buffer, no sort gate — `cullEmit` sorts translucent live each frame).
// The WebGPU producer holds the mirror image (GPU cull buffers, no CPU mirrors); the
// residency + eviction code is intentionally duplicated across the two rather than
// shared, so neither backend carries the other's buffers.

// Plain State; `sectionAllocSlot`/`sectionFreeSlot`/`sectionWriteEntry`/
// `sectionDispose` are standalone fns over it (the SegmentArena convention).
type CpuSectionTable = {
    readonly slotCount: number;
    /** ChunkInfo {origin, arenaBase}, bound as 'chunkInfo' on each pass geometry. */
    readonly buffer: GpuBuffer;
    /** u32 view over `buffer.array`, for packing/zeroing entries in place. */
    readonly dataU32: Uint32Array;
    readonly entryU32s: number;
    readonly cpuDataCount: Uint32Array; // 1 per slot (translucent slice quadCount)
    readonly cpuFaceOffsets: Uint32Array; // 7 per slot (localBase per facing)
    readonly cpuFaceCounts: Uint32Array; // 7 per slot
    /** free slot indices (LIFO); a slot is live iff it's not on the stack. */
    readonly freeStack: number[];
};

function createCpuSectionTable(slotCount: number): CpuSectionTable {
    // GPU side-table (16B/entry): origin + arenaBase. Everything cull needs
    // (faceOffsets/Counts, dataCount) lives in the CPU mirrors below; AABB lives
    // on the per-chunk ChunkAlloc. No GPU cull metaBuffer on the CPU producer.
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
    // zero CPU mirrors so a stale read can't sneak through.
    t.cpuDataCount[slot] = 0;
    const facingBase = slot * 7;
    for (let i = 0; i < 7; i++) {
        t.cpuFaceOffsets[facingBase + i] = 0;
        t.cpuFaceCounts[facingBase + i] = 0;
    }
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

// The arena is its own residency manager: the `packer*` fns below are the residency
// layer (chunk upsert/evict) over the raw slab (`quadArena`) + section tables.
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
    /** chunk keys evicted under memory pressure this frame → self-heal re-dirty. */
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

/** Swap-pop the chunk at `idx` out of `packer.chunks`; the last chunk backfills
 *  the hole (its `chunkIndex` follows). O(1). No GPU cull-record mirror on the CPU
 *  producer, so this is a plain array swap-pop. */
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
        // graceful degrade: arena full and nothing evictable → drop this pass.
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

// ── OOM eviction (evict farthest-from-camera, then retry) ────────────

/** Pick the chunk farthest from the camera to evict (excluding the one being
 *  upserted). Returns null when nothing else is resident → graceful degrade. */
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
            : Number.POSITIVE_INFINITY; // no camera (offline) → evict-first
        if (distSq > bestDistSq) {
            bestDistSq = distSq;
            bestKey = key;
        }
    }
    return bestKey;
}

/** Queue a pressure-evicted chunk to re-mesh next frame. Only the forced-eviction
 *  path records here; deliberate evicts (reconcile, clearAll) must NOT self-heal. */
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

// ── geometry (no indirect) ──────────────────────────────────────────
//
// One shared 6-vert instanced geometry per pass. The CPU material pulls the quad
// header/light from `quads[instanceIndex]` and the section origin from
// `chunkInfo[quadSlot[instanceIndex]]`, so each geometry binds only those 3
// read-only storage streams by name — and NO `geometry.indirect` (WebGL2 rejects
// it at prepare-time; the per-frame `mesh.draws` carries the draw args instead).

function createGeometries(arenas: CpuVoxelArena, quadSlot: GpuBuffer): Record<VoxelPass, Geometry> {
    const out = {} as Record<VoxelPass, Geometry>;
    for (const pass of PASSES) {
        const g = new Geometry();
        // shared quadArena bound by name, same buffer across all 3 passes.
        g.setBuffer('quads', arenas.quadArena.buffers.quads);
        // static per-quad → section-slot table (packer-filled), same buffer
        // across all 3 passes; VS reads quadSlot[instanceIndex] → slot.
        g.setBuffer('quadSlot', quadSlot);
        // ChunkInfo: per-slot {origin, arenaBase}. VS reads chunkInfo[slot].origin.
        g.setBuffer('chunkInfo', arenas.tables[pass].buffer);
        // NO g.indirect: mesh.draws (set by cullEmit) is the draw source on WebGL2.
        out[pass] = g;
    }
    return out;
}

// ── VoxelResources ───────────────────────────────────────────────────

/**
 * The WebGL voxel resource handle: atlas + arena + mesher + per-pass geometries/
 * materials (WebGL-flavored contents), plus this backend's CPU cull scratch. A flat,
 * standalone type — no shared base with the WebGPU handle, so the two are free to
 * diverge. No compute frame.
 */
export type VoxelResources = {
    /** block texture array + texture-animation metadata + atlas load lifecycle. */
    textures: VoxelTextures;
    /** unified per-pass quad materials, bound on each per-room `Mesh` alongside `geometries`. */
    quadMaterials: Record<VoxelPass, Material>;
    /** engine-global per-pass geometry (WebGL binds mesh.draws + quadSlot). */
    geometries: Record<VoxelPass, Geometry>;
    /** this backend's owned arena: quadArena + per-pass CPU section tables +
     *  residency/eviction packer. No GPU cull-record buffer / sort gate. */
    arenas: CpuVoxelArena;
    /** off-thread mesh worker pool. null on asset-pipeline paths (workerCount=0). */
    meshDispatcher: Mesher | null;

    /** per-quad → section-slot table (arena-quad-indexed, one u32 per quad slot);
     *  `buffer` is bound as 'quadSlot' on every pass geometry so the CPU material
     *  resolves `chunkInfo[quadSlot[instanceIndex]].origin`. A projection of the
     *  SectionTable owned entirely here: `cullEmit` (re)stamps a section's range
     *  when it changes (see `_stampedBase`/`_stampedCount`). The packer/arena never
     *  reference it — no backend conditional leaks into shared code. */
    quadSlot: { data: Uint32Array; buffer: GpuBuffer };
    /** per-pass, per-section-slot record of the arena range `quadSlot` was last
     *  stamped with. `cullEmit` re-stamps only when a section's `(dataStart,
     *  dataCount)` differs — the exact + self-invalidating re-stamp condition (the
     *  slot *index* is stable across chunk reuse; origin comes from `chunkInfo`
     *  fresh). Sentinel-filled so the first sighting always stamps. */
    stampedBase: Record<VoxelPass, Uint32Array>;
    stampedCount: Record<VoxelPass, Uint32Array>;
    /** per-pass reusable `mesh.draws` arrays. `cullEmit` clears + repopulates them
     *  each frame (one entry per surviving (section, facing) range) and assigns
     *  them onto the active room's per-pass voxel meshes. Allocation-free. */
    draws: Record<VoxelPass, NonIndexedMeshDraw[]>;
};

export function init(registry: Blocks, env: EnvironmentResources, budget: VoxelArenaBudget, time: TimeResources): VoxelResources {
    console.log(`[cpu-voxel-frame] init, ${registry.textures.length} textures, ${registry.totalStates} states`);

    const textures = createVoxelTextures(registry);
    const { atlas, texAnimBuffer } = textures;

    const elapsedTime = time.elapsedTime;
    const quadMaterials: Record<VoxelPass, Material> = {
        opaque: createCpuQuadMaterial({ atlas, texAnimBuffer, pass: 'opaque', elapsedTime, env }),
        transparent: createCpuQuadMaterial({ atlas, texAnimBuffer, pass: 'transparent', elapsedTime, env }),
        translucent: createCpuQuadMaterial({ atlas, texAnimBuffer, pass: 'translucent', elapsedTime, env }),
    };

    const arenas = createCpuVoxelArena(budget);

    // per-quad → section-slot table, arena-quad-sized. Owned here (not the packer);
    // `cullEmit` stamps a section's range when it changes. MANUAL lifecycle +
    // explicit Uint32Array so the per-section `.fill(slot)` bit-copies exactly.
    const quadSlotData = new Uint32Array(arenas.quadArena.slotCount);
    const quadSlotBuffer = new GpuBuffer(d.array(d.u32), {
        data: quadSlotData,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
    const quadSlot = { data: quadSlotData, buffer: quadSlotBuffer };

    // per-pass, per-section-slot last-stamped arena range; sentinel so first stamp fires.
    const mkStamp = (): Record<VoxelPass, Uint32Array> => ({
        opaque: new Uint32Array(arenas.tables.opaque.slotCount).fill(0xffffffff),
        transparent: new Uint32Array(arenas.tables.transparent.slotCount).fill(0xffffffff),
        translucent: new Uint32Array(arenas.tables.translucent.slotCount).fill(0xffffffff),
    });
    const stampedBase = mkStamp();
    const stampedCount = mkStamp();

    const geometries = createGeometries(arenas, quadSlotBuffer);

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
        stampedBase,
        stampedCount,
        draws,
        meshDispatcher: null,
    };
}

/** Async side of construction: fetches the atlas manifest, kicks off the atlas
 *  pixel upload (settles `res.textures.ready`), and spawns the mesh worker pool. No
 *  compute pipelines to compile (the WebGL producer is CPU-side). `meta` may be
 *  passed in by `refresh` (which already fetched it to compare hashes); otherwise
 *  `load` fetches it itself. Mutates `res` in place. */
export async function load(
    res: VoxelResources,
    registry: Blocks,
    workerCount: number,
    workerQueueDepth: number,
    resources: Resources,
    meta?: BlockTextureAtlasMetadata | null,
): Promise<void> {
    await loadVoxelTextures(res.textures, registry, resources.loader, meta);

    if (workerCount > 0 && typeof Worker !== 'undefined') {
        // loadMeshWorker() pulls the `?worker&inline` bundle via a dynamic import, so runtimes that
        // never spawn workers (the asset pipeline; node/happy-dom harnesses, guarded by `Worker`) never
        // resolve the Vite query and fall through to inline meshing.
        await loadMeshWorker();
        const meshDispatcher = createMesher({ workerCount, queueDepth: workerQueueDepth });
        setMeshRegistry(meshDispatcher, registry);
        res.meshDispatcher = meshDispatcher;
    }
}

/** Build new resources, or reuse `prev` if the atlas + animation metadata are
 *  unchanged (mirrors gpu-frame.refresh, minus compute). */
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
        // atlas + texAnim unchanged → reuse. The BlockRegistry itself may have
        // been rebuilt (block tables, shape ids, ...), so push the new registry to
        // the workers; in-flight jobs finish with the old registry + get
        // gen-dropped by callers.
        if (prev.meshDispatcher) setMeshRegistry(prev.meshDispatcher, registry);
        return { resources: prev, changed: false };
    }
    // Build + load the replacement BEFORE disposing `prev` (the caller keeps
    // rendering `prev` across `load`'s async gap; disposing up front would destroy
    // the GPU buffers those in-flight frames still submit against). `prev` and
    // `built` coexist for the load window; the caller re-points synchronously once
    // we return.
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
    state.textures.texAnimBuffer.dispose();
    state.quadMaterials.opaque.dispose();
    state.quadMaterials.transparent.dispose();
    state.quadMaterials.translucent.dispose();
    for (const pass of PASSES) state.geometries[pass].dispose();
    arenaDispose(state.arenas.quadArena);
    for (const pass of PASSES) sectionDispose(state.arenas.tables[pass]);
    state.quadSlot.buffer.dispose();
    if (state.meshDispatcher) disposeMesher(state.meshDispatcher);
}

// ── per-frame CPU cull → mesh.draws ─────────────────────────────────
//
// The CPU counterpart of the GPU cull → emit chain: the same frustum + distance
// test and per-facing back-face cone-cull the GPU kernels run (`createCullCompute` /
// `createEmitCompute` in voxel-resources-gpu — see those for the derivation of each
// test; keep in sync). Runs once per frame for the active room, allocation-free
// (reused draws arrays + camera-relative integer math).

const HALF = CHUNK_SIZE * 0.5;
const NEG_HALF = -CHUNK_SIZE * 0.5;

// Per-frame cull scratch, shared across rooms: `cullEmit` runs synchronously to
// completion (no await between fill and use), so one module-scope instance is safe.
// 5 camera-relative frustum planes + camMeta/camFrac (view-radius²), written by
// `buildCullView` at the top of `cullEmit`.
const _cullView = new Float32Array(CULL_VIEW_FLOATS);
// back-to-front translucent-sort scratch: resident translucent sections' packer-
// chunk indices + their squared camera-relative distances, rebuilt each frame.
const _tsortIdx: number[] = [];
const _tsortDist: number[] = [];

/** frustum plane test: `dot(plane.xyz, rel) + plane.w >= 0` for all 5 planes.
 *  Planes live at cullView[0..19] (5 × vec4), section half-extent folded into .w. */
function frustumIn(view: Float32Array, rx: number, ry: number, rz: number): boolean {
    for (let i = 0; i < 5; i++) {
        const b = i * 4;
        if (view[b]! * rx + view[b + 1]! * ry + view[b + 2]! * rz + view[b + 3]! < 0) return false;
    }
    return true;
}

/** per-facing back-face cone-cull (facings 0..5 = ±X/±Y/±Z). Matches the GPU emit
 *  (voxel-resources-gpu): `axisVal = f<2 ? rel.x : f<4 ? rel.y : rel.z; isPlus = f%2==0;
 *  visible = isPlus ? axisVal < +half : axisVal > -half`. Facing 6 (UNASSIGNED)
 *  never reaches here (the caller emits it unconditionally). */
function facingVisible(rx: number, ry: number, rz: number, f: number): boolean {
    const axisVal = f < 2 ? rx : f < 4 ? ry : rz;
    const isPlus = f % 2 === 0;
    return isPlus ? axisVal < HALF : axisVal > NEG_HALF;
}

/** Keep `quadSlot` current for one section: if its arena range `(base,count)` changed
 *  since last stamp, fill `quadSlot[base..+count] = slot` + mark the GPU updateRange.
 *  The projection that replaces the old packer-side fill — owned by the frame, keyed
 *  off facts the arena already exposes, so no backend conditional touches the packer.
 *  Called just before a section contributes draws, so only visible sections upload. */
function stampQuadSlot(res: VoxelResources, pass: VoxelPass, slot: number, base: number, count: number): void {
    if (res.stampedBase[pass][slot] === base && res.stampedCount[pass][slot] === count) return;
    res.quadSlot.data.fill(slot, base, base + count);
    res.quadSlot.buffer.addUpdateRange(base, count);
    res.stampedBase[pass][slot] = base;
    res.stampedCount[pass][slot] = count;
}

/**
 * Per-frame producer: frustum + distance cull resident sections, per-facing
 * back-face cone-cull, and push one `mesh.draws` entry per surviving (section,
 * facing) range onto `visuals.meshes[pass].draws`. Chunk-granular, no GPU upload.
 *
 * - opaque / transparent: per-facing draws (6 cardinal facings cone-culled, facing
 *   6 always emitted); any order (front-to-back would be a pure early-Z bonus).
 * - translucent: one whole-section draw per section (no facing cull — order-
 *   dependent), sections emitted back-to-front by camera distance.
 */
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
            // back-to-front: gather surviving translucent sections + distances,
            // sort far-first, then emit one whole-section draw each (no facing cull).
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
            // insertion-sort by distance DESC (far first). Translucent sections are
            // rare (water) → the list is tiny; the small-N insertion sort avoids a
            // comparator closure allocation on the hot path.
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
                // arenaBase = section dataStart; instanceIndex = arenaBase + local.
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
                    // cone-cull the 6 cardinals; facing 6 (UNASSIGNED) always emits.
                    if (f < 6 && !facingVisible(rx, ry, rz, f)) continue;
                    const off = cpuFaceOffsets[facingBase + f]!;
                    draws.push({ vertexCount: 6, instanceCount: cnt, firstVertex: 0, firstInstance: arenaBase + off });
                }
            }
        }

        visuals.meshes[pass].draws = draws;
    }
}

// ── consumption (own the arena) ─────────────────────────────────────
//
// Drain the mesher's staged results into this backend's arena, evict what the AOI
// forgot + what the server dropped, and self-heal pressure-evictions. Runs after the
// AOI has scheduled this frame's meshes and before `cullEmit` reads the arena.

/** upsert a mesh result into this backend's arena (or evict if the chunk is all-air
 *  / has no geometry). */
export function upsertChunk(res: VoxelResources, key: string, chunk: Chunk, mesh: ChunkMeshResult | null): void {
    const packer = res.arenas;
    if (mesh === null || chunk.nonAirCount === 0 || mesh.aabb === null) {
        if (packerHas(packer, key)) packerEvictChunk(packer, key);
        return;
    }
    packerUpsertChunk(packer, key, [chunk.wx, chunk.wy, chunk.wz], mesh);
}

/** remove a chunk from this backend's arena (e.g. the chunk unloaded from `voxels`). */
export function removeChunk(res: VoxelResources, key: string): void {
    const packer = res.arenas;
    if (packerHas(packer, key)) packerEvictChunk(packer, key);
}

/** Synchronously mesh a chunk (unless all-air or fully occluded) and place it in
 *  this backend's arena at its own key/origin. The main-thread path used by the
 *  offline icon bakers, which fill the arena directly instead of dispatching to the
 *  worker pool. `meshOutput` is caller-owned scratch, reused across chunks. Returns
 *  the mesh (or null when the chunk was skipped/evicted). */
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

/**
 * Drain the mesher's staged results into this backend's arena and reconcile
 * residency. Runs each frame after the AOI has scheduled dirty chunks and staged
 * `toForget`. Steps:
 *   - hand the packer the camera so eviction measures distance in world space;
 *   - drain `mesher.results` into `upsertChunk` (dropping stale-gen results);
 *   - evict the AOI-forgotten keys (`toForget`), server-dropped keys
 *     (`voxels.dirty.removed`), and any resident chunk no longer in `voxels.chunks`;
 *   - self-heal: re-dirty chunks lost to memory pressure so they re-mesh.
 */
export function consume(res: VoxelResources, mesher: Mesher, voxels: Voxels, cameraPos: Vec3, toForget: string[]): void {
    const packer = res.arenas;
    packer.camera = cameraPos;

    // drain worker results from last frame. each carries the meshGen we dispatched
    // at; chunk.meshGen has only stayed equal if nothing mutated it since, otherwise
    // drop (the chunk is back in dirty.blocks for a fresh dispatch).
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

    // evict meshes for chunks the server dropped (voxel_chunk_del queued their keys).
    if (voxels.dirty.removed.size > 0) {
        for (const key of voxels.dirty.removed) removeChunk(res, key);
        voxels.dirty.removed.clear();
    }

    // evict the empty / fully-occluded chunks the AOI forgot this frame.
    for (let i = 0; i < toForget.length; i++) removeChunk(res, toForget[i]!);

    // evict any arena-held chunk the server has dropped from voxels.chunks
    // (server discovery owns chunk membership; we just mirror it).
    for (const key of packer.residentKeys) {
        if (!voxels.chunks.has(key)) packerEvictChunk(packer, key);
    }

    // self-heal: re-dirty any chunk lost to memory pressure so it re-meshes instead
    // of leaving a hole. still-present chunks only.
    if (packer.evicted.size > 0) {
        for (const key of packer.evicted) {
            const chunk = voxels.chunks.get(key);
            if (chunk) markChunkDirty(voxels, chunk);
        }
        packer.evicted.clear();
    }
}

/** Clear the active world from this backend's arena + mesh worker cache. The voxel
 *  DATA survives (`voxels.chunks`), so a later `mountRoom` simply remeshes it. Call
 *  on a room swap or teardown (the arena/worker hold one world at a time). */
export function unmountRoom(res: VoxelResources, mesher: Mesher | null): void {
    packerClearAll(res.arenas);
    // the mesh worker holds one world at a time; drop its cache + queued results.
    if (mesher !== null) resetMeshCaches(mesher);
}
