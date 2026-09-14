import type { Geometry } from 'gpucat';
import {
    abs,
    add,
    attribute,
    cameraFar,
    cameraPosition,
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
    smoothstep,
    sqrt,
    storage,
    struct,
    sub,
    u32,
    varying,
    vec3f,
    vec4f,
    vertexIndex,
} from 'gpucat';
import { srgbBytesToLinear } from '../../../core/color';
import type { EnvironmentResources } from '../environment';
import { buildCloudUberGeometry, type CloudShapeMeta } from './cloud-shapes';

const CLOUD_DAY: [number, number, number] = [1, 1, 1];
const CLOUD_NIGHT: [number, number, number] = [0.12, 0.14, 0.2];
// matches the sky shader's FOG_SUN_TINT.
const CLOUD_SUNSET_TINT_SRGB: [number, number, number] = [244, 125, 29];
const CLOUD_SUNSET_STRENGTH = 0.55;

const FACE_TOP = 1.0;
const FACE_BOTTOM = 0.55;
const FACE_SIDE_Z = 0.85;
const FACE_SIDE_X = 0.75;

// 14x14 simultaneously-considered slots the cull iterates per frame; visible ones get
// appended to the shared compacted instance buffer.
/** cells per side of the camera-centred cloud grid. Shared with `cloud-visuals`, which walks it. */
export const GRID_DIM = 14;
const M_CLOUD_INSTANCES = GRID_DIM * GRID_DIM;

/** the outermost ring sits this fraction inside the far plane, so cloud AABBs never clip it. */
export const SAFE_FAR_FRACTION = 0.9;
/** radial dither fade band in cells. Clouds enter and leave the grid at roughly
 *  `(GRID_DIM/2) * gridSpacing`, so fading out just inside that hides every slot swap. */
export const FADE_START_CELLS = GRID_DIM / 2 - 2;
export const FADE_END_CELLS = GRID_DIM / 2;

type GpuBufferAny = GpuBuffer<any>;

// per-visible-cloud data written by CPU cull each frame: the resolved shape index range
// and a CPU-precomputed radial fade [0..1] (1 = fully dithered out).
/** 20 B. Three loose floats rather than a `vec3f`: a vec3 member forces the struct to 16-byte
 *  alignment and pads the stride to 32, and nothing here needs that - the VS reads position as a
 *  `float32x3` vertex attribute, which only wants a 4-byte offset. */
export const CompactedCloudInstance = struct('CompactedCloudInstance', {
    worldX: d.f32,
    worldY: d.f32,
    worldZ: d.f32,
    scale: d.f32,
    /** index into the shape table; the VS looks up the index range. Carrying
     *  `indexStart`/`indexCount` per instance copied two values out of a table every instance
     *  already had to agree with. */
    shapeId: d.u32,
});
export const COMPACTED_CLOUD_INSTANCE_STRIDE = layoutStrideOf(CompactedCloudInstance);

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

    // draw submission is per-room via `mesh.draws` (see cloud-visuals): a single
    // non-indexed instanced draw whose vertexCount is fixed to maxIndexCount and whose
    // instanceCount the active room overwrites each frame.

    // positions and normals are padded to vec4 because `array<vec3f>` has 16-byte
    // element stride in WGSL std430.
    const positionsVec4 = padVec3ToVec4(positions);
    const normalsVec4 = padVec3ToVec4(normals);
    const positionStorageBuf = new GpuBuffer(d.array(d.vec4f), { data: positionsVec4, usage: 'storage' });
    const normalStorageBuf = new GpuBuffer(d.array(d.vec4f), { data: normalsVec4, usage: 'storage' });
    const indexStorageBuf = new GpuBuffer(d.array(d.u32), { data: indices, usage: 'storage' });
    // [start, count] per shape. Uploaded once; every instance references a row instead of
    // carrying a copy of one.
    const shapeTableData = new Uint32Array(shapes.length * 2);
    for (let i = 0; i < shapes.length; i++) {
        shapeTableData[i * 2] = shapes[i]!.indexStart;
        shapeTableData[i * 2 + 1] = shapes[i]!.indexCount;
    }
    const shapeTableBuf = new GpuBuffer(d.array(d.u32), { data: shapeTableData, usage: 'storage' });

    // cloudInstances is a per-instance vertex attribute; position/normal/index are
    // read-only storage (native SSBO on WebGPU, auto-lowered to buffer-texture reads on
    // WebGL2).
    geometry.setBuffer('cloudInstances', compactedInstanceBuf);
    geometry.setBuffer('positionStorage', positionStorageBuf);
    geometry.setBuffer('normalStorage', normalStorageBuf);
    geometry.setBuffer('indexStorage', indexStorageBuf);
    geometry.setBuffer('shapeTable', shapeTableBuf);

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

function createCloudMaterial(env: EnvironmentResources): Material {
    const cfg = env.cfgNode;

    // single draw with firstInstance 0, so the divisor'd attributes index the buffer
    // densely from 0. offsets: worldPos@0, scale@12, shapeId@16.
    const S = COMPACTED_CLOUD_INSTANCE_STRIDE;
    const instWorldPos = attribute('cloudInstances', d.vec3f, { instanced: true, stride: S, offset: 0 }).toVar(
        'cloudInstWorldPos',
    );
    const instScale = attribute('cloudInstances', d.f32, { instanced: true, stride: S, offset: 12 }).toVar('cloudInstScale');
    const instShapeId = attribute('cloudInstances', d.u32, { instanced: true, stride: S, offset: 16 }).toVar('cloudInstShape');

    // read-only `storage()`, so gpucat serves them as native SSBO reads on WebGPU and
    // auto-lowers them to rgba32uint buffer-texture fetches on WebGL2.
    const positions = storage('positionStorage', d.array(d.vec4f), 'read');
    const normals = storage('normalStorage', d.array(d.vec4f), 'read');
    const indices = storage('indexStorage', d.array(d.u32), 'read');
    // [start, count] per shape, uploaded once; the instance carries only which row it wants.
    const shapeTable = storage('shapeTable', d.array(d.u32), 'read');

    const shapeRow = instShapeId.mul(u32(2)).toVar('cloudShapeRow');
    const instIndexStart = shapeTable.element(shapeRow).toVar('cloudInstIdxStart');
    const instIndexCount = shapeTable.element(shapeRow.add(u32(1))).toVar('cloudInstIdxCount');

    const vid = vertexIndex.toVar('cloudVid');
    const inRange = vid.lessThan(instIndexCount).toVar('cloudInRange');

    // reads past indexCount are harmless: index storage is padded, and the vertex is
    // discarded via the clip-degenerate below.
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
    // places vertices past shape.indexCount well outside the clip volume so the triangle
    // culls entirely; indexCount is always a multiple of 3, so all three verts agree.
    const degenClip = vec4f(f32(2), f32(2), f32(2), f32(1));
    const clipPos = inRange.select(realClip, degenClip);

    // Derived, not packed: the fade is a horizontal distance from the camera, and the grid
    // spacing it is measured against comes from `camera.far` - all of which the shader has.
    // `flat` keeps it per-instance, so this stays per-instance work despite living in the VS.
    const gridSpacing = cameraFar
        .mul(f32(SAFE_FAR_FRACTION))
        .div(f32(GRID_DIM / 2))
        .toVar('cloudGridSpacing');
    const camDx = instWorldPos.x.sub(cameraPosition.x);
    const camDz = instWorldPos.z.sub(cameraPosition.z);
    const horizDist = sqrt(camDx.mul(camDx).add(camDz.mul(camDz))).toVar('cloudHorizDist');
    const fadeOut = smoothstep(gridSpacing.mul(f32(FADE_START_CELLS)), gridSpacing.mul(f32(FADE_END_CELLS)), horizDist).toVar(
        'cloudFadeOut',
    );
    const vFadeOut = varying<d.f32>(fadeOut, 'cloudFadeOutV').setInterpolation('flat');

    // matches the voxel-mesh material so clouds catch the same lighting as the world.
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

    // interleaved-gradient-noise screen-door dither; discards when fadeOut exceeds the
    // IGN threshold. fadeOut == 0 means the compare never passes (free fast path).
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
        // double-sided so a camera inside a cloud still sees the back faces draw.
        cullMode: 'none',
        depthTest: true,
        depthWrite: true,
    });
}
