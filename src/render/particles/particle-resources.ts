// ParticleResources, engine-global particle material.
//
// One instance per `EngineClient`, shared across rooms. The atlas Texture
// is owned by `SpriteResources`, this struct holds a TextureNode bound at
// build time and exposes `rebindAtlas()` so the registry-dispatch atlas
// swap can retarget it without rebuilding the compiled pipeline.
//
// Material binds per-instance + env buffers by name (`instancePose`,
// `instanceMaterial`, `env`). Each per-room ParticleVisuals routes its
// buffers to those names via `geometry.setBuffer(name, buf)` and sets
// `mesh.count = pool.count` each frame to drive instanced draw.

import {
    add,
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    cos,
    createPlaneGeometry,
    d,
    f32,
    type Geometry,
    GpuBuffer,
    layoutStrideOf,
    Material,
    Mesh,
    max,
    mix,
    mul,
    sin,
    smoothstep,
    struct,
    sub,
    type Texture,
    texture,
    u32,
    varying,
    vec2f,
    vec3f,
    vec4f,
} from 'gpucat';
import type { TextureNode } from 'gpucat/dist/nodes/nodes';
import { ditherDiscard } from '../dsl/dither';
import type { EnvironmentResources } from '../environment/environment';

// ── shared gpu structs ──────────────────────────────────────────────
//
// Exported so per-room ParticleVisuals can pack into the matching layout.

export const InstancePose = struct('ParticleInstancePose', {
    posWorld: d.vec3f,
    width: d.f32,
    _pad0: d.vec3f,
    height: d.f32,
});

export const InstanceMaterial = struct('ParticleInstanceMaterial', {
    uvRect: d.vec4f,
    tint: d.vec4f,
    light: d.vec4f,
    glow: d.f32,
});

export const INSTANCE_POSE_STRIDE = layoutStrideOf(InstancePose);
export const INSTANCE_MATERIAL_STRIDE = layoutStrideOf(InstanceMaterial);

// sky-brightness curve, must match voxel-material + voxel-mesh-visuals
// so particles shade the same as the world they hang in.
const NIGHT_SKY_BRIGHTNESS = 0.05;
const DAY_SKY_BRIGHTNESS = 0.9;
const DISABLED_SKY_BRIGHTNESS = 1.0;

// ── instance batch (client-global, persistent GPU allocation) ───────
// The plane geometry + per-instance pose/material buffers + their Mesh live
// here, NOT on per-room visuals. One room renders at a time, so a room swap
// REUSES this allocation (reset `mesh.count` + re-add the Mesh) instead of
// freeing + reallocating it. The pool is dense `[0, count)`, drawn as a single
// `drawIndexed(6, count, 0)`; capacity is fixed (no grow).

/** instance capacity, must match `POOL_CAPACITY` in particles.ts. kept here
 *  rather than imported so the pool module stays free of any GPU ref; if these
 *  drift, instance buffers run short of the pool, leaving the tail invisible,
 *  caught by a single render check rather than a runtime assert. */
const INSTANCE_CAPACITY = 8192;

type GpuBufferType = GpuBuffer<any>;

export type ParticleBatch = {
    /** one Mesh(plane, material); added to the active room's scene on `init`,
     *  removed on `dispose`. Never disposed on a room swap. `mesh.count = pool.count`. */
    mesh: Mesh;
    geometry: Geometry;
    instancePoseBuf: GpuBufferType;
    instanceMaterialBuf: GpuBufferType;
    /** matches the pool capacity; pool overflow is handled at spawn time, so
     *  this buffer never grows. */
    instanceCapacity: number;
};

/** Build the client-global instance batch: a shared 1×1 plane with per-instance
 *  pose/material vertex buffers, wrapped in a Mesh with the engine-global
 *  material. Not added to any scene until a room `init`s. */
function createParticleBatch(material: Material): ParticleBatch {
    const instanceCapacity = INSTANCE_CAPACITY;

    const geometry = createPlaneGeometry(1, 1);

    const instancePoseBuf = new GpuBuffer(d.array(InstancePose), {
        data: new Float32Array((instanceCapacity * INSTANCE_POSE_STRIDE) / 4),
        usage: 'vertex',
    });
    const instanceMaterialBuf = new GpuBuffer(d.array(InstanceMaterial), {
        data: new Float32Array((instanceCapacity * INSTANCE_MATERIAL_STRIDE) / 4),
        usage: 'vertex',
    });
    geometry.setBuffer('instancePose', instancePoseBuf);
    geometry.setBuffer('instanceMaterial', instanceMaterialBuf);

    const mesh = new Mesh(geometry, material);
    mesh.name = 'particle-visuals';
    mesh.frustumCulled = false;
    mesh.count = 0;

    return { mesh, geometry, instancePoseBuf, instanceMaterialBuf, instanceCapacity };
}

/** Ready the batch for a fresh room: draw nothing until the first update refills
 *  it from the new room's pool. Buffers are NOT touched. */
export function resetParticleBatch(batch: ParticleBatch): void {
    batch.mesh.count = 0;
}

function disposeParticleBatch(batch: ParticleBatch): void {
    // Called once at client shutdown, never on room swap.
    batch.geometry.dispose();
    batch.instancePoseBuf.dispose();
    batch.instanceMaterialBuf.dispose();
}

// ── public type ─────────────────────────────────────────────────────

export type ParticleResources = {
    /** engine-global particle material, binds per-instance + env buffers
     *  by name. The atlas Texture is bound via `atlasTexNode`; atlas
     *  swaps rebind that node without rebuilding the material. */
    material: Material;
    /** atlas TextureNode owned by `material`. Retargeted by
     *  `rebindAtlas()` when SpriteResources swaps its atlas. */
    atlasTexNode: TextureNode;
    /** client-global instance batch (plane Mesh + per-instance buffers).
     *  Reused across room swaps; per-room `ParticleVisuals` drive it. */
    batch: ParticleBatch;
};

// ── public api ──────────────────────────────────────────────────────

export function init(atlas: Texture, env: EnvironmentResources): ParticleResources {
    const { material, atlasTexNode } = createParticleMaterial(atlas, env);
    const batch = createParticleBatch(material);
    return { material, atlasTexNode, batch };
}

/** Retarget the material's atlas TextureNode at a freshly-allocated
 *  atlas. Called from registry-dispatch after SpriteResources swaps. */
export function rebindAtlas(res: ParticleResources, atlas: Texture): void {
    res.atlasTexNode.bindingNode.value = atlas._gpuTexture;
    res.atlasTexNode.samplerNode!.value = atlas._gpuSampler;
}

export function dispose(res: ParticleResources): void {
    disposeParticleBatch(res.batch);
    res.material.dispose();
}

// ── internals ───────────────────────────────────────────────────────

function createParticleMaterial(atlas: Texture, env: EnvironmentResources): { material: Material; atlasTexNode: TextureNode } {
    const aPosition = attribute('position', d.vec3f);
    const aUv = attribute('uv', d.vec2f);

    // per-instance pose + material via instanced vertex attributes (both backends;
    // the per-room ParticleVisuals provides the `instancePose`/`instanceMaterial`
    // buffers by name, usage: 'vertex'). single dense draw, so instanceIndex indexes
    // the buffers directly. std430 field offsets below.
    const posWorld = attribute('instancePose', d.vec3f, { instanced: true, stride: INSTANCE_POSE_STRIDE, offset: 0 }).toVar(
        'pvPos',
    );
    const width = attribute('instancePose', d.f32, { instanced: true, stride: INSTANCE_POSE_STRIDE, offset: 12 }).toVar('pvW');
    const height = attribute('instancePose', d.f32, { instanced: true, stride: INSTANCE_POSE_STRIDE, offset: 28 }).toVar('pvH');

    // billboard basis from cameraViewMatrix.
    const view = cameraViewMatrix;
    const viewCol0 = view.element(u32(0)).toVar('pvViewCol0');
    const viewCol1 = view.element(u32(1)).toVar('pvViewCol1');
    const viewCol2 = view.element(u32(2)).toVar('pvViewCol2');
    const right = vec3f(viewCol0.x, viewCol1.x, viewCol2.x).toVar('pvRight');
    const up = vec3f(viewCol0.y, viewCol1.y, viewCol2.y).toVar('pvUp');

    // centered quad: aPosition in [-0.5..0.5] × width/height.
    const localX = mul(aPosition.x, width).toVar('pvLocalX');
    const localY = mul(aPosition.y, height).toVar('pvLocalY');

    const worldPos3 = add(posWorld, add(mul(right, localX), mul(up, localY))).toVar('pvWorldPos');
    const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, vec4f(worldPos3, f32(1)))).toVar('pvClipPos');

    const S = INSTANCE_MATERIAL_STRIDE;
    const uvRect = attribute('instanceMaterial', d.vec4f, { instanced: true, stride: S, offset: 0 }).toVar('pvUvRect');
    const tint = attribute('instanceMaterial', d.vec4f, { instanced: true, stride: S, offset: 16 }).toVar('pvTint');
    const instLight = attribute('instanceMaterial', d.vec4f, { instanced: true, stride: S, offset: 32 }).toVar('pvInstLight');
    const glow = attribute('instanceMaterial', d.f32, { instanced: true, stride: S, offset: 48 }).toVar('pvGlow');

    const sampledU = add(uvRect.x, mul(aUv.x, uvRect.z)).toVar('pvSampledU');
    const sampledV = add(uvRect.y, mul(aUv.y, uvRect.w)).toVar('pvSampledV');
    const sampledUv = vec2f(sampledU, sampledV).toVar('pvSampledUv');

    const vUv = varying(sampledUv, 'pvUv').setInterpolation('perspective', 'centroid');
    const vTint = varying(tint, 'pvTintV').setInterpolation('flat');
    const vInstLight = varying(instLight, 'pvInstLightV').setInterpolation('flat');
    const vGlow = varying(glow, 'pvGlowV').setInterpolation('flat');

    const cfg = env.cfgNode;
    const TAU = f32(Math.PI * 2).toVar('pvTau');
    const sunAngle = mul(sub(env.timeNode.time, f32(0.25)), TAU).toVar('pvSunAngle');
    const sunDirection = vec3f(cos(sunAngle), sin(sunAngle), f32(0)).toVar('pvSunDir');
    const sunY = sunDirection.y.toVar('pvSunY');
    const dayCurve = smoothstep(f32(-0.1), f32(0.15), sunY).toVar('pvDayCurve');
    const skyBrightnessActive = mix(f32(NIGHT_SKY_BRIGHTNESS), f32(DAY_SKY_BRIGHTNESS), dayCurve).toVar('pvSkyActive');
    const enabledMask = cfg.enabled.toF32().toVar('pvEnabledMask');
    const skyBrightness = mix(f32(DISABLED_SKY_BRIGHTNESS), skyBrightnessActive, enabledMask).toVar('pvSkyBrightness');

    const atlasTexNode = texture(atlas);
    const sampled = atlasTexNode.sample(vUv).toVar('pvSampled');

    const skySkyScalar = mul(vInstLight.x, skyBrightness).toVar('pvSkySkyScalar');
    const skyContribParticle = vec3f(skySkyScalar, skySkyScalar, skySkyScalar).toVar('pvSkyContrib');
    const blockLightParticle = vInstLight.yzw.toVar('pvBlockLight');
    const voxelLight = max(blockLightParticle, skyContribParticle).toVar('pvVoxelLight');
    // glow raises the lighting floor, a script-driven self-illumination
    // knob that lights the particle in its OWN colour (glow=1 → fully
    // lit, shadow-free) rather than blending lit↔raw. matches mesh /
    // sprite `glow`.
    const glowFloor = vec3f(vGlow, vGlow, vGlow).toVar('pvGlowFloor');
    const light = max(voxelLight, glowFloor).toVar('pvLight');
    const shaded = mul(sampled.rgb, light).toVar('pvShaded');
    const tintedRgb = mul(shaded, vTint.rgb).toVar('pvTintedRgb');
    // overall opacity = texture alpha × tint alpha (the lifetime fade knob).
    const finalAlpha = mul(sampled.a, vTint.w).toVar('pvFinalAlpha');
    const color = vec4f(tintedRgb, finalAlpha).toVar('pvColor');

    // dithered opacity, not blended: the full transparency drives an
    // interleaved screen-door so coverage tracks the old blend alpha exactly,
    // just pixelly. no hard cutout (alpha=1 disables the DSL's 0.5 cliff) —
    // empty padding still drops out since fade -> 1 there. keeps particles in
    // the opaque, depth-writing pipeline: no sort, no blend.
    const fade = sub(f32(1), finalAlpha).toVar('pvFade');
    const fragment = ditherDiscard(color, f32(1), fade).toVar('pvFragment');

    const material = new Material({
        name: 'particle-batched',
        vertex: clipPos,
        fragment,
        cullMode: 'none',
        depthTest: true,
        depthWrite: true,
        transparent: false,
    });

    return { material, atlasTexNode };
}
