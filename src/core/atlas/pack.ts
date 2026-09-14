import { addSkylineLevel, emptySkyline, findBestFit, type Region } from './skyline';

export type PackItem = {
    w: number;
    h: number;
    /** texels reserved on every side; the returned rect is the interior. */
    padding: number;
};

export type PackResult = {
    atlasSize: number;
    /** interior rect per item, in input order. */
    rects: Region[];
};

/**
 * Pack `items` into a square atlas, doubling from `initialSize` until
 * everything fits or `maxSize` is exceeded (null). Cells are rounded up to a
 * multiple of `align` on both axes; with every cell aligned, every skyline
 * edge is too, so origins come out aligned without a second pass.
 */
export function packAtlas(items: PackItem[], align: number, initialSize: number, maxSize: number): PackResult | null {
    for (let atlasSize = initialSize; atlasSize <= maxSize; atlasSize *= 2) {
        const rects = tryPack(items, align, atlasSize);
        if (rects) return { atlasSize, rects };
    }
    return null;
}

const alignUp = (v: number, align: number) => Math.ceil(v / align) * align;

function tryPack(items: PackItem[], align: number, atlasSize: number): Region[] | null {
    const cellW = items.map((it) => alignUp(it.w + it.padding * 2, align));
    const cellH = items.map((it) => alignUp(it.h + it.padding * 2, align));

    // tallest first for skyline efficiency; the output keeps input order.
    const order = items.map((_, i) => i);
    order.sort((a, b) => cellH[b]! - cellH[a]! || cellW[b]! - cellW[a]! || a - b);

    const skyline = emptySkyline(atlasSize);
    const rects: Region[] = new Array(items.length);
    for (const idx of order) {
        const w = cellW[idx]!;
        const h = cellH[idx]!;
        if (w > atlasSize || h > atlasSize) return null;
        const fit = findBestFit(skyline, atlasSize, w, h);
        if (!fit) return null;
        addSkylineLevel(skyline, fit.nodeIdx, fit.x, fit.y, w, h);
        const { padding } = items[idx]!;
        rects[idx] = { x: fit.x + padding, y: fit.y + padding, w: items[idx]!.w, h: items[idx]!.h };
    }
    return rects;
}
