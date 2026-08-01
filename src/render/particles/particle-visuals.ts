// ParticleVisuals, billboard-only instanced renderer for the particle pool.
//
// Material lives engine-global on `ParticleResources`. This per-room
// struct owns the geometry and per-instance buffers; they route to the
// engine-global material by name via `geometry.setBuffer(name, buf)`.
//
// The pool keeps a dense alive prefix `[0, count)`, so the draw is a
// single instanced `drawIndexed(6, pool.count, 0)`, no per-slot cull
// compute needed. `update()` sets `mesh.count = pool.count` each frame.
// Instance data lives in two storage buffers indexed by `instanceIndex`
// in the shader. Reads instance data from the per-room SoA ParticlePool
// rather than scene-graph traits. Sits next to particles.ts as a sibling
// subsystem so the pool owner stays a pure data module, no scene/Renderer
// imports leak in.

import { packTo, type Scene } from 'gpucat';
import type { Vec4 } from 'mathcat';
import type { ParticleHandle, ParticlePool } from '../../core/particles/particles';
import { sampleVoxelLight } from '../../core/voxels/light';
import type { Voxels } from '../../core/voxels/voxels';
import type { SpriteResources } from '../sprites/sprite-resources';
import {
    INSTANCE_MATERIAL_STRIDE,
    INSTANCE_POSE_STRIDE,
    InstanceMaterial,
    type ParticleBatch,
    resetParticleBatch,
} from './particle-resources';

// ── types ───────────────────────────────────────────────────────────

export type ParticleVisuals = {
    /** this room's scene, where the client-global `batch.mesh` is added on init. */
    scene: Scene;
    /** engine-global sprite atlas ref, read per frame for frame UV resolution. */
    spriteResources: SpriteResources;
};

// ── init ────────────────────────────────────────────────────────────

/**
 * Create per-room particle visuals: ready the client-global instance batch
 * (draw nothing until the first update; buffers untouched) and mount its Mesh
 * into this room's scene. The batch — plane Mesh, per-instance buffers — is owned
 * by `ParticleResources` and survives room swaps; this room contributes only the
 * scene anchor. `spriteResources` is the engine-global atlas ref read per frame.
 */
export function init(batch: ParticleBatch, scene: Scene, spriteResources: SpriteResources): ParticleVisuals {
    resetParticleBatch(batch);
    scene.add(batch.mesh);
    return { scene, spriteResources };
}

// ── update ──────────────────────────────────────────────────────────

/**
 * Per-frame update. Walks `pool[0..count)`, resolves the sprite frame
 * index per slot from the handle's playback mode, packs pose + material.
 *
 * No camera arg, the billboard basis is reconstructed in-shader from
 * cameraViewMatrix.
 */
const _light: Vec4 = [0, 0, 0, 0];

export function update(visuals: ParticleVisuals, batch: ParticleBatch, pool: ParticlePool, voxels: Voxels, nowSec: number): void {
    const count = pool.count;

    // mesh.count is the instance count drawIndexed sees; gating it on
    // pool.count is the only "cull" needed since the pool is dense.
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

        const glowValue = glow[i]!;
        // glow raises the light floor to `glowValue` (see shader). at >=1
        // the floor saturates, so the sampled voxel light is irrelevant,
        // skip the sample.
        if (glowValue >= 1) {
            _light[0] = 0;
            _light[1] = 0;
            _light[2] = 0;
            _light[3] = 0;
        } else {
            sampleVoxelLight(voxels, posX[i]!, posY[i]!, posZ[i]!, _light);
        }

        packTo(InstanceMaterial, matArr, i * INSTANCE_MATERIAL_STRIDE, {
            uvRect: [resolved.u, resolved.v, resolved.w, resolved.h],
            tint: [tintR[i]!, tintG[i]!, tintB[i]!, tintA[i]!],
            light: [_light[0]!, _light[1]!, _light[2]!, _light[3]!],
            glow: glowValue,
        });
    }

    batch.instancePoseBuf.needsUpdate = true;
    batch.instanceMaterialBuf.needsUpdate = true;
}

/**
 * Dispose per-room particle visuals: detach the batch Mesh from this room's
 * scene. The batch's GPU buffers are NOT freed — they survive for the next
 * room's `init`.
 */
export function dispose(visuals: ParticleVisuals, batch: ParticleBatch): void {
    visuals.scene.remove(batch.mesh);
}

// ── frame resolution ────────────────────────────────────────────────

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

/** Resolve atlas UV + world dims for slot `i` from the handle's playback
 *  mode. Returns null when the sprite isn't in the atlas yet (lazy load
 *  / atlas swap mid-flight). Single-frame sprites degenerate to "frame 0"
 *  in all modes. */
function resolveFrame(resources: SpriteResources, handle: ParticleHandle, age: number, lifetime: number): ResolvedFrame | null {
    const entry = resources.frames.get(handle.sprite.spriteId);
    if (!entry) return null;

    const frames = entry.frames;
    const n = frames.length;

    let idx: number;
    if (n <= 1) {
        idx = 0;
    } else {
        switch (handle.playback) {
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
                idx = ((Math.floor(age * handle.fps) % n) + n) % n;
                break;
            case 'once':
                idx = Math.min(n - 1, Math.max(0, Math.floor(age * handle.fps)));
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
