// SpriteResources, engine-global GPU resources backing all sprite rendering.
//
// One instance per `EngineClient`, shared across rooms. Owns:
//   - the sprite atlas texture (sync placeholder + async real-atlas swap)
//   - CPU-side frame UV LUT parsed from the `sprites-atlas.json` sidecar
//   - the engine-global batched-sprite Material
//
// Two-phase init: synchronous `init()` returns a magenta 1×1 placeholder
// atlas + builds the material against it, then `load()` fetches the real
// atlas + sidecar. When the atlas swaps, `load()` allocates a new Texture
// (size can grow/shrink between asset rebuilds) and rebinds the material's
// TextureNode to it, no material rebuild needed. Same compiled pipeline
// survives across atlas reloads.
//
// Material binds per-instance + env buffers by name (`instancePose`,
// `instanceMaterial`, `env`). Each per-room SpriteVisuals routes its
// buffers to those names via `geometry.setBuffer(name, buf)` and sets
// `mesh.count = head` (alive slot count) per frame, slots are compacted
// CPU-side via swap-pop, so the draw needs no per-instance visibility gate.
//
// The pixel-extrusion bake cache is NOT on this struct, it lives privately
// inside `ExtrudedSpriteVisuals`'s geometry pool (per-room, refcounted by
// spriteId). Atlas swaps wipe the visuals wholesale via
// `registry-dispatch.ts:refreshSpriteResources`, so no cross-subsystem
// cache invalidation is needed here.

import {
    add,
    attribute,
    cameraPosition,
    cameraProjectionMatrix,
    cameraViewMatrix,
    cos,
    cross,
    d,
    div,
    equal,
    f32,
    instanceIndex,
    layoutStrideOf,
    Material,
    max,
    mix,
    mul,
    normalize,
    sin,
    smoothstep,
    sqrt,
    storage,
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
import { assetUrl } from '../asset-url';
import { EnvConfig } from '../environment';
import { ditherDiscard, shadeTinted } from '../visuals/dsl';

// ── sidecar shape (must match kit/src/asset-pipeline/sprite-atlas.ts) ──

/** uv rect in pixel coords of the atlas. divide by `atlasSize` for 0..1. */
export type SpriteFrameRect = {
    x: number;
    y: number;
    w: number;
    h: number;
};

export type SpriteAtlasEntry = {
    frames: SpriteFrameRect[];
    padding: number;
    mipmap: boolean;
};

export type SpriteAtlasMetadata = {
    atlasSize: number;
    sprites: Record<string, SpriteAtlasEntry>;
    hash: string;
};

// ── runtime LUT shape, pixel uvs normalized into 0..1 sampler space ──

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

// ── shared gpu structs ──────────────────────────────────────────────
//
// Exported so per-room SpriteVisuals can pack into the matching layout.

export const InstancePose = struct('SpriteInstancePose', {
    posWorld: d.vec3f,
    width: d.f32,
    rightWorld: d.vec3f,
    height: d.f32,
    upWorld: d.vec3f,
    flags: d.u32,
});

export const InstanceMaterial = struct('SpriteInstanceMaterial', {
    uvRect: d.vec4f,
    // tint: rgb is the recolour target, a the intensity (lightness-preserving).
    tint: d.vec4f,
    // flash: transient overlay, rgb is the colour, a the strength (lerp).
    flash: d.vec4f,
    light: d.vec4f,
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

// ── public type ─────────────────────────────────────────────────────

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
    /** engine-global batched-sprite material, binds per-instance + env
     *  buffers by name. The atlas Texture is bound via `atlasTexNode`;
     *  atlas swaps rebind that node without rebuilding the material. */
    material: Material;
    /** atlas TextureNode owned by `material`. Held here so atlas swaps
     *  can rebind `bindingNode.value` / `samplerNode.value` without
     *  rebuilding the compiled pipeline. */
    atlasTexNode: TextureNode;
};

// ── public api ──────────────────────────────────────────────────────

/**
 * Sync construct an empty SpriteResources with a magenta-placeholder
 * texture, plus the engine-global material bound against it. `load()`
 * fetches the real atlas and rebinds the material's TextureNode in place,
 * same compiled pipeline survives the atlas swap.
 */
export function init(): SpriteResources {
    const atlas = createPlaceholderTexture();
    const { material, atlasTexNode } = createSpriteMaterial(atlas);
    return {
        atlas,
        pixels: null,
        metadata: null,
        frames: new Map(),
        atlasHash: null,
        material,
        atlasTexNode,
    };
}

/**
 * Fetch the sprite atlas PNG + sidecar and populate `res` in place. On
 * atlas swap, allocates a fresh `Texture` and rebinds the material's
 * atlas TextureNode to it, the compiled pipeline is preserved. Returns
 * `true` when the atlas swapped.
 */
export async function load(res: SpriteResources): Promise<boolean> {
    const meta = await fetchSpriteAtlasMetadata();
    // An empty manifest (0 sprites) has no PNG on disk — treat it exactly like
    // a missing atlas so we don't fetch (and 404 on) sprites-atlas.png.
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

    const pixels = await fetchAtlasPixels(meta.atlasSize);
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
    res.atlas.dispose();
    res.material.dispose();
    res.pixels = null;
    res.metadata = null;
    res.frames.clear();
    res.atlasHash = null;
}

// ── internals ───────────────────────────────────────────────────────

// dispose the old atlas + rebind the material's TextureNode at the new
// one. gpucat caches GPUTextures by GpuTexture identity, and the
// per-frame upload path doesn't reallocate when width/height change on
// an existing GpuTexture, so we always swap to a fresh Texture, then
// retarget the binding+sampler nodes that the material captured at
// build time. material itself stays alive across reloads.
function swapAtlas(res: SpriteResources, next: Texture): void {
    res.atlas.dispose();
    res.atlas = next;
    res.atlasTexNode.bindingNode.value = next._gpuTexture;
    // samplerNode is non-null because `texture(tex)` factory builds it
    // from `tex._gpuSampler`. Each new Texture gets a fresh GpuSampler,
    // so rebind it too.
    res.atlasTexNode.samplerNode!.value = next._gpuSampler;
}

async function fetchSpriteAtlasMetadata(): Promise<SpriteAtlasMetadata | null> {
    try {
        const resp = await fetch(assetUrl('sprites-atlas.json'), { cache: 'no-store' });
        if (!resp.ok) return null;
        const ct = resp.headers.get('content-type') ?? '';
        if (!ct.includes('json')) return null;
        return (await resp.json()) as SpriteAtlasMetadata;
    } catch {
        return null;
    }
}

async function fetchAtlasPixels(atlasSize: number): Promise<Uint8Array | null> {
    let img: HTMLImageElement;
    try {
        img = await loadImage(assetUrl('sprites-atlas.png'));
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

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.crossOrigin = 'anonymous';
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

// ── material + cull compute ─────────────────────────────────────────

function createSpriteMaterial(atlas: Texture): { material: Material; atlasTexNode: TextureNode } {
    const aPosition = attribute('position', d.vec3f);
    const aUv = attribute('uv', d.vec2f);

    const poseStorage = storage('instancePose', d.array(InstancePose), 'read');
    const matStorage = storage('instanceMaterial', d.array(InstanceMaterial), 'read');

    const inst = poseStorage.element(instanceIndex);
    const posWorld = inst.field('posWorld').toVar('svPos');
    const width = inst.field('width').toVar('svW');
    const rightWorld = inst.field('rightWorld').toVar('svRightW');
    const height = inst.field('height').toVar('svH');
    const upWorld = inst.field('upWorld').toVar('svUpW');
    const flags = inst.field('flags').toVar('svFlags');

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

    const localX = mul(offX, width).toVar('svLocalX');
    const localY = mul(offY, height).toVar('svLocalY');

    const worldPos3 = add(posWorld, add(mul(right, localX), mul(up, localY))).toVar('svWorldPos');
    const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, vec4f(worldPos3, f32(1)))).toVar('svClipPos');

    const mat = matStorage.element(instanceIndex);
    const uvRect = mat.field('uvRect').toVar('svUvRect');
    const tint = mat.field('tint').toVar('svTint');
    const flashF = mat.field('flash').toVar('svFlash');
    const lightF = mat.field('light').toVar('svLight');
    const glowF = mat.field('glow').toVar('svGlow');
    const unlitF = mat.field('unlit').toVar('svUnlit');
    const litMinF = mat.field('litMin').toVar('svLitMin');
    const ditherF = mat.field('dither').toVar('svDither');

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
    const cfg = storage('env', EnvConfig, 'read').fields();
    const TAU = f32(Math.PI * 2);
    const sunAngle = mul(sub(cfg.time, f32(0.25)), TAU).toVar('svSunAngle');
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
    const tinted = vec4f(litRgb, sampled.a).toVar('svTinted');

    // cutout + screen-door fade: the dither knob feeds the shared discard.
    const fragment = ditherDiscard(tinted, sampled.a, vDither).toVar('svFragment');

    const material = new Material({
        name: 'sprite-batched',
        vertex: clipPos,
        fragment,
        cullMode: 'none',
        depthTest: true,
        depthWrite: true,
        transparent: false,
    });

    return { material, atlasTexNode };
}
