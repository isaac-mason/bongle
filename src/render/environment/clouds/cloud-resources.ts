// cloud-resources.ts
//
// Engine-global cloud state. Every per-room CloudVisuals points at the
// same Material + Geometry + Mesh-fodder buffers. Only the active room
// renders per frame (no split-screen), so a single shared compacted
// instance buffer is safe: CloudVisuals.update writes it just before that
// room's draw. Draw submission is per-room (each Mesh owns its `mesh.draws`).
//
// Owns:
//   - material                  (shared shader)
//   - geometry                  (vertex-pull, no attributes)
//   - positionStorageBuf,
//     normalStorageBuf,
//     indexStorageBuf           (static uber-geometry, uploaded once)
//   - compactedInstanceBuf      (per-frame cull output, one writer)
//   - shapes, maxIndexCount     (CPU-side cull metadata)
//
// cloud drift reads the shared render clock (render/time-resources.ts) so it
// stays continuous across room switches, no per-resources time anchor needed.
//
// vertex-pull design: the geometry has no vertex attributes and no
// index buffer. The VS uses `vertexIndex` (in [0, maxIndexCount)) and
// the per-instance `indexStart`/`indexCount` from the compacted buffer
// to fetch the real vertex, then collapses any vertex past
// indexCount to a clip-space degenerate so smaller shapes draw as
// fewer triangles within the same draw call.

import type { Geometry } from 'gpucat';
import {
    abs,
    add,
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    clamp,
    cos,
    Discard,
    d,
    dot,
    Fn,
    f32,
    fract,
    fragCoord,
    GpuBuffer,
    If,
    layoutStrideOf,
    Material,
    max,
    mix,
    mul,
    normalize,
    pow,
    sin,
    storage,
    struct,
    sub,
    varying,
    vec3f,
    vec4f,
    vertexIndex,
} from 'gpucat';
import { srgbBytesToLinear } from '../../../core/color';
import { buildCloudUberGeometry, type CloudShapeMeta } from './cloud-shapes';
import type { EnvironmentResources } from '../environment';

// ── tunables ────────────────────────────────────────────────────────

// daytime + night cloud RGB.
const CLOUD_DAY: [number, number, number] = [1, 1, 1];
const CLOUD_NIGHT: [number, number, number] = [0.12, 0.14, 0.2];
// sunrise/sunset glow tint, matches the sky shader's FOG_SUN_TINT.
const CLOUD_SUNSET_TINT_SRGB: [number, number, number] = [244, 125, 29];
const CLOUD_SUNSET_STRENGTH = 0.55;

// face shading factors.
const FACE_TOP = 1.0;
const FACE_BOTTOM = 0.55;
const FACE_SIDE_Z = 0.85;
const FACE_SIDE_X = 0.75;

// 14 × 14 = 196 simultaneously-considered slots. CloudVisuals's cull
// iterates this many candidates per frame; visible ones get appended to
// the shared compacted instance buffer.
const GRID_DIM = 14;
const M_CLOUD_INSTANCES = GRID_DIM * GRID_DIM;

type GpuBufferAny = GpuBuffer<any>;

// ── gpu structs ─────────────────────────────────────────────────────

// per-visible-cloud data written by CPU cull each frame. carries the
// resolved shape index range (looked up once on CPU from shapeId) and a
// CPU-precomputed radial fade [0..1] (1 = fully dithered out).
export const CompactedCloudInstance = struct('CompactedCloudInstance', {
    worldPos: d.vec3f,
    scale: d.f32,
    indexStart: d.u32,
    indexCount: d.u32,
    fadeOut: d.f32,
});
export const COMPACTED_CLOUD_INSTANCE_STRIDE = layoutStrideOf(CompactedCloudInstance);

// ── resources ───────────────────────────────────────────────────────

export type CloudResources = {
    material: Material;
    geometry: Geometry;

    /** upper bound on visible instances per frame (== grid slot count). */
    instanceCapacity: number;

    /** per-frame: written by active room's CPU cull, read by VS. */
    compactedInstanceBuf: GpuBufferAny;
    compactedInstanceData: Float32Array;

    /** static storage buffers, uploaded once, read by VS via storage. */
    positionStorageBuf: GpuBufferAny;
    normalStorageBuf: GpuBufferAny;
    indexStorageBuf: GpuBufferAny;

    /** CPU mirror of the uber-geometry's per-shape metadata. */
    shapes: CloudShapeMeta[];
    /** fixed vertexCount for each per-room `mesh.draws` entry (every instance
     *  runs the same VS sweep; smaller shapes degenerate the tail). */
    maxIndexCount: number;
};

export function init(envResources: EnvironmentResources): CloudResources {
    const material = createCloudMaterial(envResources);
    const { geometry, shapes, positions, normals, indices, maxIndexCount } = buildCloudUberGeometry();

    const compactedInstanceData = new Float32Array((M_CLOUD_INSTANCES * COMPACTED_CLOUD_INSTANCE_STRIDE) / 4);
    const compactedInstanceBuf = new GpuBuffer(d.array(CompactedCloudInstance), {
        data: compactedInstanceData,
        usage: 'vertex',
    });

    // Draw submission is per-room via `mesh.draws` (see cloud-visuals): a
    // single non-indexed instanced draw whose vertexCount is fixed to
    // maxIndexCount and whose instanceCount the active room overwrites each
    // frame. The shared geometry carries no indirect buffer.

    // static per-vertex/per-index storage, uploaded once. positions and
    // normals are padded to vec4 because `array<vec3f>` has 16-byte
    // element stride in WGSL std430.
    const positionsVec4 = padVec3ToVec4(positions);
    const normalsVec4 = padVec3ToVec4(normals);
    const positionStorageBuf = new GpuBuffer(d.array(d.vec4f), { data: positionsVec4, usage: 'storage' });
    const normalStorageBuf = new GpuBuffer(d.array(d.vec4f), { data: normalsVec4, usage: 'storage' });
    const indexStorageBuf = new GpuBuffer(d.array(d.u32), { data: indices, usage: 'storage' });

    // route named refs once. compactedInstances is a per-instance vertex
    // attribute; position/normal/index are read-only storage (native SSBO on
    // WebGPU, auto-lowered to buffer-texture reads on WebGL2). Env is the
    // shared uniform captured by the material, not bound here.
    geometry.setBuffer('compactedInstances', compactedInstanceBuf);
    geometry.setBuffer('positionStorage', positionStorageBuf);
    geometry.setBuffer('normalStorage', normalStorageBuf);
    geometry.setBuffer('indexStorage', indexStorageBuf);

    return {
        material,
        geometry,
        instanceCapacity: M_CLOUD_INSTANCES,
        compactedInstanceBuf,
        compactedInstanceData,
        positionStorageBuf,
        normalStorageBuf,
        indexStorageBuf,
        shapes,
        maxIndexCount,
    };
}

export function dispose(resources: CloudResources): void {
    resources.material.dispose();
    resources.geometry.dispose();
    resources.compactedInstanceBuf.dispose();
    resources.positionStorageBuf.dispose();
    resources.normalStorageBuf.dispose();
    resources.indexStorageBuf.dispose();
}

// ── helpers ─────────────────────────────────────────────────────────

function padVec3ToVec4(src: Float32Array): Float32Array {
    const n = src.length / 3;
    const out = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
        out[i * 4 + 0] = src[i * 3 + 0]!;
        out[i * 4 + 1] = src[i * 3 + 1]!;
        out[i * 4 + 2] = src[i * 3 + 2]!;
    }
    return out;
}

// ── material ────────────────────────────────────────────────────────

function createCloudMaterial(env: EnvironmentResources): Material {
    const cfg = env.cfgNode;

    // per-instance data via instanced vertex attributes (both backends; the
    // per-frame CPU cull writes the `compactedInstances` buffer, usage: 'vertex').
    // single draw with firstInstance 0, so the divisor'd attributes index the
    // buffer densely from 0. std430 offsets: worldPos@0, scale@12, indexStart@16,
    // indexCount@20, fadeOut@24.
    const S = COMPACTED_CLOUD_INSTANCE_STRIDE;
    const instWorldPos = attribute('compactedInstances', d.vec3f, { instanced: true, stride: S, offset: 0 }).toVar(
        'cloudInstWorldPos',
    );
    const instScale = attribute('compactedInstances', d.f32, { instanced: true, stride: S, offset: 12 }).toVar('cloudInstScale');
    const instIndexStart = attribute('compactedInstances', d.u32, { instanced: true, stride: S, offset: 16 }).toVar(
        'cloudInstIdxStart',
    );
    const instIndexCount = attribute('compactedInstances', d.u32, { instanced: true, stride: S, offset: 20 }).toVar(
        'cloudInstIdxCount',
    );
    const instFadeOut = attribute('compactedInstances', d.f32, { instanced: true, stride: S, offset: 24 }).toVar('cloudInstFade');

    // static vertex-pull pool (arbitrary realVid reads). These are read-only
    // `storage()`, so gpucat serves them as native SSBO reads on WebGPU and
    // auto-lowers them to rgba32uint buffer-texture fetches on WebGL2 — no
    // manual data-texture conversion needed. Positions/normals are stored as
    // vec4f (w=0) since `array<vec3f>` has 16-byte element stride in WGSL.
    const positions = storage('positionStorage', d.array(d.vec4f), 'read');
    const normals = storage('normalStorage', d.array(d.vec4f), 'read');
    const indices = storage('indexStorage', d.array(d.u32), 'read');

    const vid = vertexIndex.toVar('cloudVid');
    const inRange = vid.lessThan(instIndexCount).toVar('cloudInRange');

    // pull the real vertex index for this slot; reads past indexCount
    // are harmless (index storage is padded, and we discard the vertex
    // via the clip-degenerate below).
    const realVid = indices.element(instIndexStart.add(vid)).toVar('cloudRealVid');
    const pos4 = positions.element(realVid).toVar('cloudPos4');
    const normal4 = normals.element(realVid).toVar('cloudNormal4');
    const pos = pos4.xyz.toVar('cloudPos');
    const normal = normal4.xyz.toVar('cloudNormal');

    const worldX = add(pos.x.mul(instScale), instWorldPos.x).toVar('cloudWX');
    const worldY = add(pos.y.mul(instScale), instWorldPos.y).toVar('cloudWY');
    const worldZ = add(pos.z.mul(instScale), instWorldPos.z).toVar('cloudWZ');
    const worldPos3 = vec3f(worldX, worldY, worldZ).toVar('cloudWP');

    const realClip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, vec4f(worldPos3, f32(1)))).toVar('cloudRealClip');
    // degenerate clip pos for vertices past shape.indexCount, places the
    // vertex well outside the [-w, w] clip volume so the triangle gets
    // culled entirely. since indexCount is always a multiple of 3, all
    // three verts of any past-the-end triangle take this branch together.
    const degenClip = vec4f(f32(2), f32(2), f32(2), f32(1));
    const clipPos = inRange.select(realClip, degenClip);

    // CPU-precomputed fade, flat across the instance, so we just pass
    // it through. needed per-fragment for the IGN dither below.
    const vFadeOut = varying(instFadeOut, 'cloudFadeOut').setInterpolation('flat');

    // sun direction matches the voxel-mesh material so clouds catch the
    // same lighting as the world.
    const tNode = env.timeNode.time;
    const TAU = f32(Math.PI * 2);
    const sunAngle = mul(sub(tNode, f32(0.25)), TAU);
    const sunDir = vec3f(cos(sunAngle), sin(sunAngle), f32(0));
    const sunIntensity = cfg.sunIntensity;

    const vNormal = varying(normal, 'cloudNormal');
    const vSunDir = varying(sunDir, 'cloudSunDir');
    const vSunIntensity = varying(sunIntensity, 'cloudSunIntensity');
    const vEnvT = varying(tNode, 'cloudEnvT');

    const n = normalize(vNormal).toVar('cloudN');
    const ndotl = max(dot(n, vSunDir), f32(0)).toVar('cloudNdotL');
    const sunShade = mix(sub(f32(1), vSunIntensity), f32(1), ndotl).toVar('cloudSunShade');

    const sideFactor = abs(n.x).greaterThan(f32(0.5)).select(f32(FACE_SIDE_X), f32(FACE_SIDE_Z));
    const yPosFactor = n.y.greaterThan(f32(0.5)).select(f32(FACE_TOP), sideFactor);
    const faceFactor = n.y.lessThan(f32(-0.5)).select(f32(FACE_BOTTOM), yPosFactor).toVar('cloudFaceFactor');

    const sunY = sin(mul(sub(vEnvT, f32(0.25)), TAU)).toVar('cloudSunY');
    const nightFactor = clamp(max(f32(0), sub(f32(0.3), sunY)).mul(f32(2)), f32(0), f32(1)).toVar('cloudNight');
    const dayColor = vec3f(f32(CLOUD_DAY[0]), f32(CLOUD_DAY[1]), f32(CLOUD_DAY[2]));
    const nightColor = vec3f(f32(CLOUD_NIGHT[0]), f32(CLOUD_NIGHT[1]), f32(CLOUD_NIGHT[2]));
    const baseColor = mix(dayColor, nightColor, nightFactor).toVar('cloudBaseColor');

    const sunsetTintLin = srgbBytesToLinear(CLOUD_SUNSET_TINT_SRGB[0], CLOUD_SUNSET_TINT_SRGB[1], CLOUD_SUNSET_TINT_SRGB[2]);
    const sunHorizon = pow(max(f32(0), sub(f32(1), abs(sunY).mul(f32(3)))), f32(2)).toVar('cloudSunHorizon');
    const sunsetTint = vec3f(f32(sunsetTintLin[0]), f32(sunsetTintLin[1]), f32(sunsetTintLin[2]));
    const warmedColor = mix(baseColor, sunsetTint, sunHorizon.mul(f32(CLOUD_SUNSET_STRENGTH))).toVar('cloudWarmedColor');

    const litColor = warmedColor.mul(sunShade).mul(faceFactor);

    // screen-door dither against interleaved-gradient noise. matches the
    // model material's pattern: discard when fadeOut exceeds the IGN
    // threshold. fadeOut == 0 → compare never passes (free fast path).
    const cloudFragmentDiscard = Fn(
        (color, fade, fragX, fragY) => {
            const ign = fract(mul(f32(52.9829189), fract(add(mul(f32(0.06711056), fragX), mul(f32(0.00583715), fragY))))).toVar(
                'cloudIgn',
            );
            If(fade.greaterThan(ign), () => {
                Discard();
            });
            return color;
        },
        {
            name: 'cloudFragmentDiscard',
            params: [
                { name: 'color', type: d.vec4f },
                { name: 'fade', type: d.f32 },
                { name: 'fragX', type: d.f32 },
                { name: 'fragY', type: d.f32 },
            ],
        },
    );
    const fragment = cloudFragmentDiscard(vec4f(litColor, f32(1)), vFadeOut, fragCoord.x, fragCoord.y);

    return new Material({
        name: 'clouds',
        vertex: clipPos,
        fragment,
        // double-sided: when the camera passes through a cloud the back
        // faces still draw so the volume reads as solid from inside.
        cullMode: 'none',
        depthTest: true,
        depthWrite: true,
    });
}
