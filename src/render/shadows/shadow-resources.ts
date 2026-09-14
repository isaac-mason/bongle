import {
    add,
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createPlaneGeometry,
    d,
    f32,
    type Geometry,
    GpuBuffer,
    layoutStrideOf,
    Material,
    Mesh,
    mul,
    struct,
    vec3f,
    vec4f,
} from 'gpucat';

// groundPos is the raycast hit point, already shifted up by a small Y epsilon.
// radius is the disc's half-width in world units.
export const ShadowInstance = struct('ShadowInstance', {
    groundPos: d.vec3f,
    radius: d.f32,
});

export const SHADOW_INSTANCE_STRIDE = layoutStrideOf(ShadowInstance);

// The plane geometry, per-instance vertex buffer, and Mesh are client-global; a room
// swap reuses this allocation (reset head + re-add the Mesh) instead of reallocating.
const INITIAL_INSTANCE_CAPACITY = 64;

type GpuBufferType = GpuBuffer<any>;

/** Structural (not imported) so this module doesn't depend on shadow-visuals; `ShadowVisualState` satisfies it. */
type SlotOwner = { slot: number };

export type ShadowBatch = {
    mesh: Mesh;
    geometry: Geometry;
    instanceBuf: GpuBufferType;
    /** Dense alive prefix `[0, head)` of `instanceBuf`. */
    head: number;
    capacity: number;
    /** Parallel to instanceBuf: which state owns slot i (null for free). */
    slotOwner: (SlotOwner | null)[];
};

function createShadowBatch(material: Material): ShadowBatch {
    const capacity = INITIAL_INSTANCE_CAPACITY;

    // The vertex shader reads aPosition.xy as world-XZ offsets.
    const geometry = createPlaneGeometry(1, 1);

    const instanceBuf = new GpuBuffer(d.array(ShadowInstance), {
        label: 'shadow-instances',
        data: new Float32Array((capacity * SHADOW_INSTANCE_STRIDE) / 4),
        usage: 'vertex',
    });
    geometry.setBuffer('instance', instanceBuf);

    const mesh = new Mesh(geometry, material);
    mesh.name = 'shadow-visuals';
    mesh.frustumCulled = false;
    mesh.count = 0;

    return {
        mesh,
        geometry,
        instanceBuf,
        head: 0,
        capacity,
        slotOwner: new Array(capacity).fill(null),
    };
}

/** Empties the dense head + slot ownership; buffers are untouched since every visible slot re-writes each frame. */
export function resetShadowBatch(batch: ShadowBatch): void {
    batch.head = 0;
    batch.mesh.count = 0;
    batch.slotOwner.fill(null);
}

// gpucat tracks buffer swaps by GpuBuffer identity, so routing a fresh wrapper via
// `geometry.setBuffer(name, newBuf)` rebuilds the material's bind groups.
export function growShadowBatch(batch: ShadowBatch, newCapacity: number): void {
    const oldArr = batch.instanceBuf.array as Float32Array;
    const floats = (newCapacity * SHADOW_INSTANCE_STRIDE) / 4;
    const newArr = new Float32Array(floats);
    newArr.set(oldArr.subarray(0, Math.min(oldArr.length, floats)));
    const newBuf = new GpuBuffer(d.array(ShadowInstance), { data: newArr, usage: 'vertex', label: 'shadow-instances' });
    batch.geometry.setBuffer('instance', newBuf);
    batch.instanceBuf.dispose();
    batch.instanceBuf = newBuf;

    batch.slotOwner.length = newCapacity;
    for (let i = batch.capacity; i < newCapacity; i++) batch.slotOwner[i] = null;
    batch.capacity = newCapacity;
}

// Called once at client shutdown, never on room swap.
function disposeShadowBatch(batch: ShadowBatch): void {
    batch.geometry.dispose();
    batch.instanceBuf.dispose();
}

export type ShadowResources = {
    material: Material;
    /** Reused across room swaps; per-room `ShadowVisuals` drive it. */
    batch: ShadowBatch;
};

export function init(): ShadowResources {
    const material = createShadowMaterial();
    const batch = createShadowBatch(material);
    return { material, batch };
}

export function dispose(res: ShadowResources): void {
    disposeShadowBatch(res.batch);
    res.material.dispose();
}

function createShadowMaterial(): Material {
    const aPosition = attribute('position', d.vec3f);

    // std430 field offsets: groundPos vec3f@0, radius@12.
    const groundPos = attribute('instance', d.vec3f, { instanced: true, stride: SHADOW_INSTANCE_STRIDE, offset: 0 }).toVar(
        'shGround',
    );
    const radius = attribute('instance', d.f32, { instanced: true, stride: SHADOW_INSTANCE_STRIDE, offset: 12 }).toVar('shR');

    // aPosition.x/y in [-0.5..0.5] map to world X/Z offsets scaled by the disc diameter;
    // Y is pinned to groundPos.y so the quad sits flush on the hit surface.
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
        cullMode: 'none',
        depthTest: true,
        depthWrite: true,
        transparent: false,
    });
}
