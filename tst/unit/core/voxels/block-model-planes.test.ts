// ── hash geometry + the staged-plant pattern ────────────────────────

import { registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { block, tile } from '../../../../src/core/registry';
import * as blockModel from '../../../../src/core/voxels/block-model';
import * as blockState from '../../../../src/core/voxels/block-state';
import { CullType, MaterialType } from '../../../../src/core/voxels/blocks';
import { resetVoxelRegistry } from '../../../../src/core/voxels/test-helpers';

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    resetVoxelRegistry();
});

const aTile = () => tile('test:hash', { src: 'hash.png' });

describe('blockModel.hash', () => {
    it('builds four planes, front and back each', () => {
        expect(blockModel.hash(aTile())).toHaveLength(8);
    });

    it('keeps every plane axis-aligned, unlike cross', () => {
        for (const quad of blockModel.hash(aTile())) {
            const xs = new Set(quad.verts.map((v) => v[0]));
            const zs = new Set(quad.verts.map((v) => v[2]));
            // a plane is flat in exactly one of x / z; a diagonal is flat in neither.
            expect(xs.size === 1 || zs.size === 1).toBe(true);
        }
    });

    it('sits the planes on the quarter marks so neighbouring cells line up', () => {
        const offsets = new Set<number>();
        for (const quad of blockModel.hash(aTile())) {
            const xs = new Set(quad.verts.map((v) => v[0]));
            const zs = new Set(quad.verts.map((v) => v[2]));
            offsets.add(xs.size === 1 ? [...xs][0]! : [...zs][0]!);
        }
        expect([...offsets].sort()).toEqual([0.25, 0.75]);
    });

    it('caps the top below 1 so wind sway does not freeze at the tip', () => {
        // PLANT_WIND_SWAY weights the bend by fract(world.y); fract(N+1) is 0.
        const ys = blockModel.hash(aTile()).flatMap((q) => q.verts.map((v) => v[1]));
        expect(Math.max(...ys)).toBeLessThan(1);
    });

    it('keeps every vert strictly inside the cell so the block phases as one', () => {
        for (const quad of blockModel.hash(aTile())) {
            for (const [x, , z] of quad.verts) {
                expect(x).toBeGreaterThan(0);
                expect(x).toBeLessThan(1);
                expect(z).toBeGreaterThan(0);
                expect(z).toBeLessThan(1);
            }
        }
    });
});

describe('blockModel.hash with a lean', () => {
    it('tilts every plane outward at the top, roots in place', () => {
        const quads = blockModel.hash(aTile(), { lean: 20 });
        expect(quads).toHaveLength(8);
        for (const q of quads) {
            // the plane's axis is whichever of x/z its normal mostly points along
            const axis = Math.abs(q.normal[0]!) > Math.abs(q.normal[2]!) ? 0 : 2;
            const bottom = q.verts.filter((v) => v[1]! < 0.01);
            const top = q.verts.filter((v) => v[1]! > 0.5);
            expect(bottom).toHaveLength(2);
            expect(top).toHaveLength(2);
            const root = bottom[0]![axis]!;
            expect([0.25, 0.75]).toContainEqual(Number(root.toFixed(6)));
            const outward = Math.sign(root - 0.5);
            for (const v of top) expect(Math.sign(v[axis]! - root)).toBe(outward);
            // 20 degrees over 0.9 of height: the top overhangs its root by ~0.31
            expect(Math.abs(top[0]![axis]! - root)).toBeCloseTo(0.9 * Math.sin((20 * Math.PI) / 180), 5);
        }
    });

    it('takes a leaned plane out of the cardinal facings, so the cone-cull cannot drop it', () => {
        for (const q of blockModel.hash(aTile(), { lean: 20 })) {
            expect(Math.max(...q.normal.map(Math.abs))).toBeLessThan(0.999);
        }
    });

    it('is the upright hash at lean 0', () => {
        expect(JSON.stringify(blockModel.hash(aTile(), { lean: 0 }))).toBe(JSON.stringify(blockModel.hash(aTile())));
    });
});

describe('blockModel.cross with a height', () => {
    it('reaches 0.1 short of the height and samples the bottom of a taller tile', () => {
        const quads = blockModel.cross(aTile(), { height: 1.5 });
        expect(quads).toHaveLength(4);
        for (const q of quads) {
            const ys = q.verts.map((v) => v[1]!);
            expect(Math.max(...ys)).toBeCloseTo(1.4, 6);
            expect(Math.min(...ys)).toBe(0);
            // a 2-block tile, the plane shows its bottom 1.4 blocks: v from 0.3 to 1
            const vs = q.uvs!.map((uv) => uv[1]);
            expect(Math.min(...vs)).toBeCloseTo(0.3, 6);
            expect(Math.max(...vs)).toBe(1);
        }
    });

    it('is unchanged at the default height', () => {
        expect(JSON.stringify(blockModel.cross(aTile(), { height: 1 }))).toBe(JSON.stringify(blockModel.cross(aTile())));
        for (const q of blockModel.cross(aTile())) expect(Math.min(...q.uvs!.map((uv) => uv[1]))).toBe(0);
    });
});

describe('blockModel.plus', () => {
    it('builds two planes, front and back each', () => {
        expect(blockModel.plus(aTile())).toHaveLength(4);
    });

    it('crosses on the centre line', () => {
        const offsets = new Set<number>();
        for (const quad of blockModel.plus(aTile())) {
            const xs = new Set(quad.verts.map((v) => v[0]));
            const zs = new Set(quad.verts.map((v) => v[2]));
            offsets.add(xs.size === 1 ? [...xs][0]! : [...zs][0]!);
        }
        expect([...offsets]).toEqual([0.5]);
    });

    it('stays axis-aligned, so it lines up across cells where cross does not', () => {
        for (const quad of blockModel.plus(aTile())) {
            const xs = new Set(quad.verts.map((v) => v[0]));
            const zs = new Set(quad.verts.map((v) => v[2]));
            expect(xs.size === 1 || zs.size === 1).toBe(true);
        }
    });

    it('carries the same sway and in-cell constraints as hash', () => {
        const quads = blockModel.plus(aTile());
        expect(Math.max(...quads.flatMap((q) => q.verts.map((v) => v[1])))).toBeLessThan(1);
        for (const quad of quads) {
            for (const [x, , z] of quad.verts) {
                expect(x).toBeGreaterThan(0);
                expect(x).toBeLessThan(1);
                expect(z).toBeGreaterThan(0);
                expect(z).toBeLessThan(1);
            }
        }
    });

    it('is half the geometry of hash, not a different arrangement of it', () => {
        expect(blockModel.plus(aTile())).toHaveLength(blockModel.hash(aTile()).length / 2);
    });
});

// The mesher bins an exactly-axis-aligned normal into a cardinal facing slice,
// and the opaque/transparent passes back-face cone-cull whole slices per chunk.
// A normal that disagrees with its winding puts the quad in the slice opposite
// the side it renders from, so it is culled exactly when it should be drawn and
// the planes pop in and out as the camera moves.
describe('axis-aligned plane normals agree with their winding', () => {
    // right-handed CCW normal of a quad, the convention `box` uses.
    const windingNormal = (verts: readonly (readonly number[])[]) => {
        const [a, b, c] = [verts[0]!, verts[1]!, verts[2]!];
        const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
        const e2 = [c[0]! - b[0]!, c[1]! - b[1]!, c[2]! - b[2]!];
        const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
        const len = Math.hypot(...n);
        return n.map((v) => v / len);
    };

    for (const [name, build] of [
        ['hash', blockModel.hash],
        ['plus', blockModel.plus],
    ] as const) {
        it(`${name} declares the winding normal, so it lands in the right facing slice`, () => {
            for (const quad of build(aTile())) {
                const expected = windingNormal(quad.verts);
                for (const axis of [0, 1, 2]) {
                    expect(quad.normal[axis]!).toBeCloseTo(expected[axis]!, 6);
                }
            }
        });
    }

    it('box agrees too, which is where the convention comes from', () => {
        for (const quad of blockModel.box([0, 0, 0], [1, 1, 1], { all: aTile() })) {
            const expected = windingNormal(quad.verts);
            for (const axis of [0, 1, 2]) {
                expect(quad.normal[axis]!).toBeCloseTo(expected[axis]!, 6);
            }
        }
    });
});

describe('blockModel.fluff', () => {
    const blob = () => tile('test:blob', { src: 'blob.png' });

    it('builds four crossed planes, double-sided and unshaded, all on the one blob', () => {
        const t = blob();
        const quads = blockModel.fluff(t);
        expect(quads).toHaveLength(8);
        for (const q of quads) {
            expect(q.shade).toBe(false);
            expect(q.tile.id).toBe(t.id);
        }
    });

    it('spans two blocks in both directions, half a block past the cell each way', () => {
        // measured with no lean, so the extents are axis-aligned
        for (const q of blockModel.fluff(blob(), { lean: 0 })) {
            const [a, b, c] = q.verts;
            expect(Math.hypot(b![0]! - a![0]!, b![2]! - a![2]!)).toBeCloseTo(2, 5);
            expect(Math.abs(c![1]! - b![1]!)).toBeCloseTo(2, 5);
            const ys = q.verts.map((v) => v[1]!);
            expect(Math.min(...ys)).toBeCloseTo(-0.5, 5);
            expect(Math.max(...ys)).toBeCloseTo(1.5, 5);
        }
    });

    it('leans every plane, one pair each way, so stacked blocks never share a plane', () => {
        const quads = blockModel.fluff(blob());
        const ys = quads.map((q) => q.normal[1]!);
        // sin(10 deg) = 0.17; both signs present (the pairs splay apart)
        for (const y of ys) expect(Math.abs(y)).toBeCloseTo(Math.sin((blockModel.FLUFF_LEAN_DEG * Math.PI) / 180), 3);
        expect(ys.some((y) => y > 0) && ys.some((y) => y < 0)).toBe(true);
        // and a negative lean mirrors the splay
        const mirrored = blockModel.fluff(blob(), { lean: -blockModel.FLUFF_LEAN_DEG });
        for (let i = 0; i < quads.length; i++) expect(mirrored[i]!.normal[1]).toBeCloseTo(-quads[i]!.normal[1]!, 6);
    });

    it('stays inside the mesher position range, so nothing is clamped', () => {
        // posEncode covers [-8, +24) voxels chunk-local; a block sitting at the
        // far corner of a chunk must not push a vert past that.
        for (const quad of blockModel.fluff(blob())) {
            for (const component of quad.verts.flat()) {
                expect(component).toBeGreaterThan(-8);
                expect(component).toBeLessThan(8);
            }
        }
    });

    it('keeps every normal off-axis, so the cone-cull never drops it', () => {
        // classifyFacing bins |axis| > 0.999 into a cardinal slice, and cardinal
        // slices get back-face cone-culled per chunk. An axis-aligned fluff
        // normal would make the planes pop as chunks cross the camera plane.
        for (const quad of blockModel.fluff(blob())) {
            const maxAxis = Math.max(...quad.normal.map(Math.abs));
            expect(maxAxis).toBeLessThan(0.999);
        }
    });

    it('never shares a plane with any neighbour: no lattice translation lies in a leaned 22.5 degree plane', () => {
        for (const q of blockModel.fluff(blob())) {
            const [nx, ny, nz] = q.normal;
            for (const [dx, dy, dz] of [
                [1, 0, 0],
                [0, 0, 1],
                [0, 1, 0],
                [1, 0, 1],
                [1, 0, -1],
                [1, 1, 0],
                [0, 1, 1],
                [1, 1, 1],
                [2, 0, 1],
                [1, 0, 2],
            ]) {
                expect(Math.abs(nx * dx + ny * dy + nz * dz)).toBeGreaterThan(0.05);
            }
        }
    });

    it('survives the rotate helpers with its shade flag intact', () => {
        for (const q of blockModel.rotateY(blockModel.fluff(blob()), 1)) expect(q.shade).toBe(false);
    });
});

describe('staged plant on block()', () => {
    const stageTiles = (count: number) =>
        Array.from({ length: count }, (_, i) => tile(`test:stage_${i + 1}`, { src: `stage_${i + 1}.png` }));

    const staged = (tiles: ReturnType<typeof stageTiles>) =>
        block('test:wheat', {
            states: blockState.create({ age: blockState.int(1, tiles.length) }),
            defaultState: { age: 1 },
            model: ({ age }) => ({ type: 'custom' as const, quads: blockModel.hash(tiles[age - 1]!) }),
            cull: CullType.SELF,
            collision: false,
            lightOpacity: 0,
            material: MaterialType.TRANSPARENT,
        });

    it('gives every stage its own state key', () => {
        const wheat = staged(stageTiles(4));
        const keys = [1, 2, 3, 4].map((age) => wheat.stateKey({ age }));
        expect(new Set(keys).size).toBe(4);
    });

    it('defaults to the first stage', () => {
        const wheat = staged(stageTiles(4));
        expect(wheat.defaultKey()).toBe(wheat.stateKey({ age: 1 }));
    });

    it('draws a different tile per stage', () => {
        const tiles = stageTiles(3);
        const wheat = staged(tiles);
        const tileOf = (age: number) => {
            const produced = wheat.def.model!({ age });
            const model = Array.isArray(produced) ? produced[0]! : produced;
            if (model.type !== 'custom') throw new Error('expected a custom quad model');
            return model.quads[0]!.tile;
        };
        expect(tileOf(1)).toBe(tiles[0]);
        expect(tileOf(2)).toBe(tiles[1]);
        expect(tileOf(3)).toBe(tiles[2]);
    });
});
