import { packTo, type Scene } from 'gpucat';
import type { Mat4 } from 'math';
import { box3 } from 'math/shapes';
import { ExtrudedSpriteMeshTrait } from '../../builtins/extruded-sprite';
import { getVisualWorldMatrix, TransformTrait } from '../../builtins/transform';
import { getTrait, query, type SceneTree } from '../../core/scene/scene-tree';
import * as Visibility from '../visibility/visibility';
import {
    acquireGeometry,
    allocateSlot,
    EXTRUDED_INSTANCE_MATERIAL_OFFSET,
    EXTRUDED_INSTANCE_STRIDE,
    EXTRUDED_INSTANCE_STRIDE_F32,
    type ExtrudedSpriteBatch,
    type ExtrudedSpriteResources,
    freeSlot,
    type GeometrySlot,
    growExtrudedSpriteBatch,
    InstanceMaterial,
    releaseGeometry,
    resetExtrudedSpriteBatch,
} from './extruded-sprite-resources';
import type { SpriteEntry } from './sprite-resources';

type ExtrudedSpriteQuery = ReturnType<typeof query<[typeof ExtrudedSpriteMeshTrait, typeof TransformTrait]>>;

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
    /** compact list of every active state (this room's live instances + their
     *  cull entries); per-frame loop reads the trait's `_state` directly for the
     *  fast path. Each state's `slot` indexes the client-global batch. */
    aliveStates: ExtrudedSpriteVisualState[];
    /** bound to THIS room's sceneTree. */
    _query: ExtrudedSpriteQuery;
    frameId: number;
    /** this room's scene, where the client-global `batch.mesh` is added on init. */
    scene: Scene;
};

/**
 * Create per-room extruded-sprite visuals: ready the client-global instance
 * batch (reset its allocator + scratch + draws, buffers untouched) and mount its
 * Mesh into this room's scene. The batch (Mesh, Geometry, per-slot buffers) is
 * owned by `ExtrudedSpriteResources` and survives room swaps; only this room's
 * use of it (alive-states, cull entries, scene-tree query) lives here.
 */
export function init(batch: ExtrudedSpriteBatch, scene: Scene, sceneTree: SceneTree): ExtrudedSpriteVisuals {
    resetExtrudedSpriteBatch(batch);
    scene.add(batch.mesh);
    return {
        aliveStates: [],
        _query: query(sceneTree, [ExtrudedSpriteMeshTrait, TransformTrait]),
        frameId: 0,
        scene,
    };
}

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
    batch: ExtrudedSpriteBatch,
    resources: ExtrudedSpriteResources,
    visibility: Visibility.Visibility,
): void {
    const frameId = ++visuals.frameId;
    const nowMs = performance.now();
    const spriteResources = resources.spriteResources;

    let instArr = batch.instanceDataBuf.array as Float32Array;
    // touched-slot span, widened per write and uploaded as ONE range in phase 4. slots come
    // from a free-list allocator so they can scatter; a span then re-sends a few untouched
    // slots in the middle, which is still far short of the whole capacity allocation.
    let dirtyMinSlot = Number.MAX_SAFE_INTEGER;
    let dirtyMaxSlot = -1;

    // phase 1: allocate / refresh states
    for (const [trait, _transform] of visuals._query) {
        const sprite = trait.sprite;
        if (!sprite) {
            if (trait._state !== null) destroyInstance(visuals, batch, trait, resources, visibility);
            continue;
        }

        const entry = spriteResources.frames.get(sprite.def.spriteId);
        if (!entry) continue;

        const existing = trait._state;
        if (existing !== null && existing.spriteIdAtInstall === sprite.def.spriteId) {
            existing.lastSeenFrame = frameId;
            continue;
        }

        if (existing !== null) destroyInstance(visuals, batch, trait, resources, visibility);

        const geomSlot = acquireGeometry(resources, sprite.def.spriteId);
        if (!geomSlot) continue;

        const slot = allocateSlot(batch.instanceAllocator);
        if (slot >= batch.instanceCapacity) {
            growExtrudedSpriteBatch(batch, batch.instanceAllocator.capacity);
            instArr = batch.instanceDataBuf.array as Float32Array;
        }

        const transform = getTrait(trait._node, TransformTrait);
        if (!transform) continue;

        // own frustum-cull box from the baked silhouette's pixel dims times per-axis scale (worldScale on x/y, depth*worldScale on z).
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
            spriteIdAtInstall: sprite.def.spriteId,
            entry,
            geomSlot,
            installedAtMs: nowMs,
            lastSeenFrame: frameId,
        };
        trait._state = state;
        visuals.aliveStates.push(state);
    }

    // phase 2: cleanup stale states
    const aliveStates = visuals.aliveStates;
    for (let i = aliveStates.length - 1; i >= 0; i--) {
        const state = aliveStates[i]!;
        if (state.lastSeenFrame !== frameId) destroyInstance(visuals, batch, state.trait, resources, visibility);
    }

    // phase 3: per-instance writes + per-sprite bucket sort
    const buckets = batch._bucketScratch;
    const freeBuckets = batch._freeBuckets;
    const bucketSlotRef = batch._bucketSlotRef;
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
        // material, flipbook frame selection + per-instance tint/light.
        const frameCount = state.entry.frames.length;
        const frameIdx = frameCount > 1 ? Math.floor(((nowMs - state.installedAtMs) / 1000) * trait.fps) % frameCount : 0;
        const frame = state.entry.frames[frameIdx]!;
        const tint = trait.tint;
        const flash = trait.flash;
        packTo(InstanceMaterial, instArr, slot * EXTRUDED_INSTANCE_STRIDE + EXTRUDED_INSTANCE_MATERIAL_OFFSET, {
            uvRect: [frame.u, frame.v, frame.w, frame.h],
            tint: [tint[0], tint[1], tint[2], tint[3]],
            flash: [flash[0], flash[1], flash[2], flash[3]],
            glow: trait.glow,
            unlit: trait.unlit ? 1 : 0,
            litMin: trait.litMin,
            dither: trait.dither,
        });
        if (slot < dirtyMinSlot) dirtyMinSlot = slot;
        if (slot > dirtyMaxSlot) dirtyMaxSlot = slot;

        // bucket by geomSlot.bucketKey
        const key = geomSlot.bucketKey;
        let bucket = buckets.get(key);
        if (bucket === undefined) {
            bucket = freeBuckets.length > 0 ? freeBuckets.pop()! : [];
            buckets.set(key, bucket);
        }
        bucket.push(slot);
        bucketSlotRef.set(key, geomSlot);
    }

    // phase 4: pack slotMap + mesh.draws
    const slotMapArr = batch.slotMapBuf.array as Uint32Array;
    const draws = batch.draws;

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

    // only [0, firstInstance) of slotMap was written and only that prefix is indexed by the
    // draws, so upload the prefix rather than the whole capacity-sized allocation.
    if (writtenDraws > 0) {
        batch.slotMapBuf.addUpdateRange(0, firstInstance);
        batch.slotMapBuf.needsUpdate = true;
    }
    if (dirtyMaxSlot >= 0) {
        const base = dirtyMinSlot * EXTRUDED_INSTANCE_STRIDE_F32;
        batch.instanceDataBuf.addUpdateRange(base, (dirtyMaxSlot - dirtyMinSlot + 1) * EXTRUDED_INSTANCE_STRIDE_F32);
        batch.instanceDataBuf.needsUpdate = true;
    }
}

/**
 * Dispose per-room extruded-sprite visuals: release every slot this room holds
 * in the client-global batch (frees the allocator entries, unregisters cull,
 * drops the geometry-pool refcount, clears `trait._state`) and detach the batch
 * Mesh from this room's scene. The batch's GPU buffers are not freed; they survive for the next room's `init`.
 */
export function dispose(
    visuals: ExtrudedSpriteVisuals,
    batch: ExtrudedSpriteBatch,
    resources: ExtrudedSpriteResources,
    visibility: Visibility.Visibility,
): void {
    const arr = visuals.aliveStates;
    for (let i = arr.length - 1; i >= 0; i--) destroyInstance(visuals, batch, arr[i]!.trait, resources, visibility);
    visuals.scene.remove(batch.mesh);
}

function destroyInstance(
    visuals: ExtrudedSpriteVisuals,
    batch: ExtrudedSpriteBatch,
    trait: ExtrudedSpriteMeshTrait,
    resources: ExtrudedSpriteResources,
    visibility: Visibility.Visibility,
): void {
    const state = trait._state;
    if (state === null) return;

    Visibility.remove(visibility, state.cull);
    freeSlot(batch.instanceAllocator, state.slot);
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
