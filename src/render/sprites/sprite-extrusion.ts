import type { SpriteAtlasMetadata } from '../../core/sprites/atlas';
import type { SpriteResources } from './sprite-resources';

/** Raw bake output, vertex/index arrays ready to upload into an
 *  uber-buffer pool. `pixelWidth/pixelHeight` carry the native sprite
 *  dims so the caller can size each instance's transform correctly. */
export type ExtrudedSpriteMesh = {
    positions: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    pixelWidth: number;
    pixelHeight: number;
};

/**
 * Bake a sprite's union-silhouette extruded mesh into raw vertex/index arrays. Returns `null` when the sprite
 * isn't ready (atlas/metadata absent, sprite unknown, fully-transparent silhouette); caller should retry next frame.
 * Sprite-local space is centred on the local origin in source pixels: X right (-W/2..+W/2), Y up (-H/2..+H/2),
 * Z front-to-back (-0.5..+0.5, one pixel of depth, depth-agnostic); the caller scales each instance's transform
 * Z by `depth * worldScale` so the same mesh renders at any thickness.
 */
export function bakeExtrudedSpriteMesh(res: SpriteResources, spriteId: string): ExtrudedSpriteMesh | null {
    if (!res.metadata || !res.pixels) return null;
    const entry = res.metadata.sprites[spriteId];
    if (!entry || entry.frames.length === 0) return null;
    return bakeExtrudedGeometry(res.pixels, res.metadata, entry);
}

function bakeExtrudedGeometry(
    atlasPixels: Uint8Array,
    metadata: SpriteAtlasMetadata,
    entry: SpriteAtlasMetadata['sprites'][string],
): ExtrudedSpriteMesh | null {
    // every frame of a sprite has the same dimensions by construction
    // (the atlas pipeline asserts this), read W/H off frame 0.
    const f0 = entry.frames[0]!;
    const W = f0.w;
    const H = f0.h;
    if (W <= 0 || H <= 0) return null;

    const silhouette = buildUnionSilhouette(atlasPixels, metadata.atlasSize, entry, W, H);

    // worst case: every pixel solid and every face emitted (6 faces per pixel). Pre-size scratch arrays at the upper bound; trim with drawRange.
    const maxFaces = W * H * 6;
    const positions = new Float32Array(maxFaces * 4 * 3);
    const uvs = new Float32Array(maxFaces * 4 * 2);
    const indices = new Uint32Array(maxFaces * 6);

    let vertCount = 0;
    let idxCount = 0;

    const invW = 1 / W;
    const invH = 1 / H;
    // centre the mesh on its local origin so the trait's transform
    // rotates / scales about the sprite's middle, not a corner.
    const halfW = W * 0.5;
    const halfH = H * 0.5;

    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
            if (!silhouette[j * W + i]) continue;

            // sprite-local UV for every vertex of this pixel's box,
            // pixel centre, constant across the 6 faces (the front /
            // back face samples its own pixel; sides too, because the
            // extruded surface is a single pixel's silhouette).
            const u = (i + 0.5) * invW;
            const v = (j + 0.5) * invH;

            // sprite-local position bounds in source pixels, centred on
            // the local origin (X/Y span -W/2..+W/2, -H/2..+H/2; Z spans
            // -0.5..+0.5 for one pixel of depth). Y is flipped so the
            // bake reads "atlas top-left = max Y" and ends up Y-up in
            // world space.
            const x0 = i - halfW,
                x1 = i + 1 - halfW;
            const y0 = H - j - 1 - halfH,
                y1 = H - j - halfH;
            const z0 = -0.5,
                z1 = 0.5;

            // front (-Z): always
            vertCount = emitQuad(
                positions,
                uvs,
                indices,
                vertCount,
                idxCount,
                u,
                v,
                x0,
                y0,
                z0,
                x1,
                y0,
                z0,
                x1,
                y1,
                z0,
                x0,
                y1,
                z0,
            );
            idxCount += 6;

            // back (+Z): always, winding reversed so it faces +Z
            vertCount = emitQuad(
                positions,
                uvs,
                indices,
                vertCount,
                idxCount,
                u,
                v,
                x1,
                y0,
                z1,
                x0,
                y0,
                z1,
                x0,
                y1,
                z1,
                x1,
                y1,
                z1,
            );
            idxCount += 6;

            // sides, emit only on boundary with non-opaque neighbour
            // -X (left)
            if (i === 0 || !silhouette[j * W + (i - 1)]) {
                vertCount = emitQuad(
                    positions,
                    uvs,
                    indices,
                    vertCount,
                    idxCount,
                    u,
                    v,
                    x0,
                    y0,
                    z1,
                    x0,
                    y0,
                    z0,
                    x0,
                    y1,
                    z0,
                    x0,
                    y1,
                    z1,
                );
                idxCount += 6;
            }
            // +X (right)
            if (i === W - 1 || !silhouette[j * W + (i + 1)]) {
                vertCount = emitQuad(
                    positions,
                    uvs,
                    indices,
                    vertCount,
                    idxCount,
                    u,
                    v,
                    x1,
                    y0,
                    z0,
                    x1,
                    y0,
                    z1,
                    x1,
                    y1,
                    z1,
                    x1,
                    y1,
                    z0,
                );
                idxCount += 6;
            }
            // +Y (top in world space = -j neighbour in image space)
            if (j === 0 || !silhouette[(j - 1) * W + i]) {
                vertCount = emitQuad(
                    positions,
                    uvs,
                    indices,
                    vertCount,
                    idxCount,
                    u,
                    v,
                    x0,
                    y1,
                    z0,
                    x1,
                    y1,
                    z0,
                    x1,
                    y1,
                    z1,
                    x0,
                    y1,
                    z1,
                );
                idxCount += 6;
            }
            // -Y (bottom in world space = +j neighbour in image space)
            if (j === H - 1 || !silhouette[(j + 1) * W + i]) {
                vertCount = emitQuad(
                    positions,
                    uvs,
                    indices,
                    vertCount,
                    idxCount,
                    u,
                    v,
                    x0,
                    y0,
                    z1,
                    x1,
                    y0,
                    z1,
                    x1,
                    y0,
                    z0,
                    x0,
                    y0,
                    z0,
                );
                idxCount += 6;
            }
        }
    }

    if (idxCount === 0) return null; // fully-transparent sprite

    return {
        positions: positions.slice(0, vertCount * 3),
        uvs: uvs.slice(0, vertCount * 2),
        indices: indices.slice(0, idxCount),
        pixelWidth: W,
        pixelHeight: H,
    };
}

/**
 * Append one quad (4 verts + 6 indices) to the scratch buffers, all
 * vertices sharing the same UV. Returns the new vertex count.
 */
function emitQuad(
    positions: Float32Array,
    uvs: Float32Array,
    indices: Uint32Array,
    vertCount: number,
    idxCount: number,
    u: number,
    v: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    dx: number,
    dy: number,
    dz: number,
): number {
    const p = vertCount * 3;
    positions[p] = ax;
    positions[p + 1] = ay;
    positions[p + 2] = az;
    positions[p + 3] = bx;
    positions[p + 4] = by;
    positions[p + 5] = bz;
    positions[p + 6] = cx;
    positions[p + 7] = cy;
    positions[p + 8] = cz;
    positions[p + 9] = dx;
    positions[p + 10] = dy;
    positions[p + 11] = dz;

    const q = vertCount * 2;
    uvs[q] = u;
    uvs[q + 1] = v;
    uvs[q + 2] = u;
    uvs[q + 3] = v;
    uvs[q + 4] = u;
    uvs[q + 5] = v;
    uvs[q + 6] = u;
    uvs[q + 7] = v;

    indices[idxCount] = vertCount;
    indices[idxCount + 1] = vertCount + 1;
    indices[idxCount + 2] = vertCount + 2;
    indices[idxCount + 3] = vertCount;
    indices[idxCount + 4] = vertCount + 2;
    indices[idxCount + 5] = vertCount + 3;

    return vertCount + 4;
}

/**
 * Union of opaque pixels across every frame, in sprite-local (W, H)
 * coords. Returns a Uint8Array of length W*H, 1 = opaque in at least
 * one frame, 0 = transparent in all frames.
 *
 * "Opaque" means alpha > 0; the atlas was emitted with premultiplied
 * alpha so any non-zero alpha pixel contributes a visible texel.
 */
function buildUnionSilhouette(
    atlasPixels: Uint8Array,
    atlasSize: number,
    entry: SpriteAtlasMetadata['sprites'][string],
    W: number,
    H: number,
): Uint8Array {
    const out = new Uint8Array(W * H);
    for (const frame of entry.frames) {
        for (let j = 0; j < H; j++) {
            const py = frame.y + j;
            for (let i = 0; i < W; i++) {
                if (out[j * W + i]) continue;
                const px = frame.x + i;
                const alpha = atlasPixels[(py * atlasSize + px) * 4 + 3]!;
                if (alpha > 0) out[j * W + i] = 1;
            }
        }
    }
    return out;
}
