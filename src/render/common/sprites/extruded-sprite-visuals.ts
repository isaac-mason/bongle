// ExtrudedSpriteVisuals, per-room HW-instanced renderer for
// ExtrudedSpriteTrait instances.
//
// Material + silhouette mesh pool live engine-global on
// `ExtrudedSpriteResources`. This per-room struct owns only the stable
// per-slot `instanceData`, the per-frame slotMap + drawIndexedIndirect
// array, and the alive-state bookkeeping. Pool buffers bind into our
// geometry as the HW `vertex` attribute + geometry index; per-room
// read-only storage (instanceData, slotMap) routes to the engine-global
// material by name via `geometry.setBuffer(name, buf)` (native SSBO on
// WebGPU, auto-lowered to buffer-texture reads on WebGL2). Env is the
// shared uniform captured by the material, not a per-room binding.
//
// Architecture mirrors model-visuals.ts:
//   - engine-global geometry pool (in ExtrudedSpriteResources): interleaved
//     ExtrudedVertex (vertex usage) + u32 index (index usage). Lazily
//     baked, refcounted, shared across rooms.
//   - stable per-slot `instanceData` (mat4x4f worldMatrix +
//     InstanceMaterial, uvRect / tint / flash / light / glow / unlit / litMin / dither).
//     Written every frame for visible slots; never zeroed on destroy
//     because the next allocation overwrites before use.
//   - per-frame `slotMap` (u32[]) + `mesh.draws` (MeshDraw[]) rebuilt from
//     the visible subset by bucketing each visible state by
//     `geomSlot.bucketKey`, writing the bucket's stable slots contiguously
//     into slotMap, and appending one MeshDraw covering that range. The
//     renderer loops `mesh.draws` (one instanced draw per entry) — the
//     portable replacement for WebGPU-only indirect draws.
//
// Visibility:
//   - every instance owns a frustum-cull entry on its state (`cull`, sized
//     from the bake's pixel dims × worldScale + depth*worldScale on Z),
//     registered with the room culler at alloc. Visibility frustum-culls it
//     once per frame; the per-frame loop reads `cull.visible && trait.visible`
//     and skips invisible instances, no per-slot visible flag, visibility =
//     "got included in some bucket this frame".
//
// Atlas swap invalidates every cached silhouette in the engine-global
// pool. `registry-dispatch.ts:refreshSpriteResources` calls
// `clearGeometryPool` on the pool and disposes + re-inits each room's
// ExtrudedSpriteVisuals, re-init's first frame re-acquires lazily.

import { d, Geometry, GpuBuffer, type IndexedMeshDraw, Mesh, packTo, type Scene } from 'gpucat';
import type { Mat4 } from 'mathcat';
import { box3 } from 'mathcat';
import { ExtrudedSpriteMeshTrait } from '../../../builtins/extruded-sprite';
import { getVisualWorldMatrix, TransformTrait } from '../../../builtins/transform';
import { getTrait, query, type SceneTree } from '../../../core/scene/scene-tree';
import { sampleVoxelLight } from '../../../core/voxels/light';
import type { Voxels } from '../../../core/voxels/voxels';
import * as Visibility from '../cull/visibility';
import {
    acquireGeometry,
    EXTRUDED_INSTANCE_MATERIAL_OFFSET,
    EXTRUDED_INSTANCE_STRIDE,
    ExtrudedInstance,
    type ExtrudedSpriteResources,
    type GeometrySlot,
    InstanceMaterial,
    releaseGeometry,
} from './extruded-sprite-resources';
import type { SpriteEntry } from './sprite-resources';

type ExtrudedSpriteQuery = ReturnType<typeof query<[typeof ExtrudedSpriteMeshTrait, typeof TransformTrait]>>;

type GpuBufferType = GpuBuffer<any>;

const INITIAL_INSTANCE_CAPACITY = 64;

const EXTRUDED_INSTANCE_STRIDE_F32 = EXTRUDED_INSTANCE_STRIDE / 4;

// ── slot allocator (single-slot, free-list) ─────────────────────────

type SlotAllocator = { capacity: number; head: number; freeList: number[] };

function createSlotAllocator(capacity: number): SlotAllocator {
    return { capacity, head: 0, freeList: [] };
}

function allocateOne(a: SlotAllocator): number {
    if (a.freeList.length > 0) return a.freeList.pop()!;
    if (a.head >= a.capacity) a.capacity *= 2;
    return a.head++;
}

function freeOne(a: SlotAllocator, slot: number): void {
    a.freeList.push(slot);
}

// ── per-instance state ──────────────────────────────────────────────

/** Renderer-owned per-instance state stored on `ExtrudedSpriteTrait._state`.
 *  Created on first sight, cleared (back to null on the trait) when the
 *  trait stops appearing in the query (last-seen-frame cleanup) or when
 *  the sprite handle id changes (forces a re-install). */
export type ExtrudedSpriteVisualState = {
    slot: number;
    trait: ExtrudedSpriteMeshTrait;
    /** this instance's own frustum-cull entry, registered with the shared
     *  Visibility culler at install, which writes `cull.visible` each frame. */
    cull: Visibility.CullState;
    /** sprite id observed at install, re-install on swap. */
    spriteIdAtInstall: string;
    /** entry from `SpriteResources.frames` captured at install. */
    entry: SpriteEntry;
    /** direct ref to the engine-global pool slot, feeds firstIndex /
     *  indexCount / bucketKey per frame without a map lookup. */
    geomSlot: GeometrySlot;
    /** performance.now() at install, drives flipbook frame selection. */
    installedAtMs: number;
    /** frame counter of the most recent update pass that touched this
     *  state. cleanup at end of update destroys stale entries. */
    lastSeenFrame: number;
};

export type ExtrudedSpriteVisuals = {
    mesh: Mesh;
    geometry: Geometry;

    /** stable per-slot {worldMatrix, material}; 128B/slot. Bound by name into
     *  the material; read-only, so gpucat auto-lowers the read to an rgba32uint
     *  buffer-texture fetch on WebGL2 (per-room storage buffer on both backends). */
    instanceDataBuf: GpuBufferType;

    // per-frame:
    /** u32[] sized to instanceCapacity. For each draw at [firstInstance ..
     *  firstInstance+instanceCount), slotMap[i] gives the stable slot. */
    slotMapBuf: GpuBufferType;
    /** per-frame batched draw list, one entry per visible unique sprite, shared
     *  by identity with `mesh.draws`. Rebuilt in place each frame; the renderer
     *  loops it (one instanced draw per entry). Replaces the WebGPU-only
     *  indirect-draw buffer (WebGL2 has no indirect draw). */
    draws: IndexedMeshDraw[];
    /** scratch buckets reused across frames: bucketKey → array of stable slots.
     *  arrays are emptied (length = 0) at the start of every frame; the
     *  Map itself is kept alive across frames to avoid re-allocations. */
    _bucketScratch: Map<number, number[]>;
    /** stack of empty arrays freed by stale-bucket sweeps, reused on next
     *  insert to keep allocation pressure low. */
    _freeBuckets: number[][];
    /** parallel to `_bucketScratch`, the GeometrySlot for each bucketKey
     *  this frame. Reused across frames; entries overwritten on insert. */
    _bucketSlotRef: Map<number, GeometrySlot>;

    /** capacity-tracking. instanceCapacity gates instanceDataBuf + slotMapBuf. */
    instanceCapacity: number;

    instanceAllocator: SlotAllocator;

    /** compact list of every active state; per-frame loop reads the
     *  trait's `_state` directly for the fast path. */
    aliveStates: ExtrudedSpriteVisualState[];

    _query: ExtrudedSpriteQuery;

    frameId: number;

    scene: Scene;
};

// ── init ────────────────────────────────────────────────────────────

export function init(
    scene: Scene,
    sceneTree: SceneTree,
    extrudedSpriteResources: ExtrudedSpriteResources,
): ExtrudedSpriteVisuals {
    const instanceCapacity = INITIAL_INSTANCE_CAPACITY;

    const geometry = new Geometry();

    // engine-global pool buffers, HW vertex fetch + HW indexing.
    geometry.setBuffer('vertex', extrudedSpriteResources.geometryPool.vertices);
    geometry.setIndex(extrudedSpriteResources.geometryPool.indices);

    // stable per-slot {worldMatrix, material}.
    const instanceDataBuf = new GpuBuffer(d.array(ExtrudedInstance), {
        data: new Float32Array(instanceCapacity * EXTRUDED_INSTANCE_STRIDE_F32),
        usage: 'storage',
    });

    // per-frame slotMap, CPU writes a contiguous run per bucket.
    const slotMapBuf = new GpuBuffer(d.array(d.u32), {
        data: new Uint32Array(instanceCapacity),
        usage: 'storage',
    });

    // route per-room storage into the engine-global material by name (read-only,
    // auto-lowers to buffer-texture reads on WebGL2).
    geometry.setBuffer('instanceData', instanceDataBuf);
    geometry.setBuffer('slotMap', slotMapBuf);

    // per-frame batched draw list, rebuilt in place each frame (one instanced
    // draw per visible unique sprite). Replaces the WebGPU-only indirect buffer.
    const draws: IndexedMeshDraw[] = [];

    const mesh = new Mesh(geometry, extrudedSpriteResources.material);
    mesh.name = 'extruded-sprite-visuals';
    mesh.frustumCulled = false;
    mesh.draws = draws;
    scene.add(mesh);

    return {
        mesh,
        geometry,
        instanceDataBuf,
        slotMapBuf,
        draws,
        _bucketScratch: new Map(),
        _freeBuckets: [],
        _bucketSlotRef: new Map(),
        instanceCapacity,
        instanceAllocator: createSlotAllocator(instanceCapacity),
        aliveStates: [],
        _query: query(sceneTree, [ExtrudedSpriteMeshTrait, TransformTrait]),
        frameId: 0,
        scene,
    };
}

// ── update ──────────────────────────────────────────────────────────

/**
 * Per-frame update.
 *   1. walk (ExtrudedSpriteTrait, TransformTrait): allocate/refresh state.
 *   2. cleanup stale states (last-seen frame).
 *   3. walk aliveStates: for each visible state, write transform + material
 *      into its stable slot and push its slot into a bucket keyed by
 *      `geomSlot.bucketKey`.
 *   4. walk buckets: write each bucket's slots contiguously into slotMap
 *      and emit one MeshDraw per bucket into `mesh.draws`.
 */
export function update(
    visuals: ExtrudedSpriteVisuals,
    resources: ExtrudedSpriteResources,
    voxels: Voxels,
    visibility: Visibility.Visibility,
): void {
    const frameId = ++visuals.frameId;
    const nowMs = performance.now();
    const spriteResources = resources.spriteResources;

    let instArr = visuals.instanceDataBuf.array as Float32Array;
    let instanceDataDirty = false;

    // ── phase 1: allocate / refresh states ──────────────────────────
    for (const [trait, _transform] of visuals._query) {
        const sprite = trait.sprite;
        if (!sprite) {
            if (trait._state !== null) destroyInstance(visuals, trait, resources, visibility);
            continue;
        }

        const entry = spriteResources.frames.get(sprite.spriteId);
        if (!entry) continue;

        const existing = trait._state;
        if (existing !== null && existing.spriteIdAtInstall === sprite.spriteId) {
            existing.lastSeenFrame = frameId;
            continue;
        }

        if (existing !== null) destroyInstance(visuals, trait, resources, visibility);

        const geomSlot = acquireGeometry(resources, sprite.spriteId);
        if (!geomSlot) continue;

        const slot = allocateOne(visuals.instanceAllocator);
        if (slot >= visuals.instanceCapacity) {
            growInstanceBuffers(visuals, visuals.instanceAllocator.capacity);
            instArr = visuals.instanceDataBuf.array as Float32Array;
        }

        const transform = getTrait(trait._node, TransformTrait);
        if (!transform) continue;

        // own frustum-cull box from the baked silhouette's pixel dims ×
        // per-axis scale (worldScale on x/y, depth*worldScale on z).
        const sx = trait.worldScale;
        const sy = trait.worldScale;
        const sz = trait.depth * trait.worldScale;
        const hx = geomSlot.pixelWidth * 0.5 * sx;
        const hy = geomSlot.pixelHeight * 0.5 * sy;
        const hz = 0.5 * sz;
        const cull = Visibility.add(visibility, box3.set(box3.create(), -hx, -hy, -hz, hx, hy, hz), transform);

        const state: ExtrudedSpriteVisualState = {
            slot,
            trait,
            cull,
            spriteIdAtInstall: sprite.spriteId,
            entry,
            geomSlot,
            installedAtMs: nowMs,
            lastSeenFrame: frameId,
        };
        trait._state = state;
        visuals.aliveStates.push(state);
    }

    // ── phase 2: cleanup stale states ───────────────────────────────
    const aliveStates = visuals.aliveStates;
    for (let i = aliveStates.length - 1; i >= 0; i--) {
        const state = aliveStates[i]!;
        if (state.lastSeenFrame !== frameId) destroyInstance(visuals, state.trait, resources, visibility);
    }

    // ── phase 3: per-instance writes + per-sprite bucket sort ───────
    const buckets = visuals._bucketScratch;
    const freeBuckets = visuals._freeBuckets;
    const bucketSlotRef = visuals._bucketSlotRef;
    for (const arr of buckets.values()) arr.length = 0;

    for (let i = 0; i < aliveStates.length; i++) {
        const state = aliveStates[i]!;
        const trait = state.trait;
        const visible = state.cull.visible && trait.visible;
        if (!visible) continue;

        const transformTrait = getTrait(trait._node, TransformTrait);
        if (!transformTrait) continue;

        const geomSlot = state.geomSlot;
        if (geomSlot.indexCount === 0) continue;

        const slot = state.slot;
        const slotBase = slot * EXTRUDED_INSTANCE_STRIDE_F32;

        // worldMatrix, scaled per-trait. written every frame (no
        // versioning); sprites are typically attached to moving
        // entities so the version check would rarely skip work.
        const worldMat = getVisualWorldMatrix(transformTrait);
        const sx = trait.worldScale;
        const sy = trait.worldScale;
        const sz = trait.depth * trait.worldScale;
        writeScaledMatrix(instArr, slotBase, worldMat, sx, sy, sz);

        // light sample. unlit skips the work and the material flag
        // routes around the lighting path in the shader.
        if (!trait.unlit) {
            sampleVoxelLight(voxels, worldMat[12]!, worldMat[13]!, worldMat[14]!, trait.light);
        }

        // material, flipbook frame selection + per-instance tint/light.
        const frameCount = state.entry.frames.length;
        const frameIdx = frameCount > 1 ? Math.floor(((nowMs - state.installedAtMs) / 1000) * trait.fps) % frameCount : 0;
        const frame = state.entry.frames[frameIdx]!;
        const tint = trait.tint;
        const flash = trait.flash;
        const light = trait.light;
        packTo(InstanceMaterial, instArr, slot * EXTRUDED_INSTANCE_STRIDE + EXTRUDED_INSTANCE_MATERIAL_OFFSET, {
            uvRect: [frame.u, frame.v, frame.w, frame.h],
            tint: [tint[0], tint[1], tint[2], tint[3]],
            flash: [flash[0], flash[1], flash[2], flash[3]],
            light: [light[0], light[1], light[2], light[3]],
            glow: trait.glow,
            unlit: trait.unlit ? 1 : 0,
            litMin: trait.litMin,
            dither: trait.dither,
        });
        instanceDataDirty = true;

        // ── bucket by geomSlot.bucketKey ─────────────────────────
        const key = geomSlot.bucketKey;
        let bucket = buckets.get(key);
        if (bucket === undefined) {
            bucket = freeBuckets.length > 0 ? freeBuckets.pop()! : [];
            buckets.set(key, bucket);
        }
        bucket.push(slot);
        bucketSlotRef.set(key, geomSlot);
    }

    // ── phase 4: pack slotMap + mesh.draws ──────────────────────────
    const slotMapArr = visuals.slotMapBuf.array as Uint32Array;
    const draws = visuals.draws;

    let firstInstance = 0;
    let writtenDraws = 0;
    for (const [bucketKey, slots] of buckets) {
        const len = slots.length;
        if (len === 0) {
            buckets.delete(bucketKey);
            freeBuckets.push(slots);
            bucketSlotRef.delete(bucketKey);
            continue;
        }
        const geomSlot = bucketSlotRef.get(bucketKey);
        if (!geomSlot) continue;

        // write slots into slotMap at [firstInstance .. +len).
        for (let i = 0; i < len; i++) slotMapArr[firstInstance + i] = slots[i]!;

        // one instanced indexed draw over this bucket's pooled geometry;
        // baseVertex stays 0 since pool indices are pre-rebased to absolute
        // vertex positions at upload time. Reuse the existing entry if present.
        let draw = draws[writtenDraws];
        if (draw === undefined) {
            draw = { indexCount: 0, instanceCount: 0, firstIndex: 0, firstInstance: 0 };
            draws[writtenDraws] = draw;
        }
        draw.indexCount = geomSlot.indexCount;
        draw.instanceCount = len;
        draw.firstIndex = geomSlot.indexOffset;
        draw.firstInstance = firstInstance;

        firstInstance += len;
        writtenDraws++;
    }

    // trim the reused draw array to this frame's active count.
    draws.length = writtenDraws;

    if (writtenDraws > 0) visuals.slotMapBuf.needsUpdate = true;
    if (instanceDataDirty) visuals.instanceDataBuf.needsUpdate = true;
}

export function dispose(
    visuals: ExtrudedSpriteVisuals,
    resources: ExtrudedSpriteResources,
    visibility: Visibility.Visibility,
): void {
    const arr = visuals.aliveStates;
    for (let i = arr.length - 1; i >= 0; i--) destroyInstance(visuals, arr[i]!.trait, resources, visibility);
    visuals.scene.remove(visuals.mesh);
    // engine-global pool buffers are owned by ExtrudedSpriteResources and
    // created with MANUAL lifecycle, so geometry.dispose()'s decreaseUsages()
    // is a no-op on them. Per-room buffers we own.
    visuals.geometry.dispose();
    visuals.instanceDataBuf.dispose();
    visuals.slotMapBuf.dispose();
    // `mesh.draws` is a plain array, nothing to free.
}

// ── internals ───────────────────────────────────────────────────────

function destroyInstance(
    visuals: ExtrudedSpriteVisuals,
    trait: ExtrudedSpriteMeshTrait,
    resources: ExtrudedSpriteResources,
    visibility: Visibility.Visibility,
): void {
    const state = trait._state;
    if (state === null) return;

    Visibility.remove(visibility, state.cull);
    freeOne(visuals.instanceAllocator, state.slot);
    releaseGeometry(resources, state.spriteIdAtInstall);

    const arr = visuals.aliveStates;
    const last = arr.length - 1;
    for (let i = last; i >= 0; i--) {
        if (arr[i] === state) {
            if (i !== last) arr[i] = arr[last]!;
            arr.pop();
            break;
        }
    }

    trait._state = null;
}

/** Multiply the linear basis columns of `m` by (sx, sy, sz) and write
 *  the resulting column-major mat4x4 into `out` starting at `base`.
 *  Translation column is copied verbatim. */
function writeScaledMatrix(out: Float32Array, base: number, m: Mat4, sx: number, sy: number, sz: number): void {
    out[base + 0] = m[0]! * sx;
    out[base + 1] = m[1]! * sx;
    out[base + 2] = m[2]! * sx;
    out[base + 3] = m[3]! * sx;
    out[base + 4] = m[4]! * sy;
    out[base + 5] = m[5]! * sy;
    out[base + 6] = m[6]! * sy;
    out[base + 7] = m[7]! * sy;
    out[base + 8] = m[8]! * sz;
    out[base + 9] = m[9]! * sz;
    out[base + 10] = m[10]! * sz;
    out[base + 11] = m[11]! * sz;
    out[base + 12] = m[12]!;
    out[base + 13] = m[13]!;
    out[base + 14] = m[14]!;
    out[base + 15] = m[15]!;
}

// ── buffer growth ───────────────────────────────────────────────────

// gpucat tracks buffer swaps by GpuBuffer identity; allocating a fresh
// wrapper and routing it via `geometry.setBuffer(name, newBuf)` rebuilds
// the material's bind groups against the new buffer.
function growInstanceBuffers(visuals: ExtrudedSpriteVisuals, newCapacity: number): void {
    const geometry = visuals.geometry;

    // instance data, preserve per-slot bytes (every visible slot is
    // re-written each frame anyway, but preserving keeps invisible
    // slots intact across resizes).
    {
        const oldArr = visuals.instanceDataBuf.array as Float32Array;
        const newArr = new Float32Array(newCapacity * EXTRUDED_INSTANCE_STRIDE_F32);
        newArr.set(oldArr.subarray(0, Math.min(oldArr.length, newArr.length)));
        const newBuf = new GpuBuffer(d.array(ExtrudedInstance), { data: newArr, usage: 'storage' });
        geometry.setBuffer('instanceData', newBuf);
        visuals.instanceDataBuf.dispose();
        visuals.instanceDataBuf = newBuf;
    }

    // slotMap, rebuilt every frame, no need to preserve.
    {
        const newArr = new Uint32Array(newCapacity);
        const newBuf = new GpuBuffer(d.array(d.u32), { data: newArr, usage: 'storage' });
        geometry.setBuffer('slotMap', newBuf);
        visuals.slotMapBuf.dispose();
        visuals.slotMapBuf = newBuf;
    }

    visuals.instanceCapacity = newCapacity;
}
