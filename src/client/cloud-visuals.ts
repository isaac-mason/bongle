// cloud-visuals.ts
//
// per-room scene anchor for the engine-global cloud system. all heavy
// state (material, geometry, storage buffers, shared compacted+indirect
// output) lives on CloudResources; this is a thin wrapper that gives
// each room a Mesh in its scene plus an `update` that runs the CPU
// cull and writes into the *shared* compacted instance buffer.
//
// only the active room calls update each frame (no split-screen, no
// editor preview that renders two rooms at once), so the single shared
// output buffer always reflects the room about to draw.
//
// cull pipeline (CPU):
//   - read env config + camera; derive frustum.
//   - for each of M_CLOUD_INSTANCES slots: derive {worldPos, scale,
//     shapeId} via hash; gate on env/cluster/density; AABB-frustum
//     test.
//   - append visible slots to resources.compactedInstanceBuf; set
//     resources.indirectBuf.instanceCount = visibleCount.

import { type Camera, frustum, Mesh, type Scene } from 'gpucat';
import { type CloudResources, COMPACTED_CLOUD_INSTANCE_STRIDE } from './cloud-resources';
import { N_CLOUD_SHAPES } from './cloud-shapes';
import type * as Environment from './environment';

// ── tunables ────────────────────────────────────────────────────────

// 14 × 14 = 196 simultaneously-considered slots. matches
// CloudResources.instanceCapacity.
const GRID_DIM = 14;
// per-cell positional jitter as fraction of GRID_SPACING.
const POS_JITTER = 0.48;
// per-cell altitude jitter in world units around cloudsAltitude.
const Y_JITTER = 25;
// per-cell scale range.
const SCALE_MIN = 0.55;
const SCALE_MAX = 1.35;
// coarse cluster cells in grid units.
const CLUSTER_CELLS = 5;
// fraction of cluster regions that allow clouds at all.
const CLUSTER_PASS_THRESHOLD = 0.35;
// world units of cloud drift per second of windTime.
const WIND_SCALE = 2.5;
// radial dither fade band, in cells. clouds enter/leave the grid at
// horizontal distance ≈ (GRID_DIM/2) * gridSpacing from the camera, so
// fading to invisible just inside that boundary hides every slot swap.
// inside FADE_START_CELLS → fully solid; beyond FADE_END_CELLS → fully
// dithered out.
const FADE_START_CELLS = GRID_DIM / 2 - 2;
const FADE_END_CELLS = GRID_DIM / 2;

// grid spacing is derived per-frame from `camera.far`: we want the
// outermost ring to sit comfortably inside the far plane so the cloud
// AABBs don't clip against it.
const SAFE_FAR_FRACTION = 0.9;

// ── public type ─────────────────────────────────────────────────────

export type CloudVisuals = {
    mesh: Mesh;
    scene: Scene;
};

// ── init ────────────────────────────────────────────────────────────

export function init(scene: Scene, resources: CloudResources): CloudVisuals {
    const mesh = new Mesh(resources.geometry, resources.material);
    mesh.name = 'cloud-visuals';
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { mesh, scene };
}

// ── update ──────────────────────────────────────────────────────────

const _cpuFrustum = frustum.create();

/** WGSL `fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453)`. JS does
 *  the math in f64 which is fine — visible/culled decisions don't have
 *  to bit-exact match a GPU shader because the GPU side is gone now. */
function hash2f(x: number, y: number): number {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return v - Math.floor(v);
}

const STRIDE4 = COMPACTED_CLOUD_INSTANCE_STRIDE / 4;
const M_CLOUD_INSTANCES = GRID_DIM * GRID_DIM;

export function update(
    _visuals: CloudVisuals,
    resources: CloudResources,
    env: Environment.Environment,
    camera: Camera,
): void {
    const cfg = env.config;
    const cp = camera.position;
    const windTime = (performance.now() - resources.windStartMs) / 1000;
    const gridSpacing = (camera.far * SAFE_FAR_FRACTION) / (GRID_DIM / 2);

    // frustum planes — same math as the old WGSL cull.
    frustum.setFromViewProjectionMatrix(_cpuFrustum, camera.projectionMatrix, camera.matrixWorldInverse);

    const masterEnabled = cfg.enabled && cfg.clouds.enabled;
    const cloudsDensity = cfg.clouds.density;
    const windDirX = cfg.clouds.wind[0];
    const windDirY = cfg.clouds.wind[1];
    const cloudsAlt = cfg.clouds.altitude;

    const gridSpacingJitter = gridSpacing * POS_JITTER;
    const gridSpacingJitter2 = gridSpacingJitter * 2;
    const halfGrid = (GRID_DIM / 2) | 0;
    const fadeStart = gridSpacing * FADE_START_CELLS;
    const fadeEnd = gridSpacing * FADE_END_CELLS;

    const windOffX = windDirX * windTime * WIND_SCALE;
    const windOffZ = windDirY * windTime * WIND_SCALE;
    const nearestI = Math.floor(((cp[0] + windOffX) / gridSpacing) + 0.5);
    const nearestJ = Math.floor(((cp[2] + windOffZ) / gridSpacing) + 0.5);

    const arr = resources.compactedInstanceData;
    const arrU32 = new Uint32Array(arr.buffer, arr.byteOffset, arr.length);
    const shapes = resources.shapes;
    let count = 0;

    if (masterEnabled) {
        for (let id = 0; id < M_CLOUD_INSTANCES; id++) {
            const gridX = id % GRID_DIM;
            const gridZ = (id / GRID_DIM) | 0;
            const dx = gridX - halfGrid;
            const dz = gridZ - halfGrid;
            const cellI = nearestI + dx;
            const cellJ = nearestJ + dz;

            const clusterI = Math.floor(cellI / CLUSTER_CELLS);
            const clusterJ = Math.floor(cellJ / CLUSTER_CELLS);
            if (hash2f(clusterI, clusterJ) <= CLUSTER_PASS_THRESHOLD) continue;

            const densityHash = hash2f(cellI + 91.3, cellJ + 17.7);
            if (densityHash >= cloudsDensity) continue;

            const shapeHash = hash2f(cellI, cellJ);
            const shapeId = Math.floor(shapeHash * N_CLOUD_SHAPES);
            const shape = shapes[shapeId]!;
            if (shape.indexCount === 0) continue;

            const jitterX = hash2f(cellI + 3.7, cellJ + 1.1) * gridSpacingJitter2 - gridSpacingJitter;
            const jitterZ = hash2f(cellI + 8.3, cellJ + 4.9) * gridSpacingJitter2 - gridSpacingJitter;
            const jitterY = hash2f(cellI + 11.1, cellJ + 5.3) * (Y_JITTER * 2) - Y_JITTER;
            const scale = SCALE_MIN + hash2f(cellI + 2.2, cellJ + 7.7) * (SCALE_MAX - SCALE_MIN);

            const worldX = cellI * gridSpacing - windOffX + jitterX;
            const worldZ = cellJ * gridSpacing - windOffZ + jitterZ;
            const worldY = cloudsAlt + jitterY;

            const halfX = shape.halfExtentX * scale;
            const halfY = shape.halfExtentY * scale;
            const halfZ = shape.halfExtentZ * scale;
            const aabbMinX = worldX - halfX;
            const aabbMaxX = worldX + halfX;
            const aabbMinY = worldY;
            const aabbMaxY = worldY + halfY * 2;
            const aabbMinZ = worldZ - halfZ;
            const aabbMaxZ = worldZ + halfZ;

            if (!aabbInFrustum(aabbMinX, aabbMinY, aabbMinZ, aabbMaxX, aabbMaxY, aabbMaxZ)) continue;

            // radial fade in cells. precomputed once per instance.
            const cloudDx = worldX - cp[0];
            const cloudDz = worldZ - cp[2];
            const horizDist = Math.sqrt(cloudDx * cloudDx + cloudDz * cloudDz);
            const fadeOut = smoothstep(fadeStart, fadeEnd, horizDist);

            const o = count * STRIDE4;
            arr[o + 0] = worldX;
            arr[o + 1] = worldY;
            arr[o + 2] = worldZ;
            arr[o + 3] = scale;
            arrU32[o + 4] = shape.indexStart;
            arrU32[o + 5] = shape.indexCount;
            arr[o + 6] = fadeOut;
            count++;
        }
    }

    resources.compactedInstanceBuf.needsUpdate = true;
    // instanceCount is field index 1 of DrawIndirect (vertexCount, instanceCount, ...).
    resources.indirectData[1] = count;
    resources.indirectBuf.needsUpdate = true;
}

// ── dispose ─────────────────────────────────────────────────────────

export function dispose(visuals: CloudVisuals): void {
    visuals.scene.remove(visuals.mesh);
    // material/geometry/buffers are engine-global — owned by CloudResources.
}

// ── helpers ─────────────────────────────────────────────────────────

function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

function aabbInFrustum(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
): boolean {
    for (let i = 0; i < 6; i++) {
        const p = _cpuFrustum[i]!;
        const nx = p.normal[0];
        const ny = p.normal[1];
        const nz = p.normal[2];
        const px = nx >= 0 ? maxX : minX;
        const py = ny >= 0 ? maxY : minY;
        const pz = nz >= 0 ? maxZ : minZ;
        if (nx * px + ny * py + nz * pz + p.constant < 0) return false;
    }
    return true;
}
