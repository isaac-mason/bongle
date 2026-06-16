// ParticleResources — engine-global particle material.
//
// One instance per `EngineClient`, shared across rooms. The atlas Texture
// is owned by `SpriteResources` — this struct holds a TextureNode bound at
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
    d,
    f32,
    instanceIndex,
    layoutStrideOf,
    Material,
    max,
    mix,
    mul,
    sin,
    smoothstep,
    storage,
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
import { EnvConfig } from '../environment';

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

// sky-brightness curve — must match voxel-material + voxel-mesh-visuals
// so particles shade the same as the world they hang in.
const NIGHT_SKY_BRIGHTNESS = 0.05;
const DAY_SKY_BRIGHTNESS = 0.9;
const DISABLED_SKY_BRIGHTNESS = 1.0;

// ── public type ─────────────────────────────────────────────────────

export type ParticleResources = {
    /** engine-global particle material — binds per-instance + env buffers
     *  by name. The atlas Texture is bound via `atlasTexNode`; atlas
     *  swaps rebind that node without rebuilding the material. */
    material: Material;
    /** atlas TextureNode owned by `material`. Retargeted by
     *  `rebindAtlas()` when SpriteResources swaps its atlas. */
    atlasTexNode: TextureNode;
};

// ── public api ──────────────────────────────────────────────────────

export function init(atlas: Texture): ParticleResources {
    const { material, atlasTexNode } = createParticleMaterial(atlas);
    return { material, atlasTexNode };
}

/** Retarget the material's atlas TextureNode at a freshly-allocated
 *  atlas. Called from registry-dispatch after SpriteResources swaps. */
export function rebindAtlas(res: ParticleResources, atlas: Texture): void {
    res.atlasTexNode.bindingNode.value = atlas._gpuTexture;
    res.atlasTexNode.samplerNode!.value = atlas._gpuSampler;
}

export function dispose(res: ParticleResources): void {
    res.material.dispose();
}

// ── internals ───────────────────────────────────────────────────────

function createParticleMaterial(atlas: Texture): { material: Material; atlasTexNode: TextureNode } {
    const aPosition = attribute('position', d.vec3f);
    const aUv = attribute('uv', d.vec2f);

    const poseStorage = storage('instancePose', d.array(InstancePose), 'read');
    const matStorage = storage('instanceMaterial', d.array(InstanceMaterial), 'read');

    const inst = poseStorage.element(instanceIndex);
    const posWorld = inst.field('posWorld').toVar('pvPos');
    const width = inst.field('width').toVar('pvW');
    const height = inst.field('height').toVar('pvH');

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

    const mat = matStorage.element(instanceIndex);
    const uvRect = mat.field('uvRect').toVar('pvUvRect');
    const tint = mat.field('tint').toVar('pvTint');
    const instLight = mat.field('light').toVar('pvInstLight');
    const glow = mat.field('glow').toVar('pvGlow');

    const sampledU = add(uvRect.x, mul(aUv.x, uvRect.z)).toVar('pvSampledU');
    const sampledV = add(uvRect.y, mul(aUv.y, uvRect.w)).toVar('pvSampledV');
    const sampledUv = vec2f(sampledU, sampledV).toVar('pvSampledUv');

    const vUv = varying(sampledUv, 'pvUv').setInterpolation('perspective', 'centroid');
    const vTint = varying(tint, 'pvTintV').setInterpolation('flat');
    const vInstLight = varying(instLight, 'pvInstLightV').setInterpolation('flat');
    const vGlow = varying(glow, 'pvGlowV').setInterpolation('flat');

    const cfg = storage('env', EnvConfig, 'read').fields();
    const TAU = f32(Math.PI * 2).toVar('pvTau');
    const sunAngle = mul(sub(cfg.time, f32(0.25)), TAU).toVar('pvSunAngle');
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
    // glow raises the lighting floor — a script-driven self-illumination
    // knob that lights the particle in its OWN colour (glow=1 → fully
    // lit, shadow-free) rather than blending lit↔raw. matches mesh /
    // sprite `glow`.
    const glowFloor = vec3f(vGlow, vGlow, vGlow).toVar('pvGlowFloor');
    const light = max(voxelLight, glowFloor).toVar('pvLight');
    const shaded = mul(sampled.rgb, light).toVar('pvShaded');
    const tintedRgb = mul(shaded, vTint.rgb).toVar('pvTintedRgb');
    const finalAlpha = mul(sampled.a, vTint.w).toVar('pvFinalAlpha');
    const fragment = vec4f(tintedRgb, finalAlpha).toVar('pvFragment');

    const material = new Material({
        name: 'particle-batched',
        vertex: clipPos,
        fragment,
        cullMode: 'none',
        depthTest: true,
        // particles don't write depth — overlapping puffs should blend
        // rather than punch holes in each other.
        depthWrite: false,
        transparent: true,
    });

    return { material, atlasTexNode };
}
