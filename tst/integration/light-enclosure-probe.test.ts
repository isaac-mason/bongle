// Repro: 2x2 hut, 2-high walls incl. corners, roof.
//   break+replace ROOF  -> darkens (vertical sky path)
//   break+replace WALL  -> reportedly does NOT darken (sideways sky path)
import { beforeEach, describe, expect, it } from 'vitest';
import { flushPendingLight, getSky, propagateAllLight } from '../../src/core/voxels/light';
import { buildTestRegistry, resetVoxelRegistry } from '../../src/core/voxels/test-helpers';
import type { Voxels } from '../../src/core/voxels/voxels';
import { chunkKey, createVoxels, createVoxelsAuthority, setBlock, voxelIndex } from '../../src/core/voxels/voxels';

beforeEach(() => resetVoxelRegistry());

function makeVoxels(): Voxels {
    const v = createVoxels(buildTestRegistry([{ id: 'stone', texId: 'stone' }]));
    v.authority = createVoxelsAuthority();
    return v;
}

// footprint x/z 6..9; interior 2x2 at x/z 7..8; walls y=7,8; floor y=6; roof y=9
function buildHut(v: Voxels): void {
    for (let x = 6; x <= 9; x++) {
        for (let z = 6; z <= 9; z++) {
            setBlock(v, x, 6, z, 'stone'); // floor
            setBlock(v, x, 9, z, 'stone'); // roof
            const ring = x === 6 || x === 9 || z === 6 || z === 9;
            if (ring) {
                setBlock(v, x, 7, z, 'stone'); // wall row 1
                setBlock(v, x, 8, z, 'stone'); // wall row 2 ("1 block up")
            }
        }
    }
}

/** sky in the 2x2x2 interior */
function interiorSky(v: Voxels): number[] {
    const c = v.chunks.get(chunkKey(0, 0, 0))!;
    const out: number[] = [];
    for (let y = 7; y <= 8; y++)
        for (let x = 7; x <= 8; x++) for (let z = 7; z <= 8; z++) out.push(getSky(c.light[voxelIndex(x, y, z)]!));
    return out;
}

/** ground truth: same blocks, baked from scratch */
function baked(v: Voxels): number[] {
    const b = makeVoxels();
    const src = v.chunks.get(chunkKey(0, 0, 0))!;
    for (let i = 0; i < src.data.length; i++) {
        const key = src.paletteKeys[src.data[i]!]!;
        if (key && key !== 'air') setBlock(b, i & 15, i >> 8, (i >> 4) & 15, key);
    }
    propagateAllLight(b);
    return interiorSky(b);
}

describe('2x2 hut: break and replace', () => {
    it('sealed hut interior is dark', () => {
        const v = makeVoxels();
        buildHut(v);
        flushPendingLight(v);
        expect(interiorSky(v)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('ROOF: break then replace darkens again', () => {
        const v = makeVoxels();
        buildHut(v);
        flushPendingLight(v);

        setBlock(v, 7, 9, 7, 'air');
        flushPendingLight(v);
        expect(Math.max(...interiorSky(v))).toBeGreaterThan(0);

        setBlock(v, 7, 9, 7, 'stone');
        flushPendingLight(v);
        expect(interiorSky(v)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('WALL one block up: break then replace darkens again', () => {
        const v = makeVoxels();
        buildHut(v);
        flushPendingLight(v);

        setBlock(v, 7, 8, 6, 'air'); // north wall, upper row
        flushPendingLight(v);
        expect(Math.max(...interiorSky(v))).toBeGreaterThan(0);

        setBlock(v, 7, 8, 6, 'stone');
        flushPendingLight(v);
        expect(interiorSky(v)).toEqual(baked(v));
        expect(interiorSky(v)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });
});
