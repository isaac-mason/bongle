import { registerAllShapes } from 'crashcat';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aabbs, type BlockShape, cube } from '../../../../src/core/voxels/block-collider';
import { buildTestRegistry, resetVoxelRegistry, type TestBlockSpec } from '../../../../src/core/voxels/test-helpers';
import { createVoxelSweepHit, sweepAabbVsVoxels } from '../../../../src/core/voxels/voxel-aabb-sweep';
import {
    CHUNK_SIZE,
    createChunk,
    createEmptyChunk,
    createVoxels,
    EMPTY_DATA,
    EMPTY_LIGHT,
    linkChunkNeighbors,
    setChunkBlock,
} from '../../../../src/core/voxels/voxels';

beforeAll(() => {
    registerAllShapes();
});

beforeEach(() => {
    resetVoxelRegistry();
});

function makeVoxels(blocks: TestBlockSpec[]) {
    const reg = buildTestRegistry(blocks);
    const voxels = createVoxels(reg);
    return { reg, voxels };
}

function place(voxels: ReturnType<typeof makeVoxels>['voxels'], wx: number, wy: number, wz: number, key: string) {
    // place exclusively in chunk 0,0,0, tests use small worlds.
    const cx = wx >> 4;
    const cy = wy >> 4;
    const cz = wz >> 4;
    const k = `${cx},${cy},${cz}`;
    let chunk = voxels.chunks.get(k);
    if (!chunk) {
        chunk = createChunk(cx, cy, cz);
        voxels.chunks.set(k, chunk);
    }
    setChunkBlock(chunk, wx & 15, wy & 15, wz & 15, key, voxels.registry);
}

// stub a range of chunk coords with empty-singleton chunks so the sweep
// doesn't see them as "unknown territory" (which now resolves to solid).
// existing chunks are left alone.
function stubArea(
    voxels: ReturnType<typeof makeVoxels>['voxels'],
    cxMin: number,
    cyMin: number,
    czMin: number,
    cxMax: number,
    cyMax: number,
    czMax: number,
) {
    for (let cz = czMin; cz <= czMax; cz++) {
        for (let cy = cyMin; cy <= cyMax; cy++) {
            for (let cx = cxMin; cx <= cxMax; cx++) {
                const k = `${cx},${cy},${cz}`;
                if (voxels.chunks.has(k)) continue;
                const stub = createEmptyChunk(cx, cy, cz);
                voxels.chunks.set(k, stub);
                linkChunkNeighbors(voxels, stub);
            }
        }
    }
}

describe('sweepAabbVsVoxels — cube path', () => {
    it('returns false when the swept range covers only known-empty chunks', () => {
        // surround the swept region with empty stubs so "no chunk"
        // doesn't get treated as solid (Minetest-style fallback) and
        // contaminate the test.
        const { voxels } = makeVoxels([{ id: 'stone', texId: 'stone' }]);
        stubArea(voxels, -1, -1, -1, 1, 1, 1);
        const out = createVoxelSweepHit();
        const hit = sweepAabbVsVoxels(voxels, 0, 5, 0, 0.5, 0.5, 0.5, 0, -1, 0, out);
        expect(hit).toBe(false);
        expect(out.axis).toBe(-1);
    });

    it('treats truly unknown chunks as one solid 16³ block', () => {
        // surround the body with empty stubs so only the target chunk
        // below is unknown. body falls from inside the stub at (0,0,0)
        // down toward unknown chunk (0,-1,0).
        const { voxels } = makeVoxels([{ id: 'stone', texId: 'stone' }]);
        stubArea(voxels, -1, 0, -1, 1, 1, 1); // stubs around the body, leaving cy=-1 unknown
        const out = createVoxelSweepHit();
        // body bottom at y=10, fall -15. unknown chunk (0,-1,0) spans
        // world y∈[-16,0]; its +Y face is at y=0. distance=10, toi=10/15.
        const hit = sweepAabbVsVoxels(voxels, 0.5, 10.5, 0.5, 0.5, 0.5, 0.5, 0, -15, 0, out);
        expect(hit).toBe(true);
        expect(out.axis).toBe(1); // Y
        expect(out.sign).toBe(1); // hit from +Y side
        expect(out.toi).toBeCloseTo(10 / 15, 6);
        // hit reports the chunk corner; box spans the full chunk AABB.
        expect(out.vx).toBe(0);
        expect(out.vy).toBe(-CHUNK_SIZE);
        expect(out.vz).toBe(0);
        expect(out.boxMaxY).toBe(0);
        expect(out.boxMinY).toBe(-CHUNK_SIZE);
    });

    it('passes through an empty-stub chunk and hits a real block beyond it', () => {
        // body falls through known-empty stubs onto a real floor block.
        const { voxels } = makeVoxels([{ id: 'stone', texId: 'stone' }]);
        stubArea(voxels, -1, -1, -1, 1, 1, 1);
        // floor block at world (0,-1,0), its top is at y=0.
        place(voxels, 0, -1, 0, 'stone');
        const stubChunk = voxels.chunks.get('0,0,0')!;
        // stub shares the singletons (no COW happened because we didn't write).
        expect(stubChunk.data).toBe(EMPTY_DATA);
        expect(stubChunk.light).toBe(EMPTY_LIGHT);

        const out = createVoxelSweepHit();
        const hit = sweepAabbVsVoxels(voxels, 0.5, 5.5, 0.5, 0.5, 0.5, 0.5, 0, -10, 0, out);
        expect(hit).toBe(true);
        expect(out.axis).toBe(1);
        expect(out.sign).toBe(1);
        expect(out.toi).toBeCloseTo(0.5, 6);
        expect(out.vy).toBe(-1); // landed on the real block at y=-1
    });

    it('falls onto a single cube floor', () => {
        const { voxels } = makeVoxels([{ id: 'stone', texId: 'stone' }]);
        // floor at y=0 (cube spans y=[0,1])
        place(voxels, 0, 0, 0, 'stone');
        const out = createVoxelSweepHit();
        // character at (0.5, 5.5, 0.5), center; bottom at y=5. fall by -10.
        const hit = sweepAabbVsVoxels(voxels, 0.5, 5.5, 0.5, 0.5, 0.5, 0.5, 0, -10, 0, out);
        expect(hit).toBe(true);
        expect(out.axis).toBe(1); // Y
        expect(out.sign).toBe(1); // hit from +Y side
        // distance: bottom(5) - top(1) = 4; toi = 4/10 = 0.4
        expect(out.toi).toBeCloseTo(0.4, 6);
        expect(out.vx).toBe(0);
        expect(out.vy).toBe(0);
        expect(out.vz).toBe(0);
        expect(out.subAabbIndex).toBe(-1);
    });

    it('walks into a wall on +X', () => {
        const { voxels } = makeVoxels([{ id: 'stone', texId: 'stone' }]);
        place(voxels, 3, 0, 0, 'stone');
        const out = createVoxelSweepHit();
        // character at (0, 0.5, 0.5), half=0.5; +X face at 0.5; wall +X face at 3.
        // toi = 2.5 / 5 = 0.5
        const hit = sweepAabbVsVoxels(voxels, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 5, 0, 0, out);
        expect(hit).toBe(true);
        expect(out.axis).toBe(0);
        expect(out.sign).toBe(-1);
        expect(out.toi).toBeCloseTo(0.5, 6);
    });

    it('picks the closest of multiple cubes', () => {
        const { voxels } = makeVoxels([{ id: 'stone', texId: 'stone' }]);
        place(voxels, 0, 0, 0, 'stone'); // at floor
        place(voxels, 5, 0, 0, 'stone'); // farther wall
        const out = createVoxelSweepHit();
        // character at (-1, 0.5, 0.5) move +X by 10, should hit cube at x=0 first (toi: 0.5/10).
        const hit = sweepAabbVsVoxels(voxels, -1, 0.5, 0.5, 0.5, 0.5, 0.5, 10, 0, 0, out);
        expect(hit).toBe(true);
        expect(out.vx).toBe(0);
        expect(out.toi).toBeCloseTo(0.05, 6);
    });

    it('skips empty chunks', () => {
        const { voxels } = makeVoxels([{ id: 'stone', texId: 'stone' }]);
        // populate every chunk the swept envelope touches as empty,
        // unknown chunks are now treated as solid 16³ cells
        // (CONTENT_IGNORE), so any unloaded neighbour would register a hit
        // and mask the empty-chunk skip we're trying to verify.
        for (let cx = -1; cx <= 0; cx++) {
            for (let cy = -1; cy <= 0; cy++) {
                for (let cz = -1; cz <= 0; cz++) {
                    voxels.chunks.set(`${cx},${cy},${cz}`, createChunk(cx, cy, cz));
                }
            }
        }
        const out = createVoxelSweepHit();
        const hit = sweepAabbVsVoxels(voxels, 0, 5, 0, 0.5, 0.5, 0.5, 0, -10, 0, out);
        expect(hit).toBe(false);
    });
});

describe('sweepAabbVsVoxels — aabbs path', () => {
    it('lands on a half-slab', () => {
        const slab: BlockShape = aabbs([[0, 0, 0, 1, 0.5, 1]]); // bottom-half slab
        const { voxels } = makeVoxels([
            { id: 'air', texId: 'air' },
            { id: 'slab', texId: 'stone', shape: slab },
        ]);
        place(voxels, 0, 0, 0, 'slab');
        const out = createVoxelSweepHit();
        // character at (0.5, 5.5, 0.5) falling, bottom at 5, slab top at 0.5.
        // toi = (5 - 0.5) / 10 = 0.45
        const hit = sweepAabbVsVoxels(voxels, 0.5, 5.5, 0.5, 0.5, 0.5, 0.5, 0, -10, 0, out);
        expect(hit).toBe(true);
        expect(out.axis).toBe(1);
        expect(out.sign).toBe(1);
        expect(out.toi).toBeCloseTo(0.45, 6);
        expect(out.subAabbIndex).toBe(0);
        expect(out.boxMaxY).toBe(0.5); // slab top
    });

    it('stair: lands on the top step from above', () => {
        // stair = bottom slab + back step (back-half top slab).
        const stair: BlockShape = aabbs([
            [0, 0, 0, 1, 0.5, 1], // bottom slab
            [0, 0.5, 0.5, 1, 1, 1], // back step (z>=0.5)
        ]);
        const { voxels } = makeVoxels([
            { id: 'air', texId: 'air' },
            { id: 'stair', texId: 'stone', shape: stair },
        ]);
        place(voxels, 0, 0, 0, 'stair');
        const out = createVoxelSweepHit();
        // character standing over the back step (z=0.75) falling, bottom at 5 m, top of step at y=1.
        const hit = sweepAabbVsVoxels(voxels, 0.5, 5.5, 0.75, 0.5, 0.5, 0.25, 0, -10, 0, out);
        expect(hit).toBe(true);
        expect(out.axis).toBe(1);
        expect(out.sign).toBe(1);
        // bottom(5) - back-step top(1) = 4 → toi=0.4
        expect(out.toi).toBeCloseTo(0.4, 6);
        expect(out.subAabbIndex).toBe(1); // back step
    });

    it('stair: walking sideways into bottom slab from +X', () => {
        const stair: BlockShape = aabbs([
            [0, 0, 0, 1, 0.5, 1],
            [0, 0.5, 0.5, 1, 1, 1],
        ]);
        const { voxels } = makeVoxels([
            { id: 'air', texId: 'air' },
            { id: 'stair', texId: 'stone', shape: stair },
        ]);
        place(voxels, 0, 0, 0, 'stair');
        const out = createVoxelSweepHit();
        // character at x=2, y=0.25 (so y range [0.0, 0.5], only overlaps bottom slab),
        // moving toward -X by 5. half-extent x = 0.4 → -X face at 1.6; bottom slab +X face = 1.
        // toi = (1.6 - 1) / 5 = 0.12
        const hit = sweepAabbVsVoxels(voxels, 2, 0.25, 0.5, 0.4, 0.2, 0.4, -5, 0, 0, out);
        expect(hit).toBe(true);
        expect(out.axis).toBe(0);
        expect(out.sign).toBe(1);
        expect(out.toi).toBeCloseTo(0.12, 6);
        expect(out.subAabbIndex).toBe(0); // bottom slab
    });

    it('does not hit a slab in front above its top', () => {
        const slab: BlockShape = aabbs([[0, 0, 0, 1, 0.5, 1]]);
        const { voxels } = makeVoxels([
            { id: 'air', texId: 'air' },
            { id: 'slab', texId: 'stone', shape: slab },
        ]);
        place(voxels, 3, 0, 0, 'slab');
        const out = createVoxelSweepHit();
        // character at y=2 (above slab top of 0.5), walks +X. should miss.
        const hit = sweepAabbVsVoxels(voxels, 0, 2, 0.5, 0.5, 0.5, 0.5, 5, 0, 0, out);
        expect(hit).toBe(false);
    });
});

describe('sweepAabbVsVoxels — explicit cube collapse', () => {
    it('explicit cube() shape uses cid=0 fast path', () => {
        const { voxels } = makeVoxels([
            { id: 'air', texId: 'air' },
            { id: 'stone', texId: 'stone', shape: cube() },
        ]);
        place(voxels, 0, 0, 0, 'stone');
        const out = createVoxelSweepHit();
        const hit = sweepAabbVsVoxels(voxels, 0.5, 5.5, 0.5, 0.5, 0.5, 0.5, 0, -10, 0, out);
        expect(hit).toBe(true);
        expect(out.subAabbIndex).toBe(-1); // cube path
    });
});

describe('sweepAabbVsVoxels — multi-chunk', () => {
    it('finds collisions across chunk boundary', () => {
        const { voxels } = makeVoxels([{ id: 'stone', texId: 'stone' }]);
        // floor at y=0 spanning x=[15,16] which crosses cx=0 and cx=1.
        place(voxels, 15, 0, 0, 'stone');
        place(voxels, 16, 0, 0, 'stone');
        const out = createVoxelSweepHit();
        // character at (15.5, 5.5, 0.5) falls onto the floor, should pick whichever cube is below.
        const hit = sweepAabbVsVoxels(voxels, 15.5, 5.5, 0.5, 0.5, 0.5, 0.5, 0, -10, 0, out);
        expect(hit).toBe(true);
        expect(out.axis).toBe(1);
    });
});
