// ── voxel mip pyramid ───────────────────────────────────────────────
//
// CPU-built mip chain for the block texture array. gpucat's render-pass
// mip generator does a naive, non-premultiplied box filter, which wrecks
// alpha-cutout block textures two ways:
//
//   1. fringe   — transparent texels carry arbitrary RGB (often black);
//                 averaging it in bleeds dark halos around cutout edges.
//   2. erosion  — averaging alpha then hard-discarding at 0.5 shrinks
//                 coverage every level, so foliage/glass thins and holes
//                 grow with distance.
//
// We build the chain here instead so each cutout layer gets:
//   • premultiplied (gamma-correct) RGB downsampling → kills the fringe.
//   • coverage-preserving alpha rescale (Castano) → keeps the fraction of
//     texels above the 0.5 cutoff constant across levels → kills erosion.
//
// Opaque/translucent layers get the premultiplied RGB treatment but a
// plain alpha average (coverage-preserve is a cutout-only concern). Each
// returned level is a packed all-layers buffer, ready for ArrayTexture.mipmaps.

import { Source } from 'gpucat';

const BPP = 4;

/** hard alpha-cutout threshold the transparent pass discards below (see dsl.ts). */
const ALPHA_REF = 0.5;

// ── sRGB transfer (block textures are rgba8unorm-srgb) ──────────────
//
// downsampling must average in linear light, not gamma-encoded bytes —
// matching what the GPU path does implicitly via its sRGB texture views.

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
    const c = i / 255;
    SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbByte(l: number): number {
    const c = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

/**
 * Build mip levels 1..N for a square-tile array texture.
 *
 * @param baseData    packed level-0 data (layerCount × tileSize² × RGBA8), layer-major
 * @param layerCount  number of array layers
 * @param tileSize    edge length of each (square) tile in texels; must be a power of two
 * @param isCutout    per-layer flag: true → coverage-preserving alpha (alpha cutout block)
 * @returns           Sources for levels 1..N (level 0 stays the texture's own data)
 */
export function buildVoxelMipPyramid(
    baseData: Uint8Array,
    layerCount: number,
    tileSize: number,
    isCutout: (layer: number) => boolean,
): Source[] {
    // Pass 1 — build the raw box-filtered chain (premultiplied RGB + averaged
    // alpha), each level downsampled from the previous one. Coverage rescale is
    // deliberately NOT applied here so it never feeds back into deeper levels.
    const rawLevels: { data: Uint8Array; size: number }[] = [];
    let srcData = baseData;
    let srcSize = tileSize;
    while (srcSize > 1) {
        const dstSize = srcSize >> 1;
        const dstData = new Uint8Array(layerCount * dstSize * dstSize * BPP);
        for (let layer = 0; layer < layerCount; layer++) {
            downsampleLayerPremultiplied(srcData, dstData, layer, srcSize, dstSize);
        }
        rawLevels.push({ data: dstData, size: dstSize });
        srcData = dstData;
        srcSize = dstSize;
    }

    // Pass 2 — rescale each cutout layer's alpha per level against the *base*
    // coverage (Castano), independent of the chain, then wrap as a Source.
    const levels: Source[] = [];
    for (const { data, size } of rawLevels) {
        for (let layer = 0; layer < layerCount; layer++) {
            if (isCutout(layer)) preserveCoverage(baseData, data, layer, tileSize, size);
        }
        levels.push(new Source({ data, width: size, height: size, depth: layerCount }));
    }

    return levels;
}

// ── premultiplied 2×2 box downsample of one layer ───────────────────

function downsampleLayerPremultiplied(
    srcData: Uint8Array,
    dstData: Uint8Array,
    layer: number,
    srcSize: number,
    dstSize: number,
): void {
    const srcStride = srcSize * BPP;
    const srcLayerOffset = layer * srcSize * srcSize * BPP;
    const dstLayerOffset = layer * dstSize * dstSize * BPP;

    for (let dy = 0; dy < dstSize; dy++) {
        for (let dx = 0; dx < dstSize; dx++) {
            const sx = dx << 1;
            const sy = dy << 1;

            // 2×2 source footprint
            const o00 = srcLayerOffset + sy * srcStride + sx * BPP;
            const o10 = o00 + BPP;
            const o01 = o00 + srcStride;
            const o11 = o01 + BPP;

            const a0 = srcData[o00 + 3]! / 255;
            const a1 = srcData[o10 + 3]! / 255;
            const a2 = srcData[o01 + 3]! / 255;
            const a3 = srcData[o11 + 3]! / 255;
            const sumA = a0 + a1 + a2 + a3;

            const dst = dstLayerOffset + (dy * dstSize + dx) * BPP;

            if (sumA > 0) {
                // premultiplied: weight linear RGB by alpha, then un-premultiply.
                for (let ch = 0; ch < 3; ch++) {
                    const lin =
                        SRGB_TO_LINEAR[srcData[o00 + ch]!]! * a0 +
                        SRGB_TO_LINEAR[srcData[o10 + ch]!]! * a1 +
                        SRGB_TO_LINEAR[srcData[o01 + ch]!]! * a2 +
                        SRGB_TO_LINEAR[srcData[o11 + ch]!]! * a3;
                    dstData[dst + ch] = linearToSrgbByte(lin / sumA);
                }
            } else {
                // fully transparent footprint — no coverage to weight by; keep a
                // plain linear average so the (invisible) RGB stays well-defined.
                for (let ch = 0; ch < 3; ch++) {
                    const lin =
                        SRGB_TO_LINEAR[srcData[o00 + ch]!]! +
                        SRGB_TO_LINEAR[srcData[o10 + ch]!]! +
                        SRGB_TO_LINEAR[srcData[o01 + ch]!]! +
                        SRGB_TO_LINEAR[srcData[o11 + ch]!]!;
                    dstData[dst + ch] = linearToSrgbByte(lin / 4);
                }
            }

            dstData[dst + 3] = Math.round((sumA / 4) * 255);
        }
    }
}

// ── coverage-preserving alpha rescale (Castano) ─────────────────────
//
// Find a per-level alpha scale so the fraction of texels passing the 0.5
// cutoff matches the base level, then bake it into this level's alpha.
// Without this, the averaged alpha drops below 0.5 at the edges and the
// cutout erodes; with it, distant foliage keeps its silhouette.

function preserveCoverage(baseData: Uint8Array, dstData: Uint8Array, layer: number, baseSize: number, dstSize: number): void {
    const target = coverageOf(baseData, layer, baseSize, 1);
    const dstLayerOffset = layer * dstSize * dstSize * BPP;
    const texels = dstSize * dstSize;

    // nothing passes / everything passes → no meaningful scale to solve for.
    if (target <= 0 || target >= 1) return;

    // binary-search the scale; coverage is monotonic increasing in scale.
    let lo = 0;
    let hi = 4;
    let scale = 1;
    for (let iter = 0; iter < 12; iter++) {
        scale = (lo + hi) * 0.5;
        if (coverageOf(dstData, layer, dstSize, scale) < target) {
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

/** fraction of a layer's texels whose scaled alpha clears ALPHA_REF. */
function coverageOf(data: Uint8Array, layer: number, size: number, scale: number): number {
    const layerOffset = layer * size * size * BPP;
    const texels = size * size;
    let passed = 0;
    for (let i = 0; i < texels; i++) {
        const a = (data[layerOffset + i * BPP + 3]! / 255) * scale;
        if (Math.min(1, a) >= ALPHA_REF) passed++;
    }
    return passed / texels;
}
