import { describe, expect, test } from 'vitest';
import {
    classifyTranslucentSort,
    FACING_NEG_X,
    FACING_NEG_Y,
    FACING_NEG_Z,
    FACING_POS_X,
    FACING_POS_Y,
    FACING_POS_Z,
    FACING_UNASSIGNED,
    type PassMesh,
    QUAD_STRIDE_U32S,
    TRANSLUCENT_SORT_DYNAMIC,
    TRANSLUCENT_SORT_NONE,
} from '../../../../src/core/voxels/chunk-mesher';

// A quad is 4 corners, each [x, y, z] in the packed u8 (1/16-voxel) units the
// classifier decodes. We only fill the 3 position header words; the classifier
// reads nothing else.
type Corner = [number, number, number];
type Quad = [Corner, Corner, Corner, Corner];

function packPositions([c0, c1, c2, c3]: Quad): [number, number, number] {
    const w0 = (c0[0] | (c0[1] << 8) | (c0[2] << 16) | (c1[0] << 24)) >>> 0;
    const w1 = (c1[1] | (c1[2] << 8) | (c2[0] << 16) | (c2[1] << 24)) >>> 0;
    const w2 = (c2[2] | (c3[0] << 8) | (c3[1] << 16) | (c3[2] << 24)) >>> 0;
    return [w0, w1, w2];
}

/** Build a translucent PassMesh from per-facing quad lists. */
function makeMesh(byFacing: Partial<Record<number, Quad[]>>): PassMesh {
    const faceOffsets = [0, 0, 0, 0, 0, 0, 0] as PassMesh['faceOffsets'];
    const faceCounts = [0, 0, 0, 0, 0, 0, 0] as PassMesh['faceCounts'];
    const words: number[] = [];
    let cursor = 0;
    for (let f = 0; f < 7; f++) {
        faceOffsets[f] = cursor;
        const quads = byFacing[f] ?? [];
        faceCounts[f] = quads.length;
        for (const q of quads) {
            const base = words.length;
            for (let i = 0; i < QUAD_STRIDE_U32S; i++) words.push(0);
            const [w0, w1, w2] = packPositions(q);
            words[base] = w0;
            words[base + 1] = w1;
            words[base + 2] = w2;
            cursor++;
        }
    }
    return { quads: new Uint32Array(words), quadCount: cursor, faceOffsets, faceCounts, sortType: 0 };
}

// axis-aligned quad builders (all coords in u8 units).
const qY = (y: number, x0: number, x1: number, z0: number, z1: number): Quad => [
    [x0, y, z0],
    [x1, y, z0],
    [x1, y, z1],
    [x0, y, z1],
];
const qX = (x: number, y0: number, y1: number, z0: number, z1: number): Quad => [
    [x, y0, z0],
    [x, y1, z0],
    [x, y1, z1],
    [x, y0, z1],
];

describe('classifyTranslucentSort', () => {
    test('empty / single quad → NONE', () => {
        expect(classifyTranslucentSort(makeMesh({}))).toBe(TRANSLUCENT_SORT_NONE);
        expect(classifyTranslucentSort(makeMesh({ [FACING_POS_Y]: [qY(64, 32, 224, 32, 224)] }))).toBe(
            TRANSLUCENT_SORT_NONE,
        );
    });

    test('flat water surface (one facing, one plane) → NONE', () => {
        const mesh = makeMesh({
            [FACING_POS_Y]: [qY(64, 32, 96, 32, 96), qY(64, 96, 160, 32, 96), qY(64, 32, 96, 96, 160)],
        });
        expect(classifyTranslucentSort(mesh)).toBe(TRANSLUCENT_SORT_NONE);
    });

    test('water at two heights (multi-plane) → DYNAMIC', () => {
        const mesh = makeMesh({
            [FACING_POS_Y]: [qY(64, 32, 224, 32, 224), qY(128, 32, 224, 32, 224)],
        });
        expect(classifyTranslucentSort(mesh)).toBe(TRANSLUCENT_SORT_DYNAMIC);
    });

    test('glass pane (opposing aligned pair) → NONE', () => {
        const mesh = makeMesh({
            [FACING_POS_X]: [qX(96, 32, 224, 32, 224)],
            [FACING_NEG_X]: [qX(96, 32, 224, 32, 224)],
        });
        expect(classifyTranslucentSort(mesh)).toBe(TRANSLUCENT_SORT_NONE);
    });

    test('glass block (convex box on the AABB) → NONE', () => {
        const mesh = makeMesh({
            [FACING_POS_X]: [qX(224, 32, 224, 32, 224)],
            [FACING_NEG_X]: [qX(32, 32, 224, 32, 224)],
            [FACING_POS_Y]: [qY(224, 32, 224, 32, 224)],
            [FACING_NEG_Y]: [qY(32, 32, 224, 32, 224)],
            [FACING_POS_Z]: [
                [
                    [32, 32, 224],
                    [224, 32, 224],
                    [224, 224, 224],
                    [32, 224, 224],
                ],
            ],
            [FACING_NEG_Z]: [
                [
                    [32, 32, 32],
                    [224, 32, 32],
                    [224, 224, 32],
                    [32, 224, 32],
                ],
            ],
        });
        expect(classifyTranslucentSort(mesh)).toBe(TRANSLUCENT_SORT_NONE);
    });

    test('box with internal divider on the same facing (multi-plane) → DYNAMIC', () => {
        const mesh = makeMesh({
            [FACING_POS_X]: [qX(224, 32, 224, 32, 224), qX(128, 32, 224, 32, 224)],
            [FACING_NEG_X]: [qX(32, 32, 224, 32, 224)],
        });
        expect(classifyTranslucentSort(mesh)).toBe(TRANSLUCENT_SORT_DYNAMIC);
    });

    test('internal wall not on the AABB boundary → DYNAMIC', () => {
        // a floor spans the full x/z extent (sets AABB), a +X wall sits mid-way.
        const mesh = makeMesh({
            [FACING_POS_Y]: [qY(32, 32, 224, 32, 224)],
            [FACING_POS_X]: [qX(128, 32, 224, 32, 224)],
        });
        expect(classifyTranslucentSort(mesh)).toBe(TRANSLUCENT_SORT_DYNAMIC);
    });

    test('two perpendicular facings on the AABB (convex corner) → NONE', () => {
        const mesh = makeMesh({
            [FACING_POS_X]: [qX(224, 32, 224, 32, 224)],
            [FACING_POS_Y]: [qY(224, 32, 224, 32, 224)],
        });
        expect(classifyTranslucentSort(mesh)).toBe(TRANSLUCENT_SORT_NONE);
    });

    test('unaligned / model quads present → DYNAMIC', () => {
        const mesh = makeMesh({
            [FACING_POS_Y]: [qY(64, 32, 224, 32, 224)],
            [FACING_UNASSIGNED]: [
                [
                    [40, 40, 40],
                    [80, 60, 40],
                    [80, 60, 80],
                    [40, 40, 80],
                ],
            ],
        });
        expect(classifyTranslucentSort(mesh)).toBe(TRANSLUCENT_SORT_DYNAMIC);
    });
});
