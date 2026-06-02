// ParticleVisuals — billboard-only instanced renderer for the particle pool.
//
// Material lives engine-global on `ParticleResources`. This per-room
// struct owns the geometry and per-instance buffers; they route to the
// engine-global material by name via `geometry.setBuffer(name, buf)`.
//
// The pool keeps a dense alive prefix `[0, count)`, so the draw is a
// single instanced `drawIndexed(6, pool.count, 0)` — no per-slot cull
// compute needed. `update()` sets `mesh.count = pool.count` each frame.
// Instance data lives in two storage buffers indexed by `instanceIndex`
// in the shader. Reads instance data from the per-room SoA ParticlePool
// rather than scene-graph traits. Sits next to particles.ts as a sibling
// subsystem so the pool owner stays a pure data module — no scene/Renderer
// imports leak in.

import {
    createPlaneGeometry,
    d,
    type Geometry,
    GpuBuffer,
    Mesh,
    packTo,
    type Scene,
} from 'gpucat';
import type { Vec4 } from 'mathcat';
import type { ParticleHandle, ParticlePool } from '../../core/particles/particles';
import { sampleVoxelLight } from '../../core/voxels/light';
import type { Voxels } from '../../core/voxels/voxels';
import type * as Environment from '../environment';
import type { SpriteResources } from '../sprites/sprite-resources';
import {
    INSTANCE_MATERIAL_STRIDE,
    INSTANCE_POSE_STRIDE,
    InstanceMaterial,
    InstancePose,
    type ParticleResources,
} from './particle-resources';

type GpuBufferType = GpuBuffer<any>;

// ── types ───────────────────────────────────────────────────────────

export type ParticleVisuals = {
    mesh: Mesh;
    geometry: Geometry;

    instancePoseBuf: GpuBufferType;
    instanceMaterialBuf: GpuBufferType;

    /** capacity must match the pool's capacity; pool overflow is handled
     *  at spawn time (returns -1), so this buffer never needs to grow. */
    instanceCapacity: number;

    scene: Scene;
    spriteResources: SpriteResources;
};

// ── init ────────────────────────────────────────────────────────────

/** instance capacity — must match `POOL_CAPACITY` in particles.ts. kept
 *  local rather than imported so the pool module stays free of any GPU
 *  ref; if these drift, instance buffers run short of the pool, leaving
 *  the tail invisible — caught by a single render check rather than a
 *  runtime assert. */
const INSTANCE_CAPACITY = 8192;

export function init(
    scene: Scene,
    spriteResources: SpriteResources,
    particleResources: ParticleResources,
    env: Environment.EnvironmentResources,
): ParticleVisuals {
    const instanceCapacity = INSTANCE_CAPACITY;

    const geometry = createPlaneGeometry(1, 1);

    const instancePoseBuf = new GpuBuffer(d.array(InstancePose), {
        data: new Float32Array((instanceCapacity * INSTANCE_POSE_STRIDE) / 4),
        usage: 'storage',
    });

    const instanceMaterialBuf = new GpuBuffer(d.array(InstanceMaterial), {
        data: new Float32Array((instanceCapacity * INSTANCE_MATERIAL_STRIDE) / 4),
        usage: 'storage',
    });

    // route per-room storage buffers to the engine-global material by name.
    geometry.setBuffer('instancePose', instancePoseBuf);
    geometry.setBuffer('instanceMaterial', instanceMaterialBuf);
    geometry.setBuffer('env', env.envConfigBuffer);

    const mesh = new Mesh(geometry, particleResources.material);
    mesh.name = 'particle-visuals';
    mesh.frustumCulled = false;
    // Mesh.count defaults to 1 — override so the first frame before
    // update() runs draws nothing instead of one garbage instance.
    mesh.count = 0;
    scene.add(mesh);

    return {
        mesh,
        geometry,
        instancePoseBuf,
        instanceMaterialBuf,
        instanceCapacity,
        scene,
        spriteResources,
    };
}

// ── update ──────────────────────────────────────────────────────────

/**
 * Per-frame update. Walks `pool[0..count)`, resolves the sprite frame
 * index per slot from the handle's playback mode, packs pose + material.
 *
 * No camera arg — the billboard basis is reconstructed in-shader from
 * cameraViewMatrix.
 */
const _light: Vec4 = [0, 0, 0, 0];

export function update(visuals: ParticleVisuals, pool: ParticlePool, voxels: Voxels, nowSec: number): void {
    const count = pool.count;

    // mesh.count is the instance count drawIndexed sees; gating it on
    // pool.count is the only "cull" needed since the pool is dense.
    visuals.mesh.count = count;

    if (count === 0) return;

    const poseArr = visuals.instancePoseBuf.array as Float32Array;
    const matArr = visuals.instanceMaterialBuf.array as Float32Array;
    const poseFloatStride = INSTANCE_POSE_STRIDE / 4;

    const handles = pool.handle;
    const posX = pool.posX;
    const posY = pool.posY;
    const posZ = pool.posZ;
    const size = pool.size;
    const emissive = pool.emissive;
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

        const em = emissive[i]!;
        if (em >= 1) {
            _light[0] = 0; _light[1] = 0; _light[2] = 0; _light[3] = 0;
        } else {
            sampleVoxelLight(voxels, posX[i]!, posY[i]!, posZ[i]!, _light);
        }

        packTo(InstanceMaterial, matArr, i * INSTANCE_MATERIAL_STRIDE, {
            uvRect: [resolved.u, resolved.v, resolved.w, resolved.h],
            tint: [1, 1, 1, 1],
            light: [_light[0]!, _light[1]!, _light[2]!, _light[3]!],
            emissive: em,
        });
    }

    visuals.instancePoseBuf.needsUpdate = true;
    visuals.instanceMaterialBuf.needsUpdate = true;
}

export function dispose(visuals: ParticleVisuals): void {
    visuals.scene.remove(visuals.mesh);
    visuals.geometry.dispose();
    visuals.instancePoseBuf.dispose();
    visuals.instanceMaterialBuf.dispose();
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
function resolveFrame(
    resources: SpriteResources,
    handle: ParticleHandle,
    age: number,
    lifetime: number,
): ResolvedFrame | null {
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
