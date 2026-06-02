// smooth tool — worldedit-style heightmap gaussian.
//
// per (x,z) column inside the footprint we sample the topmost block that
// satisfies `heightmapMask` (any non-air when null), then run `iterations`
// passes of a 5×5 gaussian convolution over the heights, quantise back
// to ints, and raise/lower the column inside its vertical band:
//   raise → extend with the column's existing surface block
//   lower → clear to air
// raises/lowers are clamped to the column's footprint y range so the op
// never escapes the user's stamp/selection.
//
// the brush variant accumulates a 3D Selection of stamps during drag
// (mirrors `tools/brush.ts`) and commits once on release. the region
// command (`actions.smoothSelection`) shares `runSmooth()`.

import type { ScriptContext } from '../../core/scene/scripts';
import { send } from '../../core/scene/scripts';
import { VoxelEditCommand } from '../commands';
import type { Voxels } from '../../core/voxels/voxels';
import { BLOCK_AIR, getBlockKey } from '../../core/voxels/voxels';
import type { PointerState } from '../pointer-state';
import { pointerJustDown, pointerHeld, pointerJustUp, pointerJustRight } from '../pointer-state';
import type { Input } from '../../client/input';
import type { EditRoomStoreApi } from '../edit-room-store';
import * as Selection from '../../core/scene/selection';
import { buildShape } from '../scene/shapes';
import { testMask, type Mask } from '../scene/mask';
import type { VoxelOp } from '../blueprint';

const OPS_PER_PACKET = 4096;

function sendOps(ctx: ScriptContext, ops: VoxelOp[]): void {
    for (let i = 0; i < ops.length; i += OPS_PER_PACKET) {
        send(ctx, VoxelEditCommand, { ops: ops.slice(i, i + OPS_PER_PACKET) });
    }
}

// ── 5×5 gaussian kernel ────────────────────────────────────────────
// matches worldedit's default GaussianKernel(2, 1.0). columns without a
// surface drop out of the convolution (their weight is skipped and the
// remaining weights are re-normalised) — same as worldedit treating
// unsampled cells as edges.

const KERNEL_RADIUS = 2;
const KERNEL = new Float32Array([
    1, 4, 6, 4, 1,
    4, 16, 24, 16, 4,
    6, 24, 36, 24, 6,
    4, 16, 24, 16, 4,
    1, 4, 6, 4, 1,
]);

// ── stroke state (brush variant) ───────────────────────────────────

let _strokeActive = false;
let _lastCenter: [number, number, number] | null = null;
let _previewKey = '';

const STAMP_SCRATCH: Selection.Selection = Selection.create();

function previewKeyFor(
    center: [number, number, number],
    shape: string,
    size: number,
    height: number,
): string {
    return `${center[0]},${center[1]},${center[2]}|${shape}|${size}|${height}`;
}

// ── per-frame update ───────────────────────────────────────────────

export function updateSmooth(
    store: EditRoomStoreApi,
    ctx: ScriptContext,
    pointer: PointerState,
    input: Input,
    voxels: Voxels,
): void {
    const justDown = pointerJustDown(pointer, input);
    const held = pointerHeld(pointer, input);
    const justUp = pointerJustUp(pointer, input);
    const cancel = pointerJustRight(input);
    const s = store.getState();
    const { shape, size, height, iterations, heightmapMask } = s.smoothOptions;
    const hv = s.hoverVoxel;

    // ── right-click cancel ──
    // discard the accumulated stamp Selection without committing; the
    // release branch is gated on _strokeActive so it won't fire when LMB
    // eventually releases.
    if (_strokeActive && cancel) {
        _strokeActive = false;
        _lastCenter = null;
        _previewKey = '';
        store.setState({ brush: null });
        return;
    }

    // ── stroke start ──
    if (justDown && !_strokeActive) {
        _strokeActive = true;
        _lastCenter = null;
        const sel = Selection.create();
        if (hv) {
            buildShape(sel, shape, hv[0], hv[1], hv[2], size, height);
            _lastCenter = [hv[0], hv[1], hv[2]];
        }
        store.setState({ brush: sel });
        _previewKey = '';
    }

    // ── drag: OR each new centre's stamp into the accumulator ──
    if (_strokeActive && held && hv) {
        const sameAsLast =
            _lastCenter !== null &&
            _lastCenter[0] === hv[0] &&
            _lastCenter[1] === hv[1] &&
            _lastCenter[2] === hv[2];
        if (!sameAsLast) {
            _lastCenter = [hv[0], hv[1], hv[2]];
            const prev = store.getState().brush;
            const next = prev ? Selection.clone(prev) : Selection.create();
            STAMP_SCRATCH.chunks.clear();
            STAMP_SCRATCH.nodes.clear();
            buildShape(STAMP_SCRATCH, shape, hv[0], hv[1], hv[2], size, height);
            Selection.merge(next, STAMP_SCRATCH);
            store.setState({ brush: next });
        }
    }

    // ── release: commit ──
    if (_strokeActive && (justUp || !held)) {
        const accumulated = store.getState().brush;
        if (accumulated && !Selection.isEmpty(accumulated)) {
            const { forward, reverse } = runSmooth(voxels, accumulated, iterations, heightmapMask);
            if (forward.length > 0) {
                store.getState().action({
                    label: 'smooth',
                    do() {
                        sendOps(ctx, forward);
                    },
                    undo() {
                        sendOps(ctx, reverse);
                    },
                });
            }
        }
        _strokeActive = false;
        _lastCenter = null;
        _previewKey = '';
    }

    // ── idle: shape-at-hover preview ──
    if (!_strokeActive) {
        if (hv) {
            const key = previewKeyFor(hv, shape, size, height);
            if (key !== _previewKey) {
                _previewKey = key;
                const sel = Selection.create();
                buildShape(sel, shape, hv[0], hv[1], hv[2], size, height);
                store.setState({ brush: sel });
            }
        } else if (_previewKey !== '') {
            _previewKey = '';
            store.setState({ brush: null });
        }
    }
}

// ── shared core ────────────────────────────────────────────────────

type Column = {
    wx: number;
    wz: number;
    /** lowest y in the footprint at this (x,z). */
    yLo: number;
    /** highest y in the footprint at this (x,z). */
    yHi: number;
    /** topmost y within [yLo..yHi] matching heightmapMask. null = empty. */
    oldH: number | null;
    /** block at oldH (the fill used when raising the column). */
    oldKey: string | null;
    /** running height during convolution. seeded from oldH; falls back to
     *  yLo - 1 for empty columns so they participate as "ground level". */
    h: number;
    /** scratch slot for the next iteration's value. */
    hNext: number;
};

/**
 * worldedit-style smooth: project the footprint to a per-(x,z) heightmap,
 * iterate a 5×5 gaussian, and emit raise/lower ops bounded by each column's
 * footprint y range. shared by the brush tool and the `/smooth` region cmd.
 *
 * the footprint Selection's vertical extent at each column doubles as the
 * height-scan range AND the cap on raise/lower so the op never writes
 * outside the user's stamp / selection.
 */
export function runSmooth(
    voxels: Voxels,
    footprint: Selection.Selection,
    iterations: number,
    heightmapMask: Mask | null,
): { forward: VoxelOp[]; reverse: VoxelOp[] } {
    // (1) project to (x,z) columns + collect y range.
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

    // (2) sample world surface per column inside its y band.
    const rng = Math.random;
    for (const c of cols.values()) {
        for (let y = c.yHi; y >= c.yLo; y--) {
            const key = getBlockKey(voxels, c.wx, y, c.wz);
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

    // (3) iterate the 5×5 gaussian. unsampled cells outside the footprint
    // and empty columns inside drop out; the kernel re-normalises by the
    // accumulated weight. worldedit uses 1 iteration by default — higher
    // ≈ a larger σ via repeated convolution.
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

    // (4) emit ops within each column's y band.
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
                const cur = getBlockKey(voxels, c.wx, y, c.wz);
                if (cur === fill) continue;
                forward.push({ wx: c.wx, wy: y, wz: c.wz, key: fill });
                reverse.push({ wx: c.wx, wy: y, wz: c.wz, key: cur });
            }
        } else {
            for (let y = newH + 1; y <= c.oldH; y++) {
                const cur = getBlockKey(voxels, c.wx, y, c.wz);
                if (cur === BLOCK_AIR) continue;
                forward.push({ wx: c.wx, wy: y, wz: c.wz, key: BLOCK_AIR });
                reverse.push({ wx: c.wx, wy: y, wz: c.wz, key: cur });
            }
        }
    }

    return { forward, reverse };
}
