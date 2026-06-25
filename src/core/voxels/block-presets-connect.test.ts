// ── pane / fence neighbour-update tests ────────────────────────────
//
// uses the real pane()/fence()/cube() factories from block-presets so
// the test exercises the production onNeighbourUpdate logic against
// the runBlockHooks driver, not a hand-copy of it.

import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllShapes } from 'crashcat';
import { AIR, buildBlockRegistry } from './block-registry';
import { type BlockDef, type BlockHandle, type BlockTextureDef } from './blocks';
import { cube, fence, pane } from './block-presets';
import { runNeighbourRecompute } from './block-hooks';
import { clearVoxelChanges, createVoxels, createVoxelsAuthority, getBlockState, setBlock } from './voxels';
import { SetBlockFlags } from './block-flags';

beforeAll(() => {
    registerAllShapes();
});

// ── shared registry ─────────────────────────────────────────────────

const glassTex: BlockTextureDef = {
    id: 'glass',
    dependency: { registry: 'blockTextures', id: 'glass' },
    frames: ['glass.png'],
    fps: 1,
    interpolate: false,
};
const oakTex: BlockTextureDef = {
    id: 'oak',
    dependency: { registry: 'blockTextures', id: 'oak' },
    frames: ['oak.png'],
    fps: 1,
    interpolate: false,
};
const stoneTex: BlockTextureDef = {
    id: 'stone',
    dependency: { registry: 'blockTextures', id: 'stone' },
    frames: ['stone.png'],
    fps: 1,
    interpolate: false,
};

const paneHandle = pane('test:pane', { all: { texture: glassTex } }) as BlockHandle;
const fenceHandle = fence('test:fence', { all: { texture: oakTex } }) as BlockHandle;
const stoneHandle = cube('test:stone', { all: { texture: stoneTex } }) as BlockHandle;

const defs = new Map<string, BlockDef>([
    [paneHandle.id, paneHandle._def],
    [fenceHandle.id, fenceHandle._def],
    [stoneHandle.id, stoneHandle._def],
]);
const handles = new Map<string, BlockHandle>([
    [paneHandle.id, paneHandle as BlockHandle],
    [fenceHandle.id, fenceHandle as BlockHandle],
    [stoneHandle.id, stoneHandle as BlockHandle],
]);
const textures = new Map<string, BlockTextureDef>([
    [glassTex.id, glassTex],
    [oakTex.id, oakTex],
    [stoneTex.id, stoneTex],
]);

function makeVoxels() {
    const registry = buildBlockRegistry(defs, handles, textures);
    const voxels = createVoxels(registry);
    voxels.authority = createVoxelsAuthority();
    return voxels;
}

type ConnectProps = { north: boolean; east: boolean; south: boolean; west: boolean };

function decodeAt(
    voxels: ReturnType<typeof makeVoxels>,
    wx: number,
    wy: number,
    wz: number,
): { id: 'air' } | ({ id: string } & Partial<ConnectProps>) {
    const id = getBlockState(voxels, wx, wy, wz);
    if (id === AIR) return { id: 'air' };
    const blockIdx = voxels.registry.stateToBlockIndex[id]!;
    const handle = voxels.registry.handles[blockIdx]!;
    const local = voxels.registry.stateToLocalIndex[id]!;
    if (handle.totalStates === 1) return { id: handle.id };
    return { id: handle.id, ...(handle.states.decode(local) as ConnectProps) };
}

// ── tests ───────────────────────────────────────────────────────────

describe('pane neighbour update', () => {
    it('isolated pane: all arms collapse to false (post only)', () => {
        const voxels = makeVoxels();

        setBlock(voxels, 8, 8, 8, paneHandle.defaultKey(), SetBlockFlags.BULK);
        runNeighbourRecompute(voxels);

        expect(decodeAt(voxels, 8, 8, 8)).toMatchObject({
            id: paneHandle.id,
            north: false,
            east: false,
            south: false,
            west: false,
        });
    });

    it('two adjacent panes (east/west) connect to each other', () => {
        const voxels = makeVoxels();

        setBlock(voxels, 0, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
        setBlock(voxels, 1, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
        runNeighbourRecompute(voxels);

        expect(decodeAt(voxels, 0, 0, 0)).toMatchObject({ east: true, west: false, north: false, south: false });
        expect(decodeAt(voxels, 1, 0, 0)).toMatchObject({ east: false, west: true, north: false, south: false });
    });

    it('two adjacent panes (north/south) connect to each other', () => {
        const voxels = makeVoxels();

        setBlock(voxels, 0, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
        setBlock(voxels, 0, 0, -1, paneHandle.defaultKey(), SetBlockFlags.BULK);
        runNeighbourRecompute(voxels);

        expect(decodeAt(voxels, 0, 0, 0)).toMatchObject({ north: true, south: false, east: false, west: false });
        expect(decodeAt(voxels, 0, 0, -1)).toMatchObject({ south: true, north: false, east: false, west: false });
    });

    it('three panes in a row: middle picks both arms, ends pick one', () => {
        const voxels = makeVoxels();

        setBlock(voxels, 0, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
        setBlock(voxels, 1, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
        setBlock(voxels, 2, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
        runNeighbourRecompute(voxels);

        expect(decodeAt(voxels, 0, 0, 0)).toMatchObject({ east: true, west: false });
        expect(decodeAt(voxels, 1, 0, 0)).toMatchObject({ east: true, west: true });
        expect(decodeAt(voxels, 2, 0, 0)).toMatchObject({ east: false, west: true });
    });

    it('pane connects to solid stone neighbour (cull=SOLID branch)', () => {
        const voxels = makeVoxels();

        setBlock(voxels, 0, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
        setBlock(voxels, 1, 0, 0, stoneHandle.defaultKey(), SetBlockFlags.BULK);
        runNeighbourRecompute(voxels);

        expect(decodeAt(voxels, 0, 0, 0)).toMatchObject({ east: true, west: false, north: false, south: false });
    });

    it('placing a pane between two existing panes — both ends re-recompute', () => {
        const voxels = makeVoxels();

        setBlock(voxels, 0, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
        setBlock(voxels, 2, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
        runNeighbourRecompute(voxels);

        expect(decodeAt(voxels, 0, 0, 0)).toMatchObject({ east: false, west: false });
        expect(decodeAt(voxels, 2, 0, 0)).toMatchObject({ east: false, west: false });

        setBlock(voxels, 1, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
        runNeighbourRecompute(voxels);

        expect(decodeAt(voxels, 0, 0, 0)).toMatchObject({ east: true, west: false });
        expect(decodeAt(voxels, 1, 0, 0)).toMatchObject({ east: true, west: true });
        expect(decodeAt(voxels, 2, 0, 0)).toMatchObject({ east: false, west: true });
    });

    it('pane does not connect to fence (different group flag)', () => {
        const voxels = makeVoxels();

        setBlock(voxels, 0, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
        setBlock(voxels, 1, 0, 0, fenceHandle.defaultKey(), SetBlockFlags.BULK);
        runNeighbourRecompute(voxels);

        expect(decodeAt(voxels, 0, 0, 0)).toMatchObject({ east: false });
        expect(decodeAt(voxels, 1, 0, 0)).toMatchObject({ west: false });
    });

    it('chunk boundary: panes spanning a chunk edge still connect', () => {
        const voxels = makeVoxels();

        // chunk size = 16. x=15 and x=16 land in different chunks.
        setBlock(voxels, 15, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
        setBlock(voxels, 16, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
        runNeighbourRecompute(voxels);

        expect(decodeAt(voxels, 15, 0, 0)).toMatchObject({ east: true });
        expect(decodeAt(voxels, 16, 0, 0)).toMatchObject({ west: true });
    });

    it('placing each pane individually (sequential VoxelEditCommand-style) still converges', () => {
        // mirrors the editor's per-click flow: BULK-set one op, drain
        // runNeighbourRecompute, repeat for the next click.
        const voxels = makeVoxels();

        setBlock(voxels, 0, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
        runNeighbourRecompute(voxels);

        setBlock(voxels, 1, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
        runNeighbourRecompute(voxels);

        setBlock(voxels, 2, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
        runNeighbourRecompute(voxels);

        expect(decodeAt(voxels, 0, 0, 0)).toMatchObject({ east: true, west: false });
        expect(decodeAt(voxels, 1, 0, 0)).toMatchObject({ east: true, west: true });
        expect(decodeAt(voxels, 2, 0, 0)).toMatchObject({ east: false, west: true });
    });

    it('placing 5 panes one per tick (with clearVoxelChanges between) still converges', () => {
        // matches the real server flow: each tick drains ops in
        // runNeighbourRecompute, Discovery.flush sends them to the client,
        // then clearVoxelChanges resets ops + cursors. so the next tick
        // starts from an empty op list.
        const voxels = makeVoxels();

        for (let i = 0; i < 5; i++) {
            setBlock(voxels, i, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
            runNeighbourRecompute(voxels);
            clearVoxelChanges(voxels.authority!.changes);
        }

        expect(decodeAt(voxels, 0, 0, 0)).toMatchObject({ east: true, west: false, north: false, south: false });
        expect(decodeAt(voxels, 1, 0, 0)).toMatchObject({ east: true, west: true, north: false, south: false });
        expect(decodeAt(voxels, 2, 0, 0)).toMatchObject({ east: true, west: true, north: false, south: false });
        expect(decodeAt(voxels, 3, 0, 0)).toMatchObject({ east: true, west: true, north: false, south: false });
        expect(decodeAt(voxels, 4, 0, 0)).toMatchObject({ east: false, west: true, north: false, south: false });
    });

    it('placing 5 panes one per tick — collects the ops the server would send each tick', () => {
        // same as above, but inspects the ops emitted each "tick" — those
        // are exactly what coalesceBlockOps would feed to the client. if
        // the corrected state for an earlier pane is missing from a tick's
        // ops trail, the client renders stale state until something else
        // touches that voxel.
        const voxels = makeVoxels();

        const tickOps: Array<{ wx: number; wy: number; wz: number; key: string }[]> = [];

        for (let i = 0; i < 5; i++) {
            setBlock(voxels, i, 0, 0, paneHandle.defaultKey(), SetBlockFlags.BULK);
            runNeighbourRecompute(voxels);

            // collect per-position last-state-key from this tick's ops
            const lastByPos = new Map<string, string>();
            for (const op of voxels.authority!.changes.ops) {
                if (op.kind !== 0) continue;
                const blockOp = op as {
                    wx: number;
                    wy: number;
                    wz: number;
                    data: number;
                    cx: number;
                    cy: number;
                    cz: number;
                    index: number;
                };
                const wx = blockOp.cx * 16 + (blockOp.index & 0xf);
                const wy = blockOp.cy * 16 + (blockOp.index >> 8);
                const wz = blockOp.cz * 16 + ((blockOp.index >> 4) & 0xf);
                const stateId = getBlockState(voxels, wx, wy, wz);
                const key = voxels.registry.stateToKey[stateId] ?? '?';
                lastByPos.set(`${wx},${wy},${wz}`, key);
            }
            tickOps.push(
                [...lastByPos.entries()].map(([pos, key]) => {
                    const [wx, wy, wz] = pos.split(',').map(Number) as [number, number, number];
                    return { wx, wy, wz, key };
                }),
            );

            clearVoxelChanges(voxels.authority!.changes);
        }

        // tick 4 (placing pane #5 at x=4): server must emit a corrected op
        // for pane #4 at x=3 — it transitioned from end-of-row (west-only)
        // to middle-of-row (east+west).
        const tick4Positions = new Set(tickOps[4]!.map((o) => `${o.wx},${o.wy},${o.wz}`));
        expect(tick4Positions).toContain('3,0,0');
        expect(tick4Positions).toContain('4,0,0');
    });
});
