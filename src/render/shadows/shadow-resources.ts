// ShadowResources — engine-global shadow material.
//
// One instance per `EngineClient`, shared across rooms. Per-room
// `ShadowVisuals` owns the geometry + per-instance storage buffer
// and routes it to this material by name (`instance`) via
// `geometry.setBuffer(name, buf)`.

import {
    add,
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    d,
    f32,
    instanceIndex,
    layoutStrideOf,
    Material,
    mul,
    storage,
    struct,
    vec3f,
    vec4f,
} from 'gpucat';

// ── shared gpu structs ──────────────────────────────────────────────
//
// Exported so per-room ShadowVisuals can pack into the matching layout.

// One struct per live shadow. groundPos is the raycast hit point
// (already shifted up by a small Y epsilon). radius is the half-width
// of the disc in world units. Invisible casters don't occupy a slot.
export const ShadowInstance = struct('ShadowInstance', {
    groundPos: d.vec3f,
    radius: d.f32,
});

export const SHADOW_INSTANCE_STRIDE = layoutStrideOf(ShadowInstance);

// ── public type ─────────────────────────────────────────────────────

export type ShadowResources = {
    /** engine-global shadow material — binds the per-instance storage
     *  buffer by name (`instance`). */
    material: Material;
};

// ── public api ──────────────────────────────────────────────────────

export function init(): ShadowResources {
    const material = createShadowMaterial();
    return { material };
}

export function dispose(res: ShadowResources): void {
    res.material.dispose();
}

// ── internals ───────────────────────────────────────────────────────

function createShadowMaterial(): Material {
    const aPosition = attribute('position', d.vec3f);

    const instanceStorage = storage('instance', d.array(ShadowInstance), 'read');
    const inst = instanceStorage.element(instanceIndex);
    const groundPos = inst.field('groundPos').toVar('shGround');
    const radius = inst.field('radius').toVar('shR');

    // World-XZ-aligned ground quad: aPosition.x/y in [-0.5..0.5] map to
    // world X/Z offsets scaled by the disc diameter (2 * radius). Y is
    // pinned to groundPos.y so the quad sits flush on the hit surface.
    const diameter = mul(radius, f32(2)).toVar('shDiam');
    const worldX = add(groundPos.x, mul(aPosition.x, diameter)).toVar('shWX');
    const worldZ = add(groundPos.z, mul(aPosition.y, diameter)).toVar('shWZ');
    const worldPos3 = vec3f(worldX, groundPos.y, worldZ).toVar('shWP');
    const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, vec4f(worldPos3, f32(1)))).toVar('shClip');

    const fragment = vec4f(0, 0, 0, 1).toVar('shColor');

    return new Material({
        name: 'shadow-batched',
        vertex: clipPos,
        fragment,
        // shadow disc has no back face (it's flat on the ground) — but
        // 'none' is cheaper than picking a side and matches sprite.
        cullMode: 'none',
        depthTest: true,
        depthWrite: true,
        transparent: false,
    });
}
