// SpriteVisuals, per-room instanced renderer for SpriteTrait instances.
//
// Material lives engine-global on `SpriteResources`. This per-room struct
// owns the geometry, per-instance pose+material buffers, and a compacting
// slot allocator. Slots are dense `[0, head)`, invisible/freed slots are
// swap-popped out so the draw is a single instanced `drawIndexed(6, head, 0)`
// with no shader-side visibility gate. Buffers route to the engine-global
// material by name via `geometry.setBuffer(name, buf)`.
//
// Quad orientation is built in-shader from per-instance `flags`:
//   - 'world' (0): right/up are CPU-extracted basis vectors from the
//     trait's TransformTrait world matrix
//   - 'billboard' (1): right/up are extracted from `cameraViewMatrix`
//     (world-space camera basis via the transposed upper-3×3)
//   - 'y-billboard' (2): forward = normalize(cameraPos.xz − instPos.xz)
//     then right = cross(world-up, forward)
//
// Per-trait state lives on `SpriteTrait._state` (fast-path lookup); an
// aliveStates compact array drives stale-trait cleanup. Slots are ephemeral:
// `state.slot === -1` when the trait is hidden (frustum-culled or
// `trait.visible === false`); becoming visible re-allocates. The
// `slotOwner` parallel array lets `freeSlot` reach back into the moved
// state during swap-pop and rewrite its `state.slot`.
//
// Atlas-swap handling: `SpriteResources.refresh` rebinds the material's
// atlas TextureNode in place, no per-room work needed. The compiled
// pipeline survives across reloads.

import { type Camera, packTo, type Scene } from 'gpucat';
import type { Mat4 } from 'mathcat';
import { box3 } from 'mathcat';
import { SpriteTrait } from '../../builtins/sprite';
import { getVisualWorldMatrix, TransformTrait } from '../../builtins/transform';
import { query, type SceneTree } from '../../core/scene/scene-tree';
import { sampleVoxelLight } from '../../core/voxels/light';
import type { Voxels } from '../../core/voxels/voxels';
import * as Visibility from '../core/visibility/visibility';
import {
    CENTER_BIT,
    growSpriteBatch,
    INSTANCE_MATERIAL_STRIDE,
    INSTANCE_POSE_STRIDE,
    InstanceMaterial,
    MODE_BILLBOARD,
    MODE_WORLD,
    MODE_Y_BILLBOARD,
    resetSpriteBatch,
    type SpriteBatch,
    type SpriteEntry,
    type SpriteResources,
} from './sprite-resources';

type SpriteQuery = ReturnType<typeof query<[typeof SpriteTrait, typeof TransformTrait]>>;

function encodeFlags(mode: number, center: boolean): number {
    return mode | (center ? CENTER_BIT : 0);
}

function modeIndex(mode: 'world' | 'billboard' | 'y-billboard'): number {
    return mode === 'world' ? MODE_WORLD : mode === 'billboard' ? MODE_BILLBOARD : MODE_Y_BILLBOARD;
}

// ── types ───────────────────────────────────────────────────────────

/** Renderer-owned per-instance state stored on `SpriteTrait._state`.
 *  Created on first sight, cleared (back to null on the trait) when the
 *  trait stops appearing in the query (last-seen-frame cleanup) or when
 *  the sprite handle id changes (forces a re-install). */
export type SpriteVisualState = {
    /** index into pose/material buffers when visible; -1 when the trait
     *  is currently hidden (frustum-culled or `trait.visible === false`).
     *  Reassigned by `freeSlot`'s swap-pop. */
    slot: number;
    /** the trait that owns this state; `_state` points back to this. */
    trait: SpriteTrait;
    /** this sprite's own frustum-cull entry, registered with the shared
     *  Visibility culler at install, which writes `cull.visible` each frame. */
    cull: Visibility.CullState;
    /** sprite id observed at install, re-install on swap. */
    spriteIdAtInstall: string;
    /** entry from `SpriteResources.frames` captured at install. */
    entry: SpriteEntry;
    /** performance.now() at install, drives flipbook frame selection. */
    installedAtMs: number;
    /** frame counter of the most recent update pass that touched this
     *  state. cleanup at end of update destroys stale entries. */
    lastSeenFrame: number;
};

export type SpriteVisuals = {
    /** compact list of every active SpriteVisualState (this room's live
     *  instances + their cull entries); per-frame loop reads SpriteTrait._state
     *  directly for the fast path. Each state's `slot` indexes the batch. */
    aliveStates: SpriteVisualState[];
    /** bound to THIS room's sceneTree. */
    _query: SpriteQuery;
    frameId: number;
    /** this room's scene, where the client-global `batch.mesh` is added on init. */
    scene: Scene;
};

// ── init ────────────────────────────────────────────────────────────

/**
 * Create per-room sprite visuals: ready the client-global instance batch (reset
 * its dense head + slot ownership; buffers untouched) and mount its Mesh into
 * this room's scene. The batch — plane Mesh, per-instance buffers — is owned by
 * `SpriteResources` and survives room swaps; only this room's use of it
 * (alive-states, cull entries, scene-tree query) lives here.
 */
export function init(batch: SpriteBatch, scene: Scene, sceneTree: SceneTree): SpriteVisuals {
    resetSpriteBatch(batch);
    scene.add(batch.mesh);
    return {
        aliveStates: [],
        _query: query(sceneTree, [SpriteTrait, TransformTrait]),
        frameId: 0,
        scene,
    };
}

// ── update ──────────────────────────────────────────────────────────

const _scratchRight: [number, number, number] = [0, 0, 0];
const _scratchUp: [number, number, number] = [0, 0, 0];

/**
 * Per-frame update. Walks (SpriteTrait, TransformTrait) pairs, allocates
 * a slot on first sight (or sprite-id swap), writes pose + material every
 * frame for live slots. Stale traits (not seen this frame) are torn down
 * in the cleanup pass.
 *
 * `_camera` is accepted for parity with the previous signature; the
 * batched pipeline reads camera state in-shader via cameraViewMatrix /
 * cameraPosition, so no CPU-side camera math is needed here.
 */
export function update(
    visuals: SpriteVisuals,
    batch: SpriteBatch,
    resources: SpriteResources,
    voxels: Voxels,
    _camera: Camera,
    visibility: Visibility.Visibility,
): void {
    const frameId = ++visuals.frameId;
    const nowMs = performance.now();

    let poseArr = batch.instancePoseBuf.array as Float32Array;
    let matArr = batch.instanceMaterialBuf.array as Float32Array;

    let poseDirty = false;
    let matDirty = false;

    // ── phase 1: install/refresh state, alloc/free slots by visibility ──
    for (const [trait, transform] of visuals._query) {
        const sprite = trait.sprite;
        if (!sprite) {
            if (trait._state !== null) destroyInstance(visuals, batch, trait, visibility);
            continue;
        }

        const entry = resources.frames.get(sprite.spriteId);
        // sprite known to the trait but not yet in the atlas (asset
        // pipeline hasn't emitted it / atlas refresh mid-flight). Skip
        // and install next frame once the lookup succeeds.
        if (!entry) continue;

        let state: SpriteVisualState;
        const existing = trait._state;
        if (existing === null || existing.spriteIdAtInstall !== sprite.spriteId) {
            if (existing !== null) destroyInstance(visuals, batch, trait, visibility);
            // own frustum-cull entry. The quad can rotate freely (billboard
            // modes) so the local box is a conservative diagonal that
            // contains the quad in any orientation, in world units
            // (width/height are source pixels → × worldScale).
            const w0 = trait.width;
            const h0 = trait.height;
            const r = Math.sqrt(w0 * w0 + h0 * h0) * 0.5 * trait.worldScale;
            const cull = Visibility.add(visibility, box3.set(box3.create(), -r, -r, -r, r, r, r), transform);
            state = {
                slot: -1,
                trait,
                cull,
                spriteIdAtInstall: sprite.spriteId,
                entry,
                installedAtMs: nowMs,
                lastSeenFrame: frameId,
            };
            trait._state = state;
            visuals.aliveStates.push(state);
        } else {
            state = existing;
        }
        state.lastSeenFrame = frameId;

        const visible = state.cull.visible && trait.visible;

        if (!visible) {
            if (state.slot !== -1) {
                freeSlot(batch, state);
                poseDirty = true;
                matDirty = true;
            }
            continue;
        }

        if (state.slot === -1) {
            if (batch.head >= batch.instanceCapacity) {
                growSpriteBatch(batch, batch.instanceCapacity * 2);
                poseArr = batch.instancePoseBuf.array as Float32Array;
                matArr = batch.instanceMaterialBuf.array as Float32Array;
            }
            const slot = batch.head++;
            state.slot = slot;
            batch.slotOwner[slot] = state;
        }

        // ── pose write (per-frame) ──
        const worldMat = getVisualWorldMatrix(transform);
        extractBasis(worldMat, _scratchRight, _scratchUp);
        const worldScale = trait.worldScale;
        const w = trait.width * worldScale;
        const h = trait.height * worldScale;
        const flags = encodeFlags(modeIndex(trait.mode), trait.center);
        const poseOff = state.slot * (INSTANCE_POSE_STRIDE / 4);
        poseArr[poseOff + 0] = worldMat[12]!;
        poseArr[poseOff + 1] = worldMat[13]!;
        poseArr[poseOff + 2] = worldMat[14]!;
        poseArr[poseOff + 3] = w;
        poseArr[poseOff + 4] = _scratchRight[0];
        poseArr[poseOff + 5] = _scratchRight[1];
        poseArr[poseOff + 6] = _scratchRight[2];
        poseArr[poseOff + 7] = h;
        poseArr[poseOff + 8] = _scratchUp[0];
        poseArr[poseOff + 9] = _scratchUp[1];
        poseArr[poseOff + 10] = _scratchUp[2];
        new Uint32Array(poseArr.buffer, poseArr.byteOffset, poseArr.length)[poseOff + 11] = flags;
        poseDirty = true;

        if (!trait.unlit) {
            sampleVoxelLight(voxels, worldMat[12]!, worldMat[13]!, worldMat[14]!, trait.light);
        }

        // ── material write (per-frame; uvRect changes for flipbooks) ──
        const frameCount = state.entry.frames.length;
        const frameIdx = frameCount > 1 ? Math.floor(((nowMs - state.installedAtMs) / 1000) * trait.fps) % frameCount : 0;
        const frame = state.entry.frames[frameIdx]!;
        const tint = trait.tint;
        const flash = trait.flash;
        const light = trait.light;
        packTo(InstanceMaterial, matArr, state.slot * INSTANCE_MATERIAL_STRIDE, {
            uvRect: [frame.u, frame.v, frame.w, frame.h],
            tint: [tint[0], tint[1], tint[2], tint[3]],
            flash: [flash[0], flash[1], flash[2], flash[3]],
            light: [light[0], light[1], light[2], light[3]],
            glow: trait.glow,
            unlit: trait.unlit ? 1 : 0,
            litMin: trait.litMin,
            dither: trait.dither,
        });
        matDirty = true;
    }

    // ── phase 2: cleanup stale states (trait no longer in query) ──
    const aliveStates = visuals.aliveStates;
    for (let i = aliveStates.length - 1; i >= 0; i--) {
        const state = aliveStates[i]!;
        if (state.lastSeenFrame !== frameId) {
            destroyInstance(visuals, batch, state.trait, visibility);
            poseDirty = true;
            matDirty = true;
        }
    }

    batch.mesh.count = batch.head;

    if (poseDirty) batch.instancePoseBuf.needsUpdate = true;
    if (matDirty) batch.instanceMaterialBuf.needsUpdate = true;
}

/**
 * Dispose per-room sprite visuals: release every slot this room holds in the
 * client-global batch (swap-pop out, unregister cull, clear `trait._state`) and
 * detach the batch Mesh from this room's scene. The batch's GPU buffers are NOT
 * freed — they survive for the next room's `init`.
 */
export function dispose(visuals: SpriteVisuals, batch: SpriteBatch, visibility: Visibility.Visibility): void {
    const arr = visuals.aliveStates;
    for (let i = arr.length - 1; i >= 0; i--) destroyInstance(visuals, batch, arr[i]!.trait, visibility);
    visuals.scene.remove(batch.mesh);
}

// ── internals ───────────────────────────────────────────────────────

function destroyInstance(
    visuals: SpriteVisuals,
    batch: SpriteBatch,
    trait: SpriteTrait,
    visibility: Visibility.Visibility,
): void {
    const state = trait._state;
    if (state === null) return;

    Visibility.remove(visibility, state.cull);
    if (state.slot !== -1) freeSlot(batch, state);

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

/** Release `state.slot` via swap-pop: move the slot at `head-1` into the
 *  freed position so `[0, head)` stays dense. Copies the GPU-mirror bytes
 *  on the CPU side; caller flushes `needsUpdate` once at end of frame. */
function freeSlot(batch: SpriteBatch, state: SpriteVisualState): void {
    const s = state.slot;
    const last = --batch.head;
    if (s !== last) {
        const poseArr = batch.instancePoseBuf.array as Float32Array;
        const matArr = batch.instanceMaterialBuf.array as Float32Array;
        const poseFloats = INSTANCE_POSE_STRIDE / 4;
        const matFloats = INSTANCE_MATERIAL_STRIDE / 4;
        poseArr.copyWithin(s * poseFloats, last * poseFloats, (last + 1) * poseFloats);
        matArr.copyWithin(s * matFloats, last * matFloats, (last + 1) * matFloats);
        const moved = batch.slotOwner[last]!;
        moved.slot = s;
        batch.slotOwner[s] = moved;
    }
    batch.slotOwner[last] = null;
    state.slot = -1;
}

/** Extract normalized right (+X local) and up (+Y local) basis vectors
 *  from a column-major world matrix. */
function extractBasis(m: Mat4, rightOut: [number, number, number], upOut: [number, number, number]): void {
    const rx = m[0]!;
    const ry = m[1]!;
    const rz = m[2]!;
    const rLen = Math.hypot(rx, ry, rz) || 1;
    rightOut[0] = rx / rLen;
    rightOut[1] = ry / rLen;
    rightOut[2] = rz / rLen;
    const ux = m[4]!;
    const uy = m[5]!;
    const uz = m[6]!;
    const uLen = Math.hypot(ux, uy, uz) || 1;
    upOut[0] = ux / uLen;
    upOut[1] = uy / uLen;
    upOut[2] = uz / uLen;
}
