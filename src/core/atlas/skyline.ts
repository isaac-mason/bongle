// skyline rectangle packer, pure data structure + algorithms.
//
// shared by `render/models/model-atlas.ts` (runtime gltf textures) and
// `src/asset-pipeline/bake` sprite-atlas (bake-time sprite atlas).
// no GPU state, no allocator harness, callers wrap this with their own
// `regions` map + pixel buffer + texture handle.
//
// invariant: skyline nodes cover [0, size] contiguously, no gaps, no
// overlaps. `addSkylineLevel` preserves it; `emptySkyline` establishes it.

/** axis-aligned rectangle in atlas-pixel space. */
export type Region = {
    /** pixel x within the atlas. */
    x: number;
    /** pixel y within the atlas. */
    y: number;
    /** width in pixels. */
    w: number;
    /** height in pixels. */
    h: number;
};

/** one segment of the skyline, a horizontal span at height `y`. */
export type SkylineNode = {
    x: number;
    y: number;
    w: number;
};

/** Build an empty skyline covering `[0, size]`. */
export function emptySkyline(size: number): SkylineNode[] {
    return [{ x: 0, y: 0, w: size }];
}

/**
 * Best-fit-by-lowest-y across all candidate x-positions (each skyline
 * node's left edge is a candidate). Returns the chosen position + the
 * skyline node index where the new level should be inserted, or `null`
 * if no slot in the atlas fits `w × h`.
 */
export function findBestFit(
    skyline: SkylineNode[],
    atlasSize: number,
    w: number,
    h: number,
): { x: number; y: number; nodeIdx: number } | null {
    let bestX = -1;
    let bestY = atlasSize;
    let bestIdx = -1;

    for (let i = 0; i < skyline.length; i++) {
        const startX = skyline[i]!.x;
        if (startX + w > atlasSize) break;

        // find max y across nodes covering [startX, startX+w]
        let y = 0;
        let widthLeft = w;
        let j = i;
        while (widthLeft > 0 && j < skyline.length) {
            const node = skyline[j]!;
            if (node.y > y) y = node.y;
            if (y + h > atlasSize) break;
            widthLeft -= node.w;
            j++;
        }
        if (widthLeft > 0) continue;
        if (y + h > atlasSize) continue;

        // tie-break on leftmost x for determinism
        if (y < bestY || (y === bestY && startX < bestX)) {
            bestX = startX;
            bestY = y;
            bestIdx = i;
        }
    }

    return bestIdx === -1 ? null : { x: bestX, y: bestY, nodeIdx: bestIdx };
}

/**
 * Insert a new top edge `{x, y+h, w}` at `nodeIdx`, consuming any nodes
 * (or partial nodes) that fall within `[x, x+w]`. Maintains the contig-
 * uous-coverage invariant and merges adjacent same-y nodes.
 */
export function addSkylineLevel(skyline: SkylineNode[], nodeIdx: number, x: number, y: number, w: number, h: number): void {
    const newNode: SkylineNode = { x, y: y + h, w };

    // consume widths from nodeIdx forward until `w` is covered
    let consumed = 0;
    while (consumed < w && nodeIdx < skyline.length) {
        const node = skyline[nodeIdx]!;
        const remaining = w - consumed;
        if (node.w <= remaining) {
            consumed += node.w;
            skyline.splice(nodeIdx, 1);
        } else {
            // partial: shrink node from left
            node.x += remaining;
            node.w -= remaining;
            consumed = w;
        }
    }

    skyline.splice(nodeIdx, 0, newNode);

    // merge adjacent same-y nodes
    for (let i = 0; i < skyline.length - 1; ) {
        const a = skyline[i]!;
        const b = skyline[i + 1]!;
        if (a.y === b.y) {
            a.w += b.w;
            skyline.splice(i + 1, 1);
        } else {
            i++;
        }
    }
}
