// elevation tool — axiom-style heightmap sculpt.
//
// modes:
//   raise   extend the top block upward inside the y-limit band.
//   lower   clear top blocks to air.
//   flatten drag every column under the disc toward the click y.
//
// apply modes:
//   single      one stamp on click. strength = round(amount · falloff · image).
//   continuous  per-column fractional accumulator integrated over time.
//               each frame:  accum += rate · amount · falloff · image · dt.
//               whenever floor(accum) advances, one block flips. center cells
//               fill first, edges trail — natural smooth dome / valley shape.
//
// the disc footprint preview follows the cursor (idle) and tracks (x,z)
// only during a stroke (y stays at click level — the y-limit pivot).
//
// crucial: the live voxel grid is NEVER mutated mid-stroke. ops accumulate
// into _strokeForward/Reverse and are committed atomically on release via
// the action.do callback. mid-stroke, the projected delta cells are drawn
// as cyan highlights via the brush selection — same render path as the
// disc footprint. this keeps the raycast surface frozen for the whole
// stroke so the cursor never climbs the hill it's building.

import type { ScriptContext } from '../../core/scene/scripts';
import { send } from '../../core/scene/scripts';
import { VoxelEditCommand } from '../commands';
import type { Voxels } from '../../core/voxels/voxels';
import { BLOCK_AIR, getBlockKey } from '../../core/voxels/voxels';
import type { PointerState } from '../pointer-state';
import { pointerJustDown, pointerHeld, pointerJustUp, pointerJustRight } from '../pointer-state';
import type { Input } from '../../client/input';
import type {
    EditRoomStoreApi,
    ElevationFalloff,
    ElevationImage,
    ElevationOptions,
} from '../edit-room-store';
import * as Selection from '../../core/scene/selection';
import { buildShape } from '../scene/shapes';
import type { VoxelOp } from '../blueprint';
import { BRUSH_TINTS } from '../visuals/editor-colors';
import { samplePattern } from '../scene/pattern';
import { testMask } from '../scene/mask';
import { useEditor } from '../editor-store';
import { activeBlockKeyOf } from '../inventory';

const OPS_PER_PACKET = 4096;

function sendOps(ctx: ScriptContext, ops: VoxelOp[]): void {
    for (let i = 0; i < ops.length; i += OPS_PER_PACKET) {
        send(ctx, VoxelEditCommand, { ops: ops.slice(i, i + OPS_PER_PACKET) });
    }
}

// ── falloff curves ────────────────────────────────────────────────
// t ∈ [0,1) = distance from disc center / radius. all curves return 1
// at t=0 and 0 at t=1; cosine has the smoothest boundary.

function falloff(t: number, kind: ElevationFalloff): number {
    if (t >= 1) return 0;
    switch (kind) {
        case 'linear':
            return 1 - t;
        case 'cosine':
            return 0.5 * (1 + Math.cos(t * Math.PI));
        case 'sharp': {
            const u = 1 - t;
            return u * u * u;
        }
    }
}

// ── image sampling ────────────────────────────────────────────────
// nearest-neighbour. disc-local (dx,dz) ∈ [-size, +size] maps linearly
// to image uv ∈ [0,1]. luminance is precomputed in loadElevationImage.

function sampleImage(image: ElevationImage, dx: number, dz: number, size: number): number {
    const u = (dx / size + 1) * 0.5;
    const v = (dz / size + 1) * 0.5;
    const ix = Math.min(image.width - 1, Math.max(0, Math.floor(u * image.width)));
    const iy = Math.min(image.height - 1, Math.max(0, Math.floor(v * image.height)));
    return image.luminance[iy * image.width + ix] ?? 0;
}

// ── column scan ───────────────────────────────────────────────────
// topmost non-air voxel inside [yLo, yHi]. null = empty column in band.

function findTopH(
    voxels: Voxels,
    wx: number,
    wz: number,
    yLo: number,
    yHi: number,
): { h: number; key: string } | null {
    for (let y = yHi; y >= yLo; y--) {
        const key = getBlockKey(voxels, wx, y, wz);
        if (key !== BLOCK_AIR) return { h: y, key };
    }
    return null;
}

// ── stroke state (continuous mode) ────────────────────────────────
// per-column accumulator. captured on first contact during the stroke
// (a column may enter the disc later via cursor drag — it starts then,
// not at stroke-start).

type ColumnAccum = {
    /** topmost surface y in [yMin, yMax] when this column was first touched. */
    baselineH: number;
    /** block key at baselineH — extended upward on raise / flatten-up. */
    baselineKey: string;
    /** fractional blocks-of-change since first contact (always ≥ 0). */
    accum: number;
    /** integer blocks already projected into _strokeForward/Reverse. */
    applied: number;
    /** +1 = raise/flatten-up, -1 = lower/flatten-down. fixed once on creation. */
    sign: 1 | -1;
    /** true once `applied` has hit the cap — no further accumulation. */
    done: boolean;
};

let _strokeActive = false;
let _strokeMode: 'single' | 'continuous' = 'single';
let _strokeStartY = 0;
let _strokeYLimit = 0;
let _strokeOpts: ElevationOptions | null = null;
let _strokeFlattenTargetY = 0;
let _strokeForward: VoxelOp[] = [];
let _strokeReverse: VoxelOp[] = [];
const _accumMap = new Map<string, ColumnAccum>();
let _lastFrameMs = 0;
let _previewKey = '';
/** bumps whenever new ops are projected into _strokeForward — folded into the
 *  preview key so the brush mesh rebuilds as the delta grows. */
let _strokeVersion = 0;

// ── per-frame update ──────────────────────────────────────────────

export function updateElevation(
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
    const opts = s.elevationOptions;
    const hv = s.hoverVoxel;
    const now = performance.now();

    // ── right-click cancel ──
    // drop the projected delta + accumulators and clear the preview. the
    // release branch below is gated on _strokeActive so it won't commit
    // when LMB eventually releases. mode-locked stroke opts also reset.
    if (_strokeActive && cancel) {
        _strokeActive = false;
        _strokeOpts = null;
        _strokeForward = [];
        _strokeReverse = [];
        _accumMap.clear();
        _previewKey = '';
        store.setState({ brush: null, brushFill: null, brushEdges: null });
        return;
    }

    // ── stroke start ──
    if (justDown && !_strokeActive && hv) {
        _strokeActive = true;
        _strokeMode = opts.applyMode;
        _strokeStartY = hv[1];
        _strokeYLimit = Math.max(1, Math.floor(opts.yLimit));
        _strokeOpts = opts;
        _strokeFlattenTargetY = hv[1];
        _strokeForward = [];
        _strokeReverse = [];
        _accumMap.clear();
        _lastFrameMs = now;
        _strokeVersion++;

        if (_strokeMode === 'single') {
            // project the stamp into _strokeForward/Reverse only — nothing
            // hits the voxel grid until release. the cyan preview shows the
            // affected cells via the brush selection below.
            const active = activeBlockKeyOf(
                useEditor.getState().hotbar,
                store.getState().activeSlotIndex,
            );
            applyElevationStamp(
                voxels,
                hv[0],
                hv[1],
                hv[2],
                opts,
                hv[1],
                active,
                _strokeForward,
                _strokeReverse,
            );
            if (_strokeForward.length > 0) _strokeVersion++;
        }
    }

    // ── continuous integration ──
    if (_strokeActive && _strokeMode === 'continuous' && _strokeOpts) {
        if (held && hv) {
            const dt = Math.min(0.05, Math.max(0, (now - _lastFrameMs) / 1000));
            _lastFrameMs = now;
            if (dt > 0) {
                const active = activeBlockKeyOf(
                    useEditor.getState().hotbar,
                    store.getState().activeSlotIndex,
                );
                const added = integrateContinuous(voxels, hv[0], hv[2], dt, _strokeOpts, active);
                if (added > 0) _strokeVersion++;
            }
        } else {
            // off-surface — don't accumulate, but advance the clock so re-entry
            // doesn't dump a giant delta.
            _lastFrameMs = now;
        }
    }

    // ── release: one action for the whole stroke ──
    if (_strokeActive && (justUp || !held)) {
        const forward = _strokeForward;
        const reverse = _strokeReverse;
        if (forward.length > 0) {
            store.getState().action({
                label: 'elevation',
                do() {
                    sendOps(ctx, forward);
                },
                undo() {
                    sendOps(ctx, reverse);
                },
            });
        }
        _strokeActive = false;
        _strokeOpts = null;
        _accumMap.clear();
        _strokeForward = [];
        _strokeReverse = [];
    }

    // ── preview ──
    //
    // idle:   disc footprint at the hover y, follows the cursor — tells the
    //         user where the next click will land.
    // stroke: drop the disc entirely; only the projected delta cells (the
    //         "ghost terrain" the stroke will materialise on release) are
    //         highlighted. the disc would just clutter the actual feedback
    //         once a stroke is underway. since we never touched voxels
    //         mid-stroke, the raycast surface (hv) stays anchored to the
    //         original ground.
    //
    // tint reflects intent:
    //   raise   → cyan  (additive)
    //   lower   → red   (destructive)
    //   flatten → amber (neutral / mixed-effect)
    // both fill and edges point at stable BRUSH_TINTS preset refs, so the
    // uniform pushes exactly once per mode change (not per frame).
    // stroke active → show the projected delta ghost, anchored to the click
    // origin. doesn't need a live hover voxel (the cursor can wander off the
    // terrain during a stroke without nuking the visual feedback).
    // idle → needs hv to know where to draw the disc footprint.
    const showStroke = _strokeActive;
    const showIdle = !_strokeActive && !!hv;
    if (showStroke || showIdle) {
        const size = Math.max(1, Math.floor(opts.size));
        const yLimit = Math.max(1, Math.floor(opts.yLimit));
        // during a stroke the mode is locked to whatever was active at click;
        // idle reads from the live UI setting so the tint previews the next
        // click's behavior.
        const activeMode = _strokeActive && _strokeOpts ? _strokeOpts.mode : opts.mode;
        const tint =
            activeMode === 'lower'
                ? BRUSH_TINTS.red
                : activeMode === 'flatten'
                ? BRUSH_TINTS.amber
                : BRUSH_TINTS.cyan;
        // idle preview always marks the hit voxel (cy) so the user sees
        // where the click lands, plus thin disc layers at the mode's reachable
        // cap(s) so the y-limit band is visible:
        //   raise   → disc at cy + cap at cy+yLimit
        //   lower   → disc at cy + cap at cy-yLimit
        //   flatten → disc at cy + caps at cy±yLimit
        // the fill material's depthTest:false means even the disc at cy
        // (inside terrain) still shows through.
        const showUpCap = activeMode === 'raise' || activeMode === 'flatten';
        const showDownCap = activeMode === 'lower' || activeMode === 'flatten';
        const key = showStroke
            ? `stroke|${_strokeVersion}`
            : `idle|${hv![0]},${hv![1]},${hv![2]}|${size}|${yLimit}|${activeMode}`;
        if (key !== _previewKey) {
            _previewKey = key;
            const sel = Selection.create();
            if (showStroke) {
                for (const op of _strokeForward) {
                    Selection.set(sel, op.wx, op.wy, op.wz);
                }
            } else {
                // additive — buildShape clears, so we'd lose all but the last
                // disc if we called it 2-3 times. inline the disc footprint.
                const cy = hv![1];
                const rsq = size * size + size;
                const addDisc = (y: number) => {
                    for (let dz = -size; dz <= size; dz++) {
                        for (let dx = -size; dx <= size; dx++) {
                            if (dx * dx + dz * dz <= rsq) {
                                Selection.set(sel, hv![0] + dx, y, hv![2] + dz);
                            }
                        }
                    }
                };
                addDisc(cy);
                if (showUpCap) addDisc(cy + yLimit);
                if (showDownCap) addDisc(cy - yLimit);
            }
            store.setState({ brush: sel, brushFill: tint.fill, brushEdges: tint.edges });
        } else if (
            store.getState().brushFill !== tint.fill ||
            store.getState().brushEdges !== tint.edges
        ) {
            // mode changed without the preview geometry changing — push the new
            // tint refs anyway so the materials update.
            store.setState({ brushFill: tint.fill, brushEdges: tint.edges });
        }
    } else if (_previewKey !== '') {
        _previewKey = '';
        store.setState({ brush: null, brushFill: null, brushEdges: null });
    }
}

// ── single-shot stamp ─────────────────────────────────────────────
// also reused by the /elevation region command — `flattenTargetY` is
// the y for flatten mode (ignored for raise/lower).

function applyElevationStamp(
    voxels: Voxels,
    cx: number,
    cy: number,
    cz: number,
    opts: ElevationOptions,
    flattenTargetY: number,
    active: string,
    forward: VoxelOp[],
    reverse: VoxelOp[],
): void {
    const size = Math.max(1, Math.floor(opts.size));
    const yLimit = Math.max(1, Math.floor(opts.yLimit));
    const rsq = size * size + size;
    const yMin = cy - yLimit;
    const yMax = cy + yLimit;
    const rng = Math.random;

    // pickFill: source the fill block for raise / flatten-up. null pattern
    // falls back to the column's existing top block (the natural terrain
    // default — extend the surface up); otherwise sample the configured
    // pattern at the cell being placed.
    function pickFill(wx: number, wy: number, wz: number, surfaceKey: string): string {
        if (!opts.pattern) return surfaceKey;
        return samplePattern(opts.pattern, voxels, wx, wy, wz, active, rng);
    }

    for (let dz = -size; dz <= size; dz++) {
        for (let dx = -size; dx <= size; dx++) {
            const distSq = dx * dx + dz * dz;
            if (distSq > rsq) continue;
            const distNorm = Math.sqrt(distSq) / size;
            const fw = falloff(distNorm, opts.falloff);
            if (fw <= 0) continue;
            const iw = opts.heightmap ? sampleImage(opts.heightmap, dx, dz, size) : 1;
            const strength = opts.amount * fw * iw;
            if (strength < 0.5) continue;
            const blocks = Math.round(strength);

            const wx = cx + dx;
            const wz = cz + dz;
            const top = findTopH(voxels, wx, wz, yMin, yMax);
            if (!top) continue;
            // mask filters per-column at the surface cell.
            if (opts.mask && !testMask(opts.mask, voxels, wx, top.h, wz, rng)) continue;

            if (opts.mode === 'raise') {
                const targetH = Math.min(yMax, top.h + blocks);
                for (let y = top.h + 1; y <= targetH; y++) {
                    const cur = getBlockKey(voxels, wx, y, wz);
                    forward.push({ wx, wy: y, wz, key: pickFill(wx, y, wz, top.key) });
                    reverse.push({ wx, wy: y, wz, key: cur });
                }
            } else if (opts.mode === 'lower') {
                const targetH = Math.max(yMin, top.h - blocks);
                for (let y = top.h; y > targetH; y--) {
                    const cur = getBlockKey(voxels, wx, y, wz);
                    forward.push({ wx, wy: y, wz, key: BLOCK_AIR });
                    reverse.push({ wx, wy: y, wz, key: cur });
                }
            } else {
                const dir = Math.sign(flattenTargetY - top.h);
                if (dir === 0) continue;
                if (dir > 0) {
                    const targetH = Math.min(yMax, Math.min(flattenTargetY, top.h + blocks));
                    for (let y = top.h + 1; y <= targetH; y++) {
                        const cur = getBlockKey(voxels, wx, y, wz);
                        forward.push({ wx, wy: y, wz, key: pickFill(wx, y, wz, top.key) });
                        reverse.push({ wx, wy: y, wz, key: cur });
                    }
                } else {
                    const targetH = Math.max(yMin, Math.max(flattenTargetY, top.h - blocks));
                    for (let y = top.h; y > targetH; y--) {
                        const cur = getBlockKey(voxels, wx, y, wz);
                        forward.push({ wx, wy: y, wz, key: BLOCK_AIR });
                        reverse.push({ wx, wy: y, wz, key: cur });
                    }
                }
            }
        }
    }
}

// ── continuous integration ─────────────────────────────────────────

function integrateContinuous(
    voxels: Voxels,
    cx: number,
    cz: number,
    dt: number,
    opts: ElevationOptions,
    active: string,
): number {
    const size = Math.max(1, Math.floor(opts.size));
    const cy = _strokeStartY;
    const yLimit = _strokeYLimit;
    const rsq = size * size + size;
    const yMin = cy - yLimit;
    const yMax = cy + yLimit;
    const rng = Math.random;
    let added = 0;

    for (let dz = -size; dz <= size; dz++) {
        for (let dx = -size; dx <= size; dx++) {
            const distSq = dx * dx + dz * dz;
            if (distSq > rsq) continue;
            const distNorm = Math.sqrt(distSq) / size;
            const fw = falloff(distNorm, opts.falloff);
            if (fw <= 0) continue;
            const iw = opts.heightmap ? sampleImage(opts.heightmap, dx, dz, size) : 1;
            const delta = opts.rate * opts.amount * fw * iw * dt;
            if (delta <= 0) continue;

            const wx = cx + dx;
            const wz = cz + dz;
            const k = `${wx},${wz}`;
            let col = _accumMap.get(k);
            if (!col) {
                // baseline reads always hit the *original* grid — we never
                // mutate during the stroke. that's the whole point: the
                // raycast surface stays frozen and the cursor doesn't climb
                // its own hill.
                const top = findTopH(voxels, wx, wz, yMin, yMax);
                if (!top) continue;
                // mask filters per-column at first contact (sampled on the
                // surface cell). columns that fail are dropped entirely —
                // they never get an accumulator entry.
                if (opts.mask && !testMask(opts.mask, voxels, wx, top.h, wz, rng)) continue;
                let sign: 1 | -1;
                if (opts.mode === 'raise') sign = 1;
                else if (opts.mode === 'lower') sign = -1;
                else {
                    const s = Math.sign(_strokeFlattenTargetY - top.h);
                    if (s === 0) continue; // column already at flatten target
                    sign = s > 0 ? 1 : -1;
                }
                col = {
                    baselineH: top.h,
                    baselineKey: top.key,
                    accum: 0,
                    applied: 0,
                    sign,
                    done: false,
                };
                _accumMap.set(k, col);
            }
            if (col.done) continue;

            col.accum += delta;
            const newApplied = Math.floor(col.accum);
            if (newApplied <= col.applied) continue;

            if (col.sign > 0) {
                // raise / flatten-up: fill with pattern (default: baselineKey).
                const ceil =
                    opts.mode === 'flatten'
                        ? Math.min(yMax, _strokeFlattenTargetY) - col.baselineH
                        : yMax - col.baselineH;
                const capped = Math.min(newApplied, ceil);
                for (let i = col.applied + 1; i <= capped; i++) {
                    const wy = col.baselineH + i;
                    const cur = getBlockKey(voxels, wx, wy, wz);
                    const key = opts.pattern
                        ? samplePattern(opts.pattern, voxels, wx, wy, wz, active, rng)
                        : col.baselineKey;
                    _strokeForward.push({ wx, wy, wz, key });
                    _strokeReverse.push({ wx, wy, wz, key: cur });
                    added++;
                }
                col.applied = capped;
                if (capped >= ceil) col.done = true;
            } else {
                // lower / flatten-down: clear from the top downward.
                const floor =
                    opts.mode === 'flatten'
                        ? col.baselineH - Math.max(yMin, _strokeFlattenTargetY)
                        : col.baselineH - yMin;
                const capped = Math.min(newApplied, floor);
                for (let i = col.applied + 1; i <= capped; i++) {
                    const wy = col.baselineH - (i - 1);
                    const cur = getBlockKey(voxels, wx, wy, wz);
                    _strokeForward.push({ wx, wy, wz, key: BLOCK_AIR });
                    _strokeReverse.push({ wx, wy, wz, key: cur });
                    added++;
                }
                col.applied = capped;
                if (capped >= floor) col.done = true;
            }
        }
    }

    return added;
}

// ── image loader ──────────────────────────────────────────────────
// PNG/JPG/etc via createImageBitmap, drawn to an OffscreenCanvas to
// pull pixels. luminance via the perceptual coefficients (0.299R +
// 0.587G + 0.114B), normalised to [0,1].

export async function loadElevationImage(file: File): Promise<ElevationImage> {
    const bitmap = await createImageBitmap(file);
    const w = bitmap.width;
    const h = bitmap.height;
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2d context unavailable');
    g.drawImage(bitmap, 0, 0);
    const data = g.getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h);
    for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
        const r = data[p] ?? 0;
        const gC = data[p + 1] ?? 0;
        const b = data[p + 2] ?? 0;
        lum[i] = (0.299 * r + 0.587 * gC + 0.114 * b) / 255;
    }
    bitmap.close?.();
    return { name: file.name, width: w, height: h, luminance: lum };
}
