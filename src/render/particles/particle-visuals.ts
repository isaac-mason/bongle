import { packTo, type Scene } from 'gpucat';
import type { ParticleHandle, ParticlePool } from '../../core/particles/particles';
import type { SpriteResources } from '../sprites/sprite-resources';
import {
    INSTANCE_MATERIAL_STRIDE,
    INSTANCE_POSE_STRIDE,
    InstanceMaterial,
    type ParticleBatch,
    resetParticleBatch,
} from './particle-resources';

export type ParticleVisuals = {
    /** this room's scene, where the client-global `batch.mesh` is added on init. */
    scene: Scene;
    /** engine-global sprite atlas ref, read per frame for frame UV resolution. */
    spriteResources: SpriteResources;
};

/**
 * Creates per-room particle visuals: readies the client-global instance batch and mounts
 * its Mesh into this room's scene. The batch (plane Mesh, per-instance buffers) is owned by
 * `ParticleResources` and survives room swaps; this room contributes only the scene anchor.
 */
export function init(batch: ParticleBatch, scene: Scene, spriteResources: SpriteResources): ParticleVisuals {
    resetParticleBatch(batch);
    scene.add(batch.mesh);
    return { scene, spriteResources };
}

/**
 * Per-frame update. Walks `pool[0..count)`, resolves the sprite frame index per slot from
 * the handle's playback mode, and packs pose + material. No camera arg, the billboard basis
 * is reconstructed in-shader from cameraViewMatrix.
 */
export function update(visuals: ParticleVisuals, batch: ParticleBatch, pool: ParticlePool, nowSec: number): void {
    const count = pool.count;

    // gating the drawn instance count on pool.count is the only "cull" needed since the
    // pool is dense.
    batch.mesh.count = count;

    if (count === 0) return;

    const poseArr = batch.instancePoseBuf.array as Float32Array;
    const matArr = batch.instanceMaterialBuf.array as Float32Array;
    const poseFloatStride = INSTANCE_POSE_STRIDE / 4;

    const handles = pool.handle;
    const posX = pool.posX;
    const posY = pool.posY;
    const posZ = pool.posZ;
    const size = pool.size;
    const glow = pool.glow;
    const tintR = pool.tintR;
    const tintG = pool.tintG;
    const tintB = pool.tintB;
    const tintA = pool.tintA;
    const spawnTime = pool.spawnTime;
    const expiresAt = pool.expiresAt;

    let resolved: ResolvedFrame | null;

    for (let i = 0; i < count; i++) {
        const handle = handles[i]!;
        resolved = resolveFrame(visuals.spriteResources, handle, nowSec - spawnTime[i]!, expiresAt[i]! - spawnTime[i]!);
        if (resolved === null) {
            poseArr[i * poseFloatStride + 3] = 0;
            poseArr[i * poseFloatStride + 7] = 0;
            continue;
        }

        const s = size[i]!;
        const w = resolved.frameW * s;
        const h = resolved.frameH * s;
        const off = i * poseFloatStride;
        poseArr[off + 0] = posX[i]!;
        poseArr[off + 1] = posY[i]!;
        poseArr[off + 2] = posZ[i]!;
        poseArr[off + 3] = w;
        poseArr[off + 7] = h;

        packTo(InstanceMaterial, matArr, i * INSTANCE_MATERIAL_STRIDE, {
            uvRect: [resolved.u, resolved.v, resolved.w, resolved.h],
            tint: [tintR[i]!, tintG[i]!, tintB[i]!, tintA[i]!],
            glow: glow[i]!,
        });
    }

    // upload only the dense [0, count) prefix, not the whole INSTANCE_CAPACITY allocation.
    batch.instancePoseBuf.addUpdateRange(0, count * poseFloatStride);
    batch.instancePoseBuf.needsUpdate = true;
    batch.instanceMaterialBuf.addUpdateRange(0, (count * INSTANCE_MATERIAL_STRIDE) / 4);
    batch.instanceMaterialBuf.needsUpdate = true;
}

/** Detaches the batch Mesh from this room's scene. Its GPU buffers are not freed, they
 *  survive for the next room's `init`. */
export function dispose(visuals: ParticleVisuals, batch: ParticleBatch): void {
    visuals.scene.remove(batch.mesh);
}

type ResolvedFrame = {
    u: number;
    v: number;
    w: number;
    h: number;
    /** sprite-frame world width (1 = atlas-default 1m quad before pool size). */
    frameW: number;
    frameH: number;
};

const _resolved: ResolvedFrame = { u: 0, v: 0, w: 0, h: 0, frameW: 1, frameH: 1 };

/** Resolves atlas UV and world dims for slot `i` from the handle's playback mode. Returns
 *  null when the sprite isn't in the atlas yet (lazy load or atlas swap mid-flight). */
function resolveFrame(resources: SpriteResources, handle: ParticleHandle, age: number, lifetime: number): ResolvedFrame | null {
    const entry = resources.frames.get(handle.def.sprite.def.spriteId);
    if (!entry) return null;

    const frames = entry.frames;
    const n = frames.length;

    let idx: number;
    if (n <= 1) {
        idx = 0;
    } else {
        switch (handle.def.playback) {
            case 'stretch': {
                if (lifetime <= 0 || !Number.isFinite(lifetime)) {
                    idx = 0;
                } else {
                    const t = age / lifetime;
                    idx = Math.min(n - 1, Math.max(0, Math.floor(t * n)));
                }
                break;
            }
            case 'loop':
                idx = ((Math.floor(age * handle.def.fps) % n) + n) % n;
                break;
            case 'once':
                idx = Math.min(n - 1, Math.max(0, Math.floor(age * handle.def.fps)));
                break;
        }
    }

    const f = frames[idx]!;
    _resolved.u = f.u;
    _resolved.v = f.v;
    _resolved.w = f.w;
    _resolved.h = f.h;
    _resolved.frameW = 1;
    _resolved.frameH = 1;
    return _resolved;
}
