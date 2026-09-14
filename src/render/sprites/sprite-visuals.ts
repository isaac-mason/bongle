import { type Camera, packTo, type Scene } from 'gpucat';
import type { Mat4 } from 'math';
import { box3 } from 'math/shapes';
import { SpriteTrait } from '../../builtins/sprite';
import { getVisualWorldMatrix, TransformTrait } from '../../builtins/transform';
import { query, type SceneTree } from '../../core/scene/scene-tree';
import * as Visibility from '../visibility/visibility';
import {
    CENTER_BIT,
    growSpriteBatch,
    INSTANCE_MATERIAL_STRIDE,
    INSTANCE_POSE_STRIDE,
    InstanceMaterial,
    MODE_BILLBOARD,
    MODE_WORLD,
    MODE_Y_BILLBOARD,
    POSE_OFFSET_F32,
    resetSpriteBatch,
    SPRITE_OCCLUSIONS,
    type SpriteBatch,
    type SpriteEntry,
    type SpriteOcclusion,
    type SpriteResources,
} from './sprite-resources';

type SpriteQuery = ReturnType<typeof query<[typeof SpriteTrait, typeof TransformTrait]>>;

// quad orientation is built in-shader from per-instance `flags`: 'world' (0) uses right/up extracted from the
// trait's TransformTrait world matrix; 'billboard' (1) extracts right/up from cameraViewMatrix (transposed
// upper-3x3 camera basis); 'y-billboard' (2) computes forward = normalize(cameraPos.xz - instPos.xz), then
// right = cross(world-up, forward).
function encodeFlags(mode: number, center: boolean): number {
    return mode | (center ? CENTER_BIT : 0);
}

function modeIndex(mode: 'world' | 'billboard' | 'y-billboard'): number {
    return mode === 'world' ? MODE_WORLD : mode === 'billboard' ? MODE_BILLBOARD : MODE_Y_BILLBOARD;
}

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
    /** which batch owns `slot`; a trait changing `occlusion` re-installs into the other one. */
    occlusion: SpriteOcclusion;
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

/**
 * Create per-room sprite visuals: ready the client-global instance batch (reset
 * its dense head + slot ownership; buffers untouched) and mount its Mesh into
 * this room's scene. The batch (plane Mesh, per-instance buffers) is owned by
 * `SpriteResources` and survives room swaps; only this room's use of it
 * (alive-states, cull entries, scene-tree query) lives here.
 */
export function init(resources: SpriteResources, scene: Scene, sceneTree: SceneTree): SpriteVisuals {
    for (const occlusion of SPRITE_OCCLUSIONS) {
        const batch = resources.batches[occlusion];
        resetSpriteBatch(batch);
        scene.add(batch.mesh);
    }
    return {
        aliveStates: [],
        _query: query(sceneTree, [SpriteTrait, TransformTrait]),
        frameId: 0,
        scene,
    };
}

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
    resources: SpriteResources,
    _camera: Camera,
    visibility: Visibility.Visibility,
): void {
    const frameId = ++visuals.frameId;
    const nowMs = performance.now();

    const dirty: Record<SpriteOcclusion, boolean> = { world: false, none: false };

    // phase 1: install/refresh state, alloc/free slots by visibility
    for (const [trait, transform] of visuals._query) {
        const sprite = trait.sprite;
        if (!sprite) {
            if (trait._state !== null) destroyInstance(visuals, resources, trait, visibility, dirty);
            continue;
        }

        const entry = resources.frames.get(sprite.def.spriteId);
        // sprite known to the trait but not yet in the atlas (asset
        // pipeline hasn't emitted it / atlas refresh mid-flight). Skip
        // and install next frame once the lookup succeeds.
        if (!entry) continue;

        let state: SpriteVisualState;
        const existing = trait._state;
        if (existing === null || existing.spriteIdAtInstall !== sprite.def.spriteId || existing.occlusion !== trait.occlusion) {
            if (existing !== null) destroyInstance(visuals, resources, trait, visibility, dirty);
            // own frustum-cull entry; the quad can rotate freely (billboard modes) so the local box is a
            // conservative diagonal that contains the quad in any orientation, in world units (width/height
            // are source pixels times worldScale).
            const w0 = trait.width;
            const h0 = trait.height;
            const r = Math.sqrt(w0 * w0 + h0 * h0) * 0.5 * trait.worldScale;
            const cull = Visibility.add(visibility, box3.set(box3.create(), -r, -r, -r, r, r, r), transform);
            state = {
                slot: -1,
                trait,
                cull,
                spriteIdAtInstall: sprite.def.spriteId,
                occlusion: trait.occlusion,
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

        const batch = resources.batches[state.occlusion];
        const visible = state.cull.visible && trait.visible;

        if (!visible) {
            if (state.slot !== -1) {
                freeSlot(batch, state);
                dirty[state.occlusion] = true;
            }
            continue;
        }

        if (state.slot === -1) {
            if (batch.head >= batch.instanceCapacity) growSpriteBatch(batch, batch.instanceCapacity * 2);
            const slot = batch.head++;
            state.slot = slot;
            batch.slotOwner[slot] = state;
        }
        const poseArr = batch.instancePoseBuf.array as Float32Array;
        const matArr = batch.instanceMaterialBuf.array as Float32Array;

        // pose write (per-frame)
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
        poseArr[poseOff + POSE_OFFSET_F32] = 0;
        poseArr[poseOff + POSE_OFFSET_F32 + 1] = 0;

        // material write (per-frame; uvRect changes for flipbooks)
        const frameCount = state.entry.frames.length;
        const frameIdx = frameCount > 1 ? Math.floor(((nowMs - state.installedAtMs) / 1000) * trait.fps) % frameCount : 0;
        const frame = state.entry.frames[frameIdx]!;
        const tint = trait.tint;
        const flash = trait.flash;
        packTo(InstanceMaterial, matArr, state.slot * INSTANCE_MATERIAL_STRIDE, {
            uvRect: [frame.u, frame.v, frame.w, frame.h],
            tint: [tint[0], tint[1], tint[2], tint[3]],
            flash: [flash[0], flash[1], flash[2], flash[3]],
            glow: trait.glow,
            unlit: trait.unlit ? 1 : 0,
            litMin: trait.litMin,
            dither: trait.dither,
        });
        dirty[state.occlusion] = true;
    }

    // phase 2: cleanup stale states (trait no longer in query)
    const aliveStates = visuals.aliveStates;
    for (let i = aliveStates.length - 1; i >= 0; i--) {
        const state = aliveStates[i]!;
        if (state.lastSeenFrame !== frameId) destroyInstance(visuals, resources, state.trait, visibility, dirty);
    }

    for (const occlusion of SPRITE_OCCLUSIONS) {
        const batch = resources.batches[occlusion];
        batch.mesh.count = batch.head;
        if (!dirty[occlusion]) continue;
        // dense [0, head) pool; upload that prefix, not the whole capacity allocation.
        batch.instancePoseBuf.addUpdateRange(0, batch.head * (INSTANCE_POSE_STRIDE / 4));
        batch.instancePoseBuf.needsUpdate = true;
        batch.instanceMaterialBuf.addUpdateRange(0, batch.head * (INSTANCE_MATERIAL_STRIDE / 4));
        batch.instanceMaterialBuf.needsUpdate = true;
    }
}

/**
 * Dispose per-room sprite visuals: release every slot this room holds in the
 * client-global batch (swap-pop out, unregister cull, clear `trait._state`) and
 * detach the batch Mesh from this room's scene. The batch's GPU buffers are not
 * freed; they survive for the next room's `init`.
 */
export function dispose(visuals: SpriteVisuals, resources: SpriteResources, visibility: Visibility.Visibility): void {
    const arr = visuals.aliveStates;
    for (let i = arr.length - 1; i >= 0; i--) destroyInstance(visuals, resources, arr[i]!.trait, visibility, null);
    for (const occlusion of SPRITE_OCCLUSIONS) visuals.scene.remove(resources.batches[occlusion].mesh);
}

function destroyInstance(
    visuals: SpriteVisuals,
    resources: SpriteResources,
    trait: SpriteTrait,
    visibility: Visibility.Visibility,
    dirty: Record<SpriteOcclusion, boolean> | null,
): void {
    const state = trait._state;
    if (state === null) return;

    Visibility.remove(visibility, state.cull);
    if (state.slot !== -1) {
        freeSlot(resources.batches[state.occlusion], state);
        if (dirty) dirty[state.occlusion] = true;
    }

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
export function freeSlot(batch: SpriteBatch, state: { slot: number }): void {
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
