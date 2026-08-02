// cpu-frame.ts — WebGL-only voxel frame producer (CPU cull → mesh.draws).
//
// The WebGL twin of voxel-resources-gpu.ts. It builds the same substrate
// (atlas + texAnimBuffer + quad arena/packer + mesher + per-pass geometries +
// materials) but has NO compute chain: instead of the ~15-dispatch
// GPU cull/emit/radix-sort producer, `cullEmit` walks the resident sections on
// the CPU each frame — frustum + per-facing back-face cone-cull — and pushes one
// `mesh.draws` entry per surviving (section, facing) range onto the per-room
// voxel meshes. Static: quad bytes, chunkInfo, atlas; per-frame: buildCullView +
// the walk rebuilding three reusable draws arrays (+ a lazy `quadSlot` re-stamp
// only for sections whose arena range changed). No per-quad GPU upload.
//
// Value-imported ONLY by render/webgl/*. Shared voxel files (`common/voxels/*`)
// may `import type` from here but must not value-import it (the shared/backend
// cut mirrors gpu-frame). The materials resolve `chunkInfo[quadSlot[instanceIndex]]`
// (createCpuQuadMaterial) — `mesh.draws`'s base-inclusive `firstInstance` makes
// `instanceIndex` the absolute arena quad id, so there's no per-frame slotMap and
// no `visibleQuads` table.

import type { Camera, Material, NonIndexedMeshDraw } from 'gpucat';
import { BufferLifecycle, d, Geometry, GpuBuffer } from 'gpucat';
import type { Resources } from '../../core/resources';
import type { Blocks } from '../../core/voxels/block-registry';
import { CHUNK_SIZE } from '../../core/voxels/voxels';
import type { EnvironmentResources } from '../environment/environment';
import type { TimeResources } from '../time';
import { createMeshDispatcher, disposeMeshDispatcher, loadMeshWorker, type MeshDispatcher, setMeshRegistry } from './mesher';
import {
    arenaDispose,
    buildCullView,
    CULL_VIEW_FLOATS,
    createVoxelArena,
    PASSES,
    type VoxelArena,
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

// ── geometry (no indirect) ──────────────────────────────────────────
//
// One shared 6-vert instanced geometry per pass. The CPU material pulls the quad
// header/light from `quads[instanceIndex]` and the section origin from
// `chunkInfo[quadSlot[instanceIndex]]`, so each geometry binds only those 3
// read-only storage streams by name — and NO `geometry.indirect` (WebGL2 rejects
// it at prepare-time; the per-frame `mesh.draws` carries the draw args instead).

function createGeometries(arenas: VoxelArena, quadSlot: GpuBuffer): Record<VoxelPass, Geometry> {
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
    /** engine-global arenas (quadArena + per-pass section tables + packer). */
    arenas: VoxelArena;
    /** off-thread mesh worker pool. null on asset-pipeline paths (workerCount=0). */
    meshDispatcher: MeshDispatcher | null;

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
    /** per-frame CPU cull scratch: 5 camera-relative frustum planes + camMeta/
     *  camFrac (view-radius²), written by `buildCullView` at the top of `cullEmit`. */
    cullView: Float32Array;
    /** reusable back-to-front sort scratch for the translucent pass: resident
     *  translucent sections' packer-chunk indices + their squared camera-relative
     *  distances. Rebuilt each frame in `cullEmit`, never freed. */
    _tsortIdx: number[];
    _tsortDist: number[];
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

    const arenas = createVoxelArena(budget);

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
        cullView: new Float32Array(CULL_VIEW_FLOATS),
        _tsortIdx: [],
        _tsortDist: [],
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
        const meshDispatcher = createMeshDispatcher({ workerCount, queueDepth: workerQueueDepth });
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
    for (const pass of PASSES) state.arenas.tables[pass].dispose();
    state.arenas.packer.cullRecordsBuffer.dispose();
    state.quadSlot.buffer.dispose();
    if (state.meshDispatcher) disposeMeshDispatcher(state.meshDispatcher);
}

// ── per-frame CPU cull → mesh.draws ─────────────────────────────────
//
// The WebGL twin of the GPU cull → emit chain. Ported verbatim from gpu-frame's
// `createCullCompute` (frustum + distance) and `createEmitCompute` (per-facing
// back-face cone-cull); see those kernels for the derivation of each test. Runs
// once per frame for the active room, allocation-free (reused draws arrays +
// camera-relative integer math).

const HALF = CHUNK_SIZE * 0.5;
const NEG_HALF = -CHUNK_SIZE * 0.5;

/** frustum plane test: `dot(plane.xyz, rel) + plane.w >= 0` for all 5 planes.
 *  Planes live at cullView[0..19] (5 × vec4), section half-extent folded into .w. */
function frustumIn(view: Float32Array, rx: number, ry: number, rz: number): boolean {
    for (let i = 0; i < 5; i++) {
        const b = i * 4;
        if (view[b]! * rx + view[b + 1]! * ry + view[b + 2]! * rz + view[b + 3]! < 0) return false;
    }
    return true;
}

/** per-facing back-face cone-cull (facings 0..5 = ±X/±Y/±Z), verbatim from the
 *  GPU emit: `axisVal = f<4 ? (f<2 ? rel.x : rel.z) : rel.y; isPlus = f%2==0;
 *  visible = isPlus ? axisVal < +half : axisVal > -half`. Facing 6 (UNASSIGNED)
 *  never reaches here (the caller emits it unconditionally). */
function facingVisible(rx: number, ry: number, rz: number, f: number): boolean {
    const axisVal = f < 4 ? (f < 2 ? rx : rz) : ry;
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
    const view = res.cullView;
    buildCullView(view, camera, viewRadius);
    const camCx = view[20]!;
    const camCy = view[21]!;
    const camCz = view[22]!;
    const camFracX = view[24]!;
    const camFracY = view[25]!;
    const camFracZ = view[26]!;
    const viewRadiusSq = view[27]!;

    const packer = res.arenas.packer;
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
            const idx = res._tsortIdx;
            const dist = res._tsortDist;
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
