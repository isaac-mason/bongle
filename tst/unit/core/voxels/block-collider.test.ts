import { registerAllShapes, ShapeType } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aabbs, type BlockShapeAabbs, blockShapeToShape, cube, rotateY } from '../../../../src/core/voxels/block-collider';
import { SHAPE_AABBS, SHAPE_CUBE } from '../../../../src/core/voxels/block-registry';
import { buildTestRegistry, resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    resetVoxelRegistry();
});

// ── builder helpers ─────────────────────────────────────────────────

describe('builder helpers', () => {
    it('cube creates a BlockShapeCube', () => {
        expect(cube()).toEqual({ type: 'cube' });
    });

    it('aabbs creates a BlockShapeAabbs', () => {
        const s = aabbs([[0, 0, 0, 1, 0.5, 1]]);
        expect(s.type).toBe('aabbs');
        expect(s.boxes).toEqual([[0, 0, 0, 1, 0.5, 1]]);
    });
});

// ── rotateY ─────────────────────────────────────────────────────────

describe('rotateY', () => {
    describe('cube', () => {
        it('any rotation returns the same shape (identity)', () => {
            const s = cube();
            for (let steps = 0; steps < 4; steps++) {
                expect(rotateY(s, steps)).toBe(s);
            }
        });
    });

    describe('aabbs', () => {
        it('0 steps returns same shape', () => {
            const s = aabbs([[0, 0, 0, 1, 0.5, 1]]);
            expect(rotateY(s, 0)).toBe(s);
        });

        it('rotates each box around block center, renormalising min/max', () => {
            // bottom slab: [0, 0, 0, 1, 0.5, 1]. 1 step CW around center (0.5, y, 0.5).
            // (x,y,z) → (z, y, 1-x); so (0,0,0)→(0,0,1) and (1,0.5,1)→(1,0.5,0).
            // after renormalising: [0, 0, 0, 1, 0.5, 1] (unchanged because the slab
            // is symmetric in X/Z).
            const slab = aabbs([[0, 0, 0, 1, 0.5, 1]]);
            const r = rotateY(slab, 1) as BlockShapeAabbs;
            expect(r.type).toBe('aabbs');
            expect(r.boxes[0]).toEqual([0, 0, 0, 1, 0.5, 1]);
        });

        it('rotates back-half slab to swap z extents', () => {
            // back step: [0, 0.5, 0.5, 1, 1, 1]. 1 step CW: (x,y,z)→(z,y,1-x).
            // (0, 0.5, 0.5)→(0.5, 0.5, 1); (1, 1, 1)→(1, 1, 0).
            // renormalised: [0.5, 0.5, 0, 1, 1, 1], back step becomes the +x-half step.
            const back = aabbs([[0, 0.5, 0.5, 1, 1, 1]]);
            const r = rotateY(back, 1) as BlockShapeAabbs;
            expect(r.boxes[0]).toEqual([0.5, 0.5, 0, 1, 1, 1]);
        });

        it('rotates a full stair (2 boxes)', () => {
            const stair = aabbs([
                [0, 0, 0, 1, 0.5, 1], // bottom slab
                [0, 0.5, 0.5, 1, 1, 1], // back step
            ]);
            const r = rotateY(stair, 1) as BlockShapeAabbs;
            expect(r.boxes).toEqual([
                [0, 0, 0, 1, 0.5, 1],
                [0.5, 0.5, 0, 1, 1, 1],
            ]);
        });

        it('4 steps is identity', () => {
            const s = aabbs([[0, 0.5, 0.5, 1, 1, 1]]);
            const r = rotateY(s, 4) as BlockShapeAabbs;
            expect(r.boxes[0]).toEqual([0, 0.5, 0.5, 1, 1, 1]);
        });

        it('negative steps normalize', () => {
            const s = aabbs([[0, 0.5, 0.5, 1, 1, 1]]);
            const a = rotateY(s, -1) as BlockShapeAabbs;
            const b = rotateY(s, 3) as BlockShapeAabbs;
            expect(a.boxes[0]).toEqual(b.boxes[0]);
        });
    });
});

// ── blockShapeToShape ───────────────────────────────────────────────

describe('blockShapeToShape', () => {
    it('aabbs with one box → transformed(box) when not centered, or box at origin', () => {
        const s = blockShapeToShape(aabbs([[0, 0, 0, 1, 0.5, 1]]));
        // bottom slab is centered at (0.5, 0.25, 0.5), so it gets wrapped
        // in a transformed shape.
        expect(s.type).toBe(ShapeType.TRANSFORMED);
    });

    it('aabbs with multiple boxes → static compound', () => {
        const s = blockShapeToShape(
            aabbs([
                [0, 0, 0, 1, 0.5, 1],
                [0, 0.5, 0.5, 1, 1, 1],
            ]),
        );
        expect(s.type).toBe(ShapeType.STATIC_COMPOUND);
    });

    it('rotated stair aabbs → static compound', () => {
        const stair = aabbs([
            [0, 0, 0, 1, 0.5, 1],
            [0, 0.5, 0.5, 1, 1, 1],
        ]);
        const rotated = rotateY(stair, 1);
        const s = blockShapeToShape(rotated as BlockShapeAabbs);
        expect(s.type).toBe(ShapeType.STATIC_COMPOUND);
    });
});

// ── registry per-shape data round-trip ──────────────────────────────

describe('block-registry per-shape data', () => {
    it('explicit cube collapses to colliderId=0 fast path', () => {
        const reg = buildTestRegistry([{ id: 'stone', texId: 'stone', shape: cube() }]);
        const sid = reg.keyToState.get('stone')!;
        expect(reg.colliderId[sid]).toBe(0);
        // index 0 is the cube sentinel, shapeKind[0] holds SHAPE_CUBE.
        expect(reg.shapeKind[0]).toBe(SHAPE_CUBE);
    });

    it('aabbs stores boxes in shapeAabbs and builds a crashcat shape', () => {
        const stair = aabbs([
            [0, 0, 0, 1, 0.5, 1],
            [0, 0.5, 0.5, 1, 1, 1],
        ]);
        const reg = buildTestRegistry([{ id: 'stairs', texId: 'stone', shape: stair }]);
        const sid = reg.keyToState.get('stairs')!;
        const cid = reg.colliderId[sid]!;
        expect(cid).toBeGreaterThan(0);
        expect(reg.shapeKind[cid]).toBe(SHAPE_AABBS);
        expect(reg.shapeAabbs[cid]).toEqual(stair.boxes);
        expect(reg.colliderShapes[cid]!.type).toBe(ShapeType.STATIC_COMPOUND);
    });

    it('no shape: colliderId=0 (implicit cube fast path)', () => {
        const reg = buildTestRegistry([{ id: 'stone', texId: 'stone' }]);
        const sid = reg.keyToState.get('stone')!;
        expect(reg.colliderId[sid]).toBe(0);
    });
});
