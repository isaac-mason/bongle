import type { Input } from '../../client/input';
import type { ScriptContext } from '../../core/scene/scripts';
import * as Selection from '../../core/scene/selection';
import type { Voxels } from '../../core/voxels/voxels';
import { BLOCK_AIR, getBlock } from '../../core/voxels/voxels';
import type { VoxelOp } from '../blueprint';
import type { EditRoomStoreApi } from '../edit-room-store';
import { type Mask, testMask } from '../scene/mask';
import { playBulkEdit } from '../sounds';
import { commitVoxelOps } from '../voxel-edit';
import { advanceBrushStroke, type BrushStrokeState, createBrushStrokeState } from './utils/brush';

// the shared stroke harness is nested under `brush` so a smooth-specific field can be added
// later as a sibling without the parent EditorScript having to know
export type SmoothState = { brush: BrushStrokeState };
export function createSmoothState(): SmoothState {
    return { brush: createBrushStrokeState() };
}

const OPS_PER_PACKET = 4096;

function sendOps(ctx: ScriptContext, ops: VoxelOp[]): void {
    for (let i = 0; i < ops.length; i += OPS_PER_PACKET) {
        commitVoxelOps(ctx, ops.slice(i, i + OPS_PER_PACKET));
    }
}

// 5x5 gaussian kernel matching worldedit's default GaussianKernel(2, 1.0); columns without a
// surface drop out of the convolution and the remaining weights are re-normalised
const KERNEL_RADIUS = 2;
const KERNEL = new Float32Array([1, 4, 6, 4, 1, 4, 16, 24, 16, 4, 6, 24, 36, 24, 6, 4, 16, 24, 16, 4, 1, 4, 6, 4, 1]);

export function updateSmooth(
    state: SmoothState,
    store: EditRoomStoreApi,
    ctx: ScriptContext,
    input: Input,
    voxels: Voxels,
): void {
    advanceBrushStroke(state.brush, store, ctx, input, store.getState().smoothOptions, (accumulated) => {
        const { iterations, heightmapMask } = store.getState().smoothOptions;
        const { forward, reverse } = runSmooth(voxels, accumulated, iterations, heightmapMask);
        if (forward.length > 0) {
            store.getState().action({
                label: 'smooth',
                do() {
                    sendOps(ctx, forward);
                    playBulkEdit(ctx, forward, reverse);
                },
                undo() {
                    sendOps(ctx, reverse);
                    playBulkEdit(ctx, reverse, forward);
                },
            });
        }
    });
}

type Column = {
    wx: number;
    wz: number;
    /** lowest y in the footprint at this (x,z) */
    yLo: number;
    /** highest y in the footprint at this (x,z) */
    yHi: number;
    /** topmost y within [yLo..yHi] matching heightmapMask; null = empty */
    oldH: number | null;
    /** block at oldH, the fill used when raising the column */
    oldKey: string | null;
    /** running height during convolution, seeded from oldH, falling back to yLo - 1 for empty columns */
    h: number;
    /** scratch slot for the next iteration's value */
    hNext: number;
};

// worldedit-style smooth: projects the footprint to a per-(x,z) heightmap, iterates a 5x5
// gaussian, and emits raise/lower ops bounded by each column's footprint y range so the op
// never writes outside the user's stamp/selection. shared by the brush tool and `/smooth`.
export function runSmooth(
    voxels: Voxels,
    footprint: Selection.Selection,
    iterations: number,
    heightmapMask: Mask | null,
): { forward: VoxelOp[]; reverse: VoxelOp[] } {
    // (1) project to (x,z) columns and collect y range
    const cols = new Map<string, Column>();
    Selection.forEach(footprint, (wx, wy, wz) => {
        const k = `${wx},${wz}`;
        const existing = cols.get(k);
        if (!existing) {
            cols.set(k, { wx, wz, yLo: wy, yHi: wy, oldH: null, oldKey: null, h: 0, hNext: 0 });
        } else {
            if (wy < existing.yLo) existing.yLo = wy;
            if (wy > existing.yHi) existing.yHi = wy;
        }
    });
    if (cols.size === 0) return { forward: [], reverse: [] };

    // (2) sample world surface per column inside its y band
    const rng = Math.random;
    for (const c of cols.values()) {
        for (let y = c.yHi; y >= c.yLo; y--) {
            const key = getBlock(voxels, c.wx, y, c.wz);
            if (heightmapMask) {
                if (testMask(heightmapMask, voxels, c.wx, y, c.wz, rng)) {
                    c.oldH = y;
                    c.oldKey = key;
                    break;
                }
            } else {
                if (key !== BLOCK_AIR) {
                    c.oldH = y;
                    c.oldKey = key;
                    break;
                }
            }
        }
        c.h = c.oldH ?? c.yLo - 1;
    }

    // (3) iterate the 5x5 gaussian; unsampled cells and empty columns drop out and the kernel
    // re-normalises by the accumulated weight. worldedit uses 1 iteration by default; more
    // iterations approximate a larger sigma via repeated convolution.
    const passes = Math.max(1, Math.floor(iterations));
    for (let pass = 0; pass < passes; pass++) {
        for (const c of cols.values()) {
            let num = 0;
            let den = 0;
            for (let dz = -KERNEL_RADIUS; dz <= KERNEL_RADIUS; dz++) {
                for (let dx = -KERNEL_RADIUS; dx <= KERNEL_RADIUS; dx++) {
                    const w = KERNEL[(dz + KERNEL_RADIUS) * 5 + (dx + KERNEL_RADIUS)]!;
                    const nk = `${c.wx + dx},${c.wz + dz}`;
                    const n = cols.get(nk);
                    if (!n || n.oldH === null) continue;
                    num += w * n.h;
                    den += w;
                }
            }
            c.hNext = den > 0 ? num / den : c.h;
        }
        for (const c of cols.values()) c.h = c.hNext;
    }

    // (4) emit ops within each column's y band
    const forward: VoxelOp[] = [];
    const reverse: VoxelOp[] = [];
    for (const c of cols.values()) {
        if (c.oldH === null) continue;
        const newH = Math.max(c.yLo - 1, Math.min(c.yHi, Math.round(c.h)));
        const dH = newH - c.oldH;
        if (dH === 0) continue;

        if (dH > 0) {
            const fill = c.oldKey!;
            for (let y = c.oldH + 1; y <= newH; y++) {
                const cur = getBlock(voxels, c.wx, y, c.wz);
                if (cur === fill) continue;
                forward.push({ wx: c.wx, wy: y, wz: c.wz, key: fill });
                reverse.push({ wx: c.wx, wy: y, wz: c.wz, key: cur });
            }
        } else {
            for (let y = newH + 1; y <= c.oldH; y++) {
                const cur = getBlock(voxels, c.wx, y, c.wz);
                if (cur === BLOCK_AIR) continue;
                forward.push({ wx: c.wx, wy: y, wz: c.wz, key: BLOCK_AIR });
                reverse.push({ wx: c.wx, wy: y, wz: c.wz, key: cur });
            }
        }
    }

    return { forward, reverse };
}
