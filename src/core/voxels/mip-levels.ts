export const BPP = 4;

/** hard alpha-cutout threshold the transparent pass discards below. One
 *  definition: the coverage target here and the shader's discard must agree,
 *  or the chain preserves coverage against a line the shader never draws. */
export const ALPHA_REF = 0.5;

/** one mip level of a layer-packed buffer: `layerCount x width x height x RGBA8`. */
export type MipLevel = { data: Uint8Array; width: number; height: number };

// block textures are rgba8unorm-srgb; downsampling must average in linear
// light, not gamma-encoded bytes, matching what the GPU path does implicitly
// via its sRGB texture views.
function srgbToLinear(c: number): number {
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB_TO_LINEAR[i] = srgbToLinear(i / 255);

// the reverse transfer's `**` was ~90% of downsample cost, so it's a table
// lookup indexed by sqrt(linear) (even perceptual spacing); SRGB_ROUND_EDGE
// then snaps the +-1 error so the result is bit-identical to the direct transfer.
const LINEAR_TO_SRGB_STEPS = 4096;

/** exact linear -> sRGB byte. Table construction only; the hot path uses the table. */
function exactLinearToSrgbByte(l: number): number {
    const c = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

const LINEAR_TO_SRGB = new Uint8Array(LINEAR_TO_SRGB_STEPS + 1);
for (let i = 0; i <= LINEAR_TO_SRGB_STEPS; i++) {
    const s = i / LINEAR_TO_SRGB_STEPS;
    LINEAR_TO_SRGB[i] = exactLinearToSrgbByte(s * s);
}

/** linear value at which the rounded sRGB byte flips from i to i + 1. */
const SRGB_ROUND_EDGE = new Float64Array(256);
for (let i = 0; i < 255; i++) SRGB_ROUND_EDGE[i] = srgbToLinear((i + 0.5) / 255);
SRGB_ROUND_EDGE[255] = Number.POSITIVE_INFINITY;

function linearToSrgbByte(l: number): number {
    if (l <= 0) return 0;
    if (l >= 1) return 255;
    let byte = LINEAR_TO_SRGB[(Math.sqrt(l) * LINEAR_TO_SRGB_STEPS) | 0]!;
    if (l >= SRGB_ROUND_EDGE[byte]!) byte++;
    else if (byte > 0 && l < SRGB_ROUND_EDGE[byte - 1]!) byte--;
    return byte;
}

/**
 * Build mip levels 1..levelCount for a layer-packed set of same-sized tiles.
 * Each axis halves per level and floors at 1; the caller picks `levelCount`
 * so a tile (a multiple of 2^levelCount per side) never hits a 1-texel strip.
 *
 * @param baseData packed level-0 data (layerCount x width x height x RGBA8), layer-major
 * @param isCutout per-layer flag: true -> coverage-preserving alpha (alpha cutout block)
 * @returns levels 1..levelCount, each layer-packed; level 0 is the caller's own data
 */
export function buildMipLevels(
    baseData: Uint8Array,
    layerCount: number,
    width: number,
    height: number,
    levelCount: number,
    isCutout: (layer: number) => boolean,
): MipLevel[] {
    // pass 1: raw box-filtered chain (premultiplied RGB + averaged alpha), each
    // level from the previous one. coverage rescale is not applied here so it
    // never feeds back into deeper levels.
    const rawLevels: MipLevel[] = [];
    let srcData = baseData;
    let srcW = width;
    let srcH = height;
    for (let level = 0; level < levelCount; level++) {
        const dstW = Math.max(1, srcW >> 1);
        const dstH = Math.max(1, srcH >> 1);
        const dstData = new Uint8Array(layerCount * dstW * dstH * BPP);
        for (let layer = 0; layer < layerCount; layer++) {
            downsampleLayerPremultiplied(srcData, dstData, layer, srcW, srcH, dstW, dstH);
        }
        rawLevels.push({ data: dstData, width: dstW, height: dstH });
        srcData = dstData;
        srcW = dstW;
        srcH = dstH;
    }

    // pass 2: rescale each cutout layer's alpha per level against the base
    // coverage (Castano). the target is a property of the base level, so
    // resolve it once rather than rescanning per level.
    const cutoutLayers: number[] = [];
    const coverageTargets: number[] = [];
    for (let layer = 0; layer < layerCount; layer++) {
        if (!isCutout(layer)) continue;
        const target = coverageOf(baseData, layer, width * height, 1);
        // nothing passes / everything passes -> no meaningful scale to solve for.
        if (target <= 0 || target >= 1) continue;
        cutoutLayers.push(layer);
        coverageTargets.push(target);
    }

    for (const { data, width: w, height: h } of rawLevels) {
        for (let i = 0; i < cutoutLayers.length; i++) {
            preserveCoverage(data, cutoutLayers[i]!, w * h, coverageTargets[i]!);
        }
    }

    return rawLevels;
}

function downsampleLayerPremultiplied(
    srcData: Uint8Array,
    dstData: Uint8Array,
    layer: number,
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number,
): void {
    const srcStride = srcW * BPP;
    const srcLayerOffset = layer * srcW * srcH * BPP;
    const dstLayerOffset = layer * dstW * dstH * BPP;
    // a 1-texel source axis has no second column/row to average; sample it twice.
    const stepX = srcW > 1 ? BPP : 0;
    const stepY = srcH > 1 ? srcStride : 0;

    for (let dy = 0; dy < dstH; dy++) {
        for (let dx = 0; dx < dstW; dx++) {
            const sx = Math.min(dx << 1, srcW - 1);
            const sy = Math.min(dy << 1, srcH - 1);

            // 2x2 source footprint
            const o00 = srcLayerOffset + sy * srcStride + sx * BPP;
            const o10 = o00 + stepX;
            const o01 = o00 + stepY;
            const o11 = o01 + stepX;

            // alpha weights stay as raw bytes: the 255 scale cancels against sumA below.
            const a0 = srcData[o00 + 3]!;
            const a1 = srcData[o10 + 3]!;
            const a2 = srcData[o01 + 3]!;
            const a3 = srcData[o11 + 3]!;
            const sumA = a0 + a1 + a2 + a3;

            const dst = dstLayerOffset + (dy * dstW + dx) * BPP;

            if (sumA > 0) {
                // weight linear RGB by alpha, then un-premultiply.
                const invSumA = 1 / sumA;
                for (let ch = 0; ch < 3; ch++) {
                    const lin =
                        SRGB_TO_LINEAR[srcData[o00 + ch]!]! * a0 +
                        SRGB_TO_LINEAR[srcData[o10 + ch]!]! * a1 +
                        SRGB_TO_LINEAR[srcData[o01 + ch]!]! * a2 +
                        SRGB_TO_LINEAR[srcData[o11 + ch]!]! * a3;
                    dstData[dst + ch] = linearToSrgbByte(lin * invSumA);
                }
            } else {
                // no coverage to weight by; plain linear average.
                for (let ch = 0; ch < 3; ch++) {
                    const lin =
                        SRGB_TO_LINEAR[srcData[o00 + ch]!]! +
                        SRGB_TO_LINEAR[srcData[o10 + ch]!]! +
                        SRGB_TO_LINEAR[srcData[o01 + ch]!]! +
                        SRGB_TO_LINEAR[srcData[o11 + ch]!]!;
                    dstData[dst + ch] = linearToSrgbByte(lin * 0.25);
                }
            }

            dstData[dst + 3] = (sumA * 0.25 + 0.5) | 0;
        }
    }
}

/** find a per-level alpha scale (Castano) so the fraction of texels passing
 *  ALPHA_REF matches the base level, then bake it into this level's alpha. */
function preserveCoverage(dstData: Uint8Array, layer: number, texels: number, target: number): void {
    const dstLayerOffset = layer * texels * BPP;

    // skip if already at target: searching when unneeded is destructive, since
    // for a fully opaque layer it converges on the smallest satisfying scale
    // (ALPHA_REF itself), parking every alpha exactly on the discard threshold.
    // erosion is always below target, so the search only ever scales up from 1.
    if (coverageOf(dstData, layer, texels, 1) >= target) return;

    // binary-search the scale; coverage is monotonic increasing in scale.
    let lo = 1;
    let hi = 4;
    let scale = 1;
    for (let iter = 0; iter < 12; iter++) {
        scale = (lo + hi) * 0.5;
        if (coverageOf(dstData, layer, texels, scale) < target) {
            lo = scale;
        } else {
            hi = scale;
        }
    }

    for (let i = 0; i < texels; i++) {
        const ai = dstLayerOffset + i * BPP + 3;
        dstData[ai] = Math.round(Math.min(1, (dstData[ai]! / 255) * scale) * 255);
    }
}

/** fraction of a layer's `texels` texels whose scaled alpha clears ALPHA_REF. */
export function coverageOf(data: Uint8Array, layer: number, texels: number, scale: number): number {
    const layerOffset = layer * texels * BPP;
    let passed = 0;
    for (let i = 0; i < texels; i++) {
        const a = (data[layerOffset + i * BPP + 3]! / 255) * scale;
        if (Math.min(1, a) >= ALPHA_REF) passed++;
    }
    return passed / texels;
}

/** copy a `w x h` rect out of a `srcWidth`-wide RGBA8 image into a tight buffer. */
export function sliceRect(
    pixels: Uint8Array | Uint8ClampedArray,
    srcWidth: number,
    x: number,
    y: number,
    w: number,
    h: number,
): Uint8Array {
    const rowBytes = w * BPP;
    const srcStride = srcWidth * BPP;
    const out = new Uint8Array(rowBytes * h);
    for (let row = 0; row < h; row++) {
        const src = (y + row) * srcStride + x * BPP;
        out.set(pixels.subarray(src, src + rowBytes), row * rowBytes);
    }
    return out;
}

/** copy a tight `w x h` RGBA8 buffer into a `dstWidth`-wide image at (x, y). */
export function blitRect(dst: Uint8Array, dstWidth: number, x: number, y: number, src: Uint8Array, w: number, h: number): void {
    const rowBytes = w * BPP;
    const dstStride = dstWidth * BPP;
    for (let row = 0; row < h; row++) {
        dst.set(src.subarray(row * rowBytes, (row + 1) * rowBytes), (y + row) * dstStride + x * BPP);
    }
}
