import {
    add,
    attribute,
    cameraPosition,
    cameraProjectionMatrix,
    cameraViewMatrix,
    cos,
    createPlaneGeometry,
    cross,
    d,
    div,
    equal,
    f32,
    type Geometry,
    GpuBuffer,
    layoutStrideOf,
    Material,
    Mesh,
    max,
    mix,
    mul,
    normalize,
    sin,
    smoothstep,
    sqrt,
    struct,
    sub,
    Texture,
    texture,
    u32,
    varying,
    vec2f,
    vec3f,
    vec4f,
} from 'gpucat';
import type { TextureNode } from 'gpucat/dist/nodes/nodes';
import type { ResourceLoader } from '../../core/resource-loader';
import type { SpriteAtlasMetadata } from '../../core/sprites/atlas';
import { ditherDiscard } from '../dsl/dither';
import { shadeTinted } from '../dsl/shade';
import type { EnvironmentResources } from '../environment/environment';
import { applyFog, fogDistance } from '../environment/fog';
import { bindLightVolume, sampleWorldLight } from '../voxels/voxel-light-sample';

// pixel uvs normalized into 0..1 sampler space.
export type SpriteFrameUv = {
    /** top-left u in [0..1]. */
    u: number;
    /** top-left v in [0..1]. */
    v: number;
    /** width in [0..1]. */
    w: number;
    /** height in [0..1]. */
    h: number;
};

export type SpriteEntry = {
    frames: SpriteFrameUv[];
    padding: number;
    mipmap: boolean;
};

// exported so per-room SpriteVisuals can pack into the matching layout.
export const InstancePose = struct('SpriteInstancePose', {
    posWorld: d.vec3f,
    width: d.f32,
    rightWorld: d.vec3f,
    height: d.f32,
    upWorld: d.vec3f,
    flags: d.u32,
    /** shifts the quad inside its own plane, in world units along the resolved right/up. Lets one world position carry a
     *  run of quads that stay a line under any billboard basis, which is how `TextTrait` lays out its glyphs. */
    offset: d.vec2f,
});

/** float index of `InstancePose.offset` within one instance. */
export const POSE_OFFSET_F32 = 12;

export const InstanceMaterial = struct('SpriteInstanceMaterial', {
    uvRect: d.vec4f,
    // tint: rgb is the recolour target, a the intensity (lightness-preserving).
    tint: d.vec4f,
    // flash: transient overlay, rgb is the colour, a the strength (lerp).
    flash: d.vec4f,
    glow: d.f32,
    unlit: d.f32,
    litMin: d.f32,
    /** screen-door fade 0..1. 0 = solid, 1 = fully invisible. */
    dither: d.f32,
});

export const INSTANCE_POSE_STRIDE = layoutStrideOf(InstancePose);
export const INSTANCE_MATERIAL_STRIDE = layoutStrideOf(InstanceMaterial);

// mode encoding inside InstancePose.flags (low byte).
export const MODE_WORLD = 0;
export const MODE_BILLBOARD = 1;
export const MODE_Y_BILLBOARD = 2;
export const CENTER_BIT = 1 << 8;

// The plane geometry, per-instance pose/material buffers, and their Mesh live here, not on per-room visuals.
// One room renders at a time, so a room swap reuses this allocation (reset `head` + re-add the Mesh) instead
// of freeing and reallocating it. Dense swap-pop layout: slots are `[0, head)`, drawn as a single
// `drawIndexed(6, head, 0)` via `mesh.count`. Per-room `SpriteVisuals` keep only this-room's use: alive-states,
// cull entries, scene-tree query.
const INITIAL_INSTANCE_CAPACITY = 64;

/** after the world, below the editor's own overlays (which sit at `Infinity`). */
const SPRITE_ON_TOP_RENDER_ORDER = 1000;

/** what hides a sprite: the world in front of it, or nothing. */
export type SpriteOcclusion = 'world' | 'none';

export const SPRITE_OCCLUSIONS: SpriteOcclusion[] = ['world', 'none'];

type GpuBufferType = GpuBuffer<any>;

/** minimal shape the batch's `slotOwner` needs: the per-instance state's mutable slot. `SpriteVisualState`
 *  (owned by sprite-visuals) satisfies this; kept structural so resources doesn't import back from visuals. */
type SlotOwner = { slot: number };

export type SpriteBatch = {
    /** one Mesh(plane, material); added to the active room's scene on `init`,
     *  removed on `dispose`. Never disposed on a room swap. `mesh.count = head`. */
    mesh: Mesh;
    /** 1x1 plane; per-instance pose/material buffers bind by name. */
    geometry: Geometry;
    instancePoseBuf: GpuBufferType;
    instanceMaterialBuf: GpuBufferType;
    /** dense head, `[0, head)` are visible-this-frame slots. Grows up to
     *  `instanceCapacity`; free is swap-pop, not freelist push. */
    head: number;
    instanceCapacity: number;
    /** slot to owning state, parallel to the GPU buffers; freeSlot's swap-pop
     *  reads this to find the moved state and rewrite its `slot`. */
    slotOwner: (SlotOwner | null)[];
    /** bumps on every reset; a slot from an older epoch is gone, not freeable. */
    epoch: number;
};

/** Build the client-global instance batch: a shared 1x1 plane with per-instance
 *  pose/material vertex buffers, wrapped in a Mesh with the engine-global
 *  material. Not added to any scene until a room `init`s. */
function createSpriteBatch(material: Material, occlusion: SpriteOcclusion): SpriteBatch {
    const instanceCapacity = INITIAL_INSTANCE_CAPACITY;

    // Shared 1x1 plane geometry; per-instance pose + material drive world
    // placement + atlas region.
    const geometry = createPlaneGeometry(1, 1);

    const instancePoseBuf = new GpuBuffer(d.array(InstancePose), {
        label: 'sprite-instance-pose',
        data: new Float32Array((instanceCapacity * INSTANCE_POSE_STRIDE) / 4),
        usage: 'vertex',
    });
    const instanceMaterialBuf = new GpuBuffer(d.array(InstanceMaterial), {
        label: 'sprite-instance-material',
        data: new Float32Array((instanceCapacity * INSTANCE_MATERIAL_STRIDE) / 4),
        usage: 'vertex',
    });
    geometry.setBuffer('instancePose', instancePoseBuf);
    geometry.setBuffer('instanceMaterial', instanceMaterialBuf);

    const mesh = new Mesh(geometry, material);
    mesh.name = occlusion === 'world' ? 'sprite-visuals' : 'sprite-visuals-on-top';
    mesh.frustumCulled = false;
    mesh.count = 0;
    if (occlusion !== 'world') mesh.renderOrder = SPRITE_ON_TOP_RENDER_ORDER;

    return {
        mesh,
        geometry,
        instancePoseBuf,
        instanceMaterialBuf,
        head: 0,
        instanceCapacity,
        slotOwner: new Array(instanceCapacity).fill(null),
        epoch: 0,
    };
}

/** Ready the batch for a fresh room: empty the dense head and slot ownership. Buffers are not touched since every visible slot re-writes each frame. */
export function resetSpriteBatch(batch: SpriteBatch): void {
    batch.head = 0;
    batch.mesh.count = 0;
    batch.slotOwner.fill(null);
    batch.epoch++;
}

// gpucat tracks buffer swaps by GpuBuffer identity; routing a fresh wrapper via
// `geometry.setBuffer(name, newBuf)` rebuilds the material's bind groups.
export function growSpriteBatch(batch: SpriteBatch, newCapacity: number): void {
    {
        const oldArr = batch.instancePoseBuf.array as Float32Array;
        const floats = (newCapacity * INSTANCE_POSE_STRIDE) / 4;
        const newArr = new Float32Array(floats);
        newArr.set(oldArr.subarray(0, Math.min(oldArr.length, floats)));
        const newBuf = new GpuBuffer(d.array(InstancePose), { data: newArr, usage: 'vertex', label: 'sprite-pose' });
        batch.instancePoseBuf.dispose();
        batch.instancePoseBuf = newBuf;
        batch.geometry.setBuffer('instancePose', newBuf);
    }
    {
        const oldArr = batch.instanceMaterialBuf.array as Float32Array;
        const floats = (newCapacity * INSTANCE_MATERIAL_STRIDE) / 4;
        const newArr = new Float32Array(floats);
        newArr.set(oldArr.subarray(0, Math.min(oldArr.length, floats)));
        const newBuf = new GpuBuffer(d.array(InstanceMaterial), { data: newArr, usage: 'vertex', label: 'sprite-material' });
        batch.instanceMaterialBuf.dispose();
        batch.instanceMaterialBuf = newBuf;
        batch.geometry.setBuffer('instanceMaterial', newBuf);
    }

    batch.slotOwner.length = newCapacity;
    batch.slotOwner.fill(null, batch.instanceCapacity);
    batch.instanceCapacity = newCapacity;
}

function disposeSpriteBatch(batch: SpriteBatch): void {
    // Called once at client shutdown, never on room swap.
    batch.geometry.dispose();
    batch.instancePoseBuf.dispose();
    batch.instanceMaterialBuf.dispose();
}

export type SpriteResources = {
    /** 2D atlas texture, sRGB rgba8. magenta until `load()` completes. */
    atlas: Texture;
    /** CPU-side atlas pixels (RGBA, row-major, top-left origin, size
     *  `atlasSize * atlasSize * 4`). Retained alongside the GPU texture
     *  because the pixel-extrusion bake needs alpha tests over sprite
     *  frame regions. `null` while the placeholder texture is up. */
    pixels: Uint8Array | null;
    /** sidecar metadata last loaded into `atlas`. null until first load. */
    metadata: SpriteAtlasMetadata | null;
    /** per-spriteId frame uvs, derived from `metadata.sprites` at load time. */
    frames: Map<string, SpriteEntry>;
    /** sidecar hash this struct was loaded against (`null` if no real
     *  sidecar yet). Compared in `refresh` for the short-circuit. */
    atlasHash: string | null;
    /** engine-global batched-sprite material per occlusion policy, binding per-instance + env buffers by name.
     *  The atlas Texture is bound via `atlasTexNodes`; atlas swaps rebind those without rebuilding the materials. */
    materials: Record<SpriteOcclusion, Material>;
    /** atlas TextureNode owned by each material. Held here so atlas swaps can rebind
     *  `bindingNode.value` / `samplerNode.value` without rebuilding the compiled pipelines. */
    atlasTexNodes: Record<SpriteOcclusion, TextureNode>;
    /** client-global instance batch per occlusion policy (plane Mesh + per-instance buffers + dense head).
     *  Reused across room swaps; per-room visuals drive them, routing each instance by its trait's `occlusion`. */
    batches: Record<SpriteOcclusion, SpriteBatch>;
};

/**
 * Sync construct an empty SpriteResources with a magenta-placeholder
 * texture, plus the engine-global material bound against it. `load()`
 * fetches the real atlas and rebinds the material's TextureNode in place,
 * same compiled pipeline survives the atlas swap.
 */
export function init(env: EnvironmentResources): SpriteResources {
    const atlas = createPlaceholderTexture();
    const world = createSpriteMaterial(atlas, env, 'world');
    const none = createSpriteMaterial(atlas, env, 'none');
    return {
        atlas,
        pixels: null,
        metadata: null,
        frames: new Map(),
        atlasHash: null,
        materials: { world: world.material, none: none.material },
        atlasTexNodes: { world: world.atlasTexNode, none: none.atlasTexNode },
        batches: { world: createSpriteBatch(world.material, 'world'), none: createSpriteBatch(none.material, 'none') },
    };
}

/**
 * Fetch the sprite atlas PNG and populate `res` in place from the CPU-owned
 * `meta` (loaded into `Resources.spriteAtlas`). On atlas swap, allocates a fresh
 * `Texture` and rebinds the material's atlas TextureNode to it, the compiled
 * pipeline is preserved. Returns `true` when the atlas swapped.
 */
export async function load(res: SpriteResources, loader: ResourceLoader, meta: SpriteAtlasMetadata | null): Promise<boolean> {
    // an empty manifest (0 sprites) has no PNG on disk; treat it exactly like a missing atlas so we don't fetch (and 404 on) sprites-atlas.png.
    if (!meta || meta.atlasSize === 0) {
        if (res.metadata === null) return false;
        swapAtlas(res, createPlaceholderTexture());
        res.pixels = null;
        res.metadata = null;
        res.frames.clear();
        res.atlasHash = null;
        return true;
    }

    if (res.atlasHash !== null && meta.hash === res.atlasHash) return false;

    const pixels = await fetchAtlasPixels(meta.atlasSize, loader);
    if (!pixels) return false;

    swapAtlas(res, createAtlasTexture(pixels, meta.atlasSize));
    res.pixels = pixels;
    res.metadata = meta;
    res.atlasHash = meta.hash;
    rebuildFrames(res.frames, meta);
    return true;
}

/** Alias for `load()`, semantic match for HMR + registry-dispatch
 *  call sites that conceptually "refresh" an already-loaded set. */
export const refresh = load;

export function dispose(res: SpriteResources): void {
    for (const occlusion of SPRITE_OCCLUSIONS) {
        disposeSpriteBatch(res.batches[occlusion]);
        res.materials[occlusion].dispose();
    }
    res.atlas.dispose();
    res.pixels = null;
    res.metadata = null;
    res.frames.clear();
    res.atlasHash = null;
}

// gpucat caches GPUTextures by GpuTexture identity, and the per-frame upload path doesn't reallocate when
// width/height change on an existing GpuTexture, so this always swaps to a fresh Texture, then retargets the
// binding+sampler nodes the material captured at build time. The material itself stays alive across reloads.
function swapAtlas(res: SpriteResources, next: Texture): void {
    res.atlas.dispose();
    res.atlas = next;
    for (const occlusion of SPRITE_OCCLUSIONS) {
        const node = res.atlasTexNodes[occlusion];
        node.bindingNode.value = next._gpuTexture;
        // samplerNode is non-null because `texture(tex)` factory builds it
        // from `tex._gpuSampler`. Each new Texture gets a fresh GpuSampler,
        // so rebind it too.
        node.samplerNode!.value = next._gpuSampler;
    }
}

async function fetchAtlasPixels(atlasSize: number, loader: ResourceLoader): Promise<Uint8Array | null> {
    let img: HTMLImageElement;
    try {
        const bytes = await loader.loadBytes('sprites-atlas.png');
        img = await loadImageFromBytes(bytes);
    } catch {
        return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = atlasSize;
    canvas.height = atlasSize;
    const ctx2d = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx2d.imageSmoothingEnabled = false;
    ctx2d.drawImage(img, 0, 0);
    const data = ctx2d.getImageData(0, 0, atlasSize, atlasSize).data;
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** decodes image bytes into an <img> via a transient object url (the loader gives bytes; an <img> can't source a bare vfs/file path). */
function loadImageFromBytes(bytes: Uint8Array): Promise<HTMLImageElement> {
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = (e) => {
            URL.revokeObjectURL(url);
            reject(e);
        };
        img.src = url;
    });
}

function createAtlasTexture(pixels: Uint8Array, atlasSize: number): Texture {
    return new Texture(
        { data: pixels, width: atlasSize, height: atlasSize },
        {
            format: 'rgba8unorm-srgb',
            magFilter: 'nearest',
            minFilter: 'nearest',
            wrapS: 'clamp-to-edge',
            wrapT: 'clamp-to-edge',
            generateMipmaps: false,
        },
    );
}

function createPlaceholderTexture(): Texture {
    const pixels = new Uint8Array([255, 0, 255, 255]);
    return new Texture(
        { data: pixels, width: 1, height: 1 },
        {
            format: 'rgba8unorm-srgb',
            magFilter: 'nearest',
            minFilter: 'nearest',
            wrapS: 'clamp-to-edge',
            wrapT: 'clamp-to-edge',
            generateMipmaps: false,
        },
    );
}

function rebuildFrames(out: Map<string, SpriteEntry>, meta: SpriteAtlasMetadata): void {
    out.clear();
    const inv = 1 / meta.atlasSize;
    for (const [id, entry] of Object.entries(meta.sprites)) {
        const frames: SpriteFrameUv[] = entry.frames.map((r) => ({
            u: r.x * inv,
            v: r.y * inv,
            w: r.w * inv,
            h: r.h * inv,
        }));
        out.set(id, { frames, padding: entry.padding, mipmap: entry.mipmap });
    }
}

function createSpriteMaterial(
    atlas: Texture,
    env: EnvironmentResources,
    occlusion: SpriteOcclusion,
): { material: Material; atlasTexNode: TextureNode } {
    const aPosition = attribute('position', d.vec3f);
    const aUv = attribute('uv', d.vec2f);

    // per-instance pose + material via instanced vertex attributes (both backends;
    // per-room SpriteVisuals provides the `instancePose`/`instanceMaterial` buffers
    // by name, usage: 'vertex'). single dense draw, so instanceIndex indexes the
    // buffers directly. std430 field offsets below.
    const P = INSTANCE_POSE_STRIDE;
    const posWorld = attribute('instancePose', d.vec3f, { instanced: true, stride: P, offset: 0 }).toVar('svPos');
    const width = attribute('instancePose', d.f32, { instanced: true, stride: P, offset: 12 }).toVar('svW');
    const rightWorld = attribute('instancePose', d.vec3f, { instanced: true, stride: P, offset: 16 }).toVar('svRightW');
    const height = attribute('instancePose', d.f32, { instanced: true, stride: P, offset: 28 }).toVar('svH');
    const upWorld = attribute('instancePose', d.vec3f, { instanced: true, stride: P, offset: 32 }).toVar('svUpW');
    const flags = attribute('instancePose', d.u32, { instanced: true, stride: P, offset: 44 }).toVar('svFlags');
    const planeOffset = attribute('instancePose', d.vec2f, { instanced: true, stride: P, offset: 48 }).toVar('svPlaneOffset');

    const mode = flags.bitwiseAnd(u32(0xff)).toVar('svMode');
    const centerBit = flags.shiftRight(u32(8)).bitwiseAnd(u32(1)).toVar('svCenter');

    // billboard basis from cameraViewMatrix.
    const view = cameraViewMatrix;
    const viewCol0 = view.element(u32(0)).toVar('svViewCol0');
    const viewCol1 = view.element(u32(1)).toVar('svViewCol1');
    const viewCol2 = view.element(u32(2)).toVar('svViewCol2');
    const camRightBill = vec3f(viewCol0.x, viewCol1.x, viewCol2.x).toVar('svCamRightBill');
    const camUpBill = vec3f(viewCol0.y, viewCol1.y, viewCol2.y).toVar('svCamUpBill');

    // y-billboard basis: XZ-only forward.
    const camToInstX = sub(cameraPosition.x, posWorld.x).toVar('svCamToInstX');
    const camToInstZ = sub(cameraPosition.z, posWorld.z).toVar('svCamToInstZ');
    const len2 = add(mul(camToInstX, camToInstX), mul(camToInstZ, camToInstZ)).toVar('svLen2');
    const safeLen = max(sqrt(len2), f32(1e-6)).toVar('svSafeLen');
    const fwd = vec3f(div(camToInstX, safeLen), f32(0), div(camToInstZ, safeLen)).toVar('svFwd');
    const worldUp = vec3f(f32(0), f32(1), f32(0)).toVar('svWorldUp');
    const yBillRight = normalize(cross(worldUp, fwd)).toVar('svYBillRight');
    const yBillUp = worldUp;

    const isBillboard = equal(mode, u32(MODE_BILLBOARD)).toVar('svIsBillboard');
    const isYBillboard = equal(mode, u32(MODE_Y_BILLBOARD)).toVar('svIsYBillboard');
    const right = isBillboard.select(camRightBill, isYBillboard.select(yBillRight, rightWorld)).toVar('svRight');
    const up = isBillboard.select(camUpBill, isYBillboard.select(yBillUp, upWorld)).toVar('svUp');

    const notCenter = sub(f32(1), centerBit.toF32()).toVar('svNotCenter');
    const halfShift = mul(f32(0.5), notCenter).toVar('svHalfShift');
    const offX = add(aPosition.x, halfShift).toVar('svOffX');
    const offY = sub(aPosition.y, halfShift).toVar('svOffY');

    const localX = add(mul(offX, width), planeOffset.x).toVar('svLocalX');
    const localY = add(mul(offY, height), planeOffset.y).toVar('svLocalY');

    const worldPos3 = add(posWorld, add(mul(right, localX), mul(up, localY))).toVar('svWorldPos');
    const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, vec4f(worldPos3, f32(1)))).toVar('svClipPos');

    const M = INSTANCE_MATERIAL_STRIDE;
    const uvRect = attribute('instanceMaterial', d.vec4f, { instanced: true, stride: M, offset: 0 }).toVar('svUvRect');
    const tint = attribute('instanceMaterial', d.vec4f, { instanced: true, stride: M, offset: 16 }).toVar('svTint');
    const flashF = attribute('instanceMaterial', d.vec4f, { instanced: true, stride: M, offset: 32 }).toVar('svFlash');
    const glowF = attribute('instanceMaterial', d.f32, { instanced: true, stride: M, offset: 48 }).toVar('svGlow');
    const unlitF = attribute('instanceMaterial', d.f32, { instanced: true, stride: M, offset: 52 }).toVar('svUnlit');
    const litMinF = attribute('instanceMaterial', d.f32, { instanced: true, stride: M, offset: 56 }).toVar('svLitMin');
    const ditherF = attribute('instanceMaterial', d.f32, { instanced: true, stride: M, offset: 60 }).toVar('svDither');

    // sampled at the billboard's world origin, unconditionally; `unlit` is applied downstream in
    // `shadeTinted`, so an unlit sprite pays a few taps rather than needing a branch here.
    const lightF = sampleWorldLight(bindLightVolume(env), posWorld).toVar('svLight');

    const sampledU = add(uvRect.x, mul(aUv.x, uvRect.z)).toVar('svSampledU');
    const sampledV = add(uvRect.y, mul(aUv.y, uvRect.w)).toVar('svSampledV');
    const sampledUv = vec2f(sampledU, sampledV).toVar('svSampledUv');

    const vUv = varying(sampledUv, 'svUv').setInterpolation('perspective', 'centroid');
    const vTint = varying(tint, 'svTintV').setInterpolation('flat');
    const vFlash = varying(flashF, 'svFlashV').setInterpolation('flat');
    const vInstLight = varying(lightF, 'svInstLight').setInterpolation('flat');
    const vGlow = varying(glowF, 'svGlowV').setInterpolation('flat');
    const vUnlit = varying(unlitF, 'svUnlitV').setInterpolation('flat');
    const vLitMin = varying(litMinF, 'svLitMinV').setInterpolation('flat');
    const vDither = varying(ditherF, 'svDitherV').setInterpolation('flat');

    const atlasTexNode = texture(atlas);
    const sampled = atlasTexNode.sample(vUv).toVar('svSampled');

    // lighting, no ndotl (billboards have no consistent normal).
    const cfg = env.cfgNode;
    const TAU = f32(Math.PI * 2);
    const sunAngle = mul(sub(env.timeNode.time, f32(0.25)), TAU).toVar('svSunAngle');
    const sunDirection = vec3f(cos(sunAngle), sin(sunAngle), f32(0)).toVar('svSunDir');
    const ambientMinimum = vec3f(f32(0.04), f32(0.04), f32(0.06)).toVar('svAmbientMin');

    const sunY = sunDirection.y.toVar('svSunY');
    const dayCurve = smoothstep(f32(-0.1), f32(0.15), sunY).toVar('svDayCurve');
    const skyBrightnessActive = mix(f32(0.05), f32(0.9), dayCurve).toVar('svSkyBrightActive');
    const enabledMask = cfg.enabled.toF32().toVar('svEnabledMask');
    const skyBrightness = mix(f32(1.0), skyBrightnessActive, enabledMask).toVar('svSkyBrightness');

    const skyScalar = mul(vInstLight.x, skyBrightness).toVar('svSkyScalar');
    const skyContrib = vec3f(skyScalar, skyScalar, skyScalar).toVar('svSkyContrib');
    const litMinFloor = vec3f(vLitMin, vLitMin, vLitMin).toVar('svLitMinFloor');
    const blockLight = vInstLight.yzw.toVar('svBlockLight');
    const voxelLight = max(max(blockLight, skyContrib), litMinFloor).toVar('svVoxelLight');
    const light = max(voxelLight, ambientMinimum).toVar('svLight');

    const litRgb = shadeTinted(sampled.rgb, vTint, vFlash, light, vGlow, vUnlit);
    const foggedRgb = applyFog(env, litRgb, fogDistance(worldPos3, 'svFogDist'));
    const tinted = vec4f(foggedRgb, sampled.a).toVar('svTinted');

    // cutout + screen-door fade: the dither knob feeds the shared discard.
    const fragment = ditherDiscard(tinted, sampled.a, vDither).toVar('svFragment');

    // 'none' keeps the cutout look (opaque queue, discard) and simply skips the depth test, drawn after the
    // world by `SPRITE_ON_TOP_RENDER_ORDER`, so it still takes fog, the camera tint and antialiasing.
    const occluded = occlusion === 'world';
    const material = new Material({
        name: occluded ? 'sprite-batched' : 'sprite-batched-on-top',
        vertex: clipPos,
        fragment,
        cullMode: 'none',
        depthTest: occluded,
        depthWrite: occluded,
        transparent: false,
    });

    return { material, atlasTexNode };
}
