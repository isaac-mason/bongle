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
// into state.forward/reverse and are committed atomically on release via
// the action.do callback. mid-stroke, the projected delta cells are drawn
// as cyan highlights via the brush selection — same render path as the
// disc footprint. this keeps the raycast surface frozen for the whole
// stroke so the cursor never climbs the hill it's building.

import type { ScriptContext } from '../../core/scene/scripts';
import { send } from '../../core/scene/scripts';
import { VoxelEditCommand } from '../commands';
import type { Voxels } from '../../core/voxels/voxels';
import { BLOCK_AIR, getBlock } from '../../core/voxels/voxels';
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
        const key = getBlock(voxels, wx, y, wz);
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
    /** integer blocks already projected into state.forward/reverse. */
    applied: number;
    /** +1 = raise/flatten-up, -1 = lower/flatten-down. fixed once on creation. */
    sign: 1 | -1;
    /** true once `applied` has hit the cap — no further accumulation. */
    done: boolean;
};

/** per-room elevation stroke state. created once per edit room in
 *  EditorScript onInit and threaded into `updateElevation` — never
 *  module-scoped, so two joined rooms can't share one stroke. */
export type ElevationState = {
    active: boolean;
    mode: 'single' | 'continuous';
    startY: number;
    yLimit: number;
    /** options snapshotted at stroke-start — the stroke is mode-locked to
     *  whatever was active on click. null when no stroke is in progress. */
    opts: ElevationOptions | null;
    flattenTargetY: number;
    forward: VoxelOp[];
    reverse: VoxelOp[];
    /** per-column continuous-mode accumulators, keyed "wx,wz". */
    accum: Map<string, ColumnAccum>;
    lastFrameMs: number;
    previewKey: string;
    /** bumps whenever new ops are projected into `forward` — folded into the
     *  preview key so the brush mesh rebuilds as the delta grows. */
    version: number;
};

export function createElevationState(): ElevationState {
    return {
        active: false,
        mode: 'single',
        startY: 0,
        yLimit: 0,
        opts: null,
        flattenTargetY: 0,
        forward: [],
        reverse: [],
        accum: new Map(),
        lastFrameMs: 0,
        previewKey: '',
        version: 0,
    };
}

// ── per-frame update ──────────────────────────────────────────────

export function updateElevation(
    state: ElevationState,
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
    // release branch below is gated on state.active so it won't commit
    // when LMB eventually releases. mode-locked stroke opts also reset.
    if (state.active && cancel) {
        state.active = false;
        state.opts = null;
        state.forward = [];
        state.reverse = [];
        state.accum.clear();
        state.previewKey = '';
        store.setState({ brush: null, brushFill: null, brushEdges: null });
        return;
    }

    // ── stroke start ──
    if (justDown && !state.active && hv) {
        state.active = true;
        state.mode = opts.applyMode;
        state.startY = hv[1];
        state.yLimit = Math.max(1, Math.floor(opts.yLimit));
        state.opts = opts;
        state.flattenTargetY = hv[1];
        state.forward = [];
        state.reverse = [];
        state.accum.clear();
        state.lastFrameMs = now;
        state.version++;

        if (state.mode === 'single') {
            // project the stamp into state.forward/reverse only — nothing
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
                state.forward,
                state.reverse,
            );
            if (state.forward.length > 0) state.version++;
        }
    }

    // ── continuous integration ──
    if (state.active && state.mode === 'continuous' && state.opts) {
        if (held && hv) {
            const dt = Math.min(0.05, Math.max(0, (now - state.lastFrameMs) / 1000));
            state.lastFrameMs = now;
            if (dt > 0) {
                const active = activeBlockKeyOf(
                    useEditor.getState().hotbar,
                    store.getState().activeSlotIndex,
                );
                const added = integrateContinuous(state, voxels, hv[0], hv[2], dt, state.opts, active);
                if (added > 0) state.version++;
            }
        } else {
            // off-surface — don't accumulate, but advance the clock so re-entry
            // doesn't dump a giant delta.
            state.lastFrameMs = now;
        }
    }

    // ── release: one action for the whole stroke ──
    if (state.active && (justUp || !held)) {
        const forward = state.forward;
        const reverse = state.reverse;
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
        state.active = false;
        state.opts = null;
        state.accum.clear();
        state.forward = [];
        state.reverse = [];
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
    const showStroke = state.active;
    const showIdle = !state.active && !!hv;
    if (showStroke || showIdle) {
        const size = Math.max(1, Math.floor(opts.size));
        const yLimit = Math.max(1, Math.floor(opts.yLimit));
        // during a stroke the mode is locked to whatever was active at click;
        // idle reads from the live UI setting so the tint previews the next
        // click's behavior.
        const activeMode = state.active && state.opts ? state.opts.mode : opts.mode;
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
            ? `stroke|${state.version}`
            : `idle|${hv![0]},${hv![1]},${hv![2]}|${size}|${yLimit}|${activeMode}`;
        if (key !== state.previewKey) {
            state.previewKey = key;
            const sel = Selection.create();
            if (showStroke) {
                for (const op of state.forward) {
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
    } else if (state.previewKey !== '') {
        state.previewKey = '';
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
                    const cur = getBlock(voxels, wx, y, wz);
                    forward.push({ wx, wy: y, wz, key: pickFill(wx, y, wz, top.key) });
                    reverse.push({ wx, wy: y, wz, key: cur });
                }
            } else if (opts.mode === 'lower') {
                const targetH = Math.max(yMin, top.h - blocks);
                for (let y = top.h; y > targetH; y--) {
                    const cur = getBlock(voxels, wx, y, wz);
                    forward.push({ wx, wy: y, wz, key: BLOCK_AIR });
                    reverse.push({ wx, wy: y, wz, key: cur });
                }
            } else {
                const dir = Math.sign(flattenTargetY - top.h);
                if (dir === 0) continue;
                if (dir > 0) {
                    const targetH = Math.min(yMax, Math.min(flattenTargetY, top.h + blocks));
                    for (let y = top.h + 1; y <= targetH; y++) {
                        const cur = getBlock(voxels, wx, y, wz);
                        forward.push({ wx, wy: y, wz, key: pickFill(wx, y, wz, top.key) });
                        reverse.push({ wx, wy: y, wz, key: cur });
                    }
                } else {
                    const targetH = Math.max(yMin, Math.max(flattenTargetY, top.h - blocks));
                    for (let y = top.h; y > targetH; y--) {
                        const cur = getBlock(voxels, wx, y, wz);
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
    state: ElevationState,
    voxels: Voxels,
    cx: number,
    cz: number,
    dt: number,
    opts: ElevationOptions,
    active: string,
): number {
    const size = Math.max(1, Math.floor(opts.size));
    const cy = state.startY;
    const yLimit = state.yLimit;
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
            let col = state.accum.get(k);
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
                    const s = Math.sign(state.flattenTargetY - top.h);
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
                state.accum.set(k, col);
            }
            if (col.done) continue;

            col.accum += delta;
            const newApplied = Math.floor(col.accum);
            if (newApplied <= col.applied) continue;

            if (col.sign > 0) {
                // raise / flatten-up: fill with pattern (default: baselineKey).
                const ceil =
                    opts.mode === 'flatten'
                        ? Math.min(yMax, state.flattenTargetY) - col.baselineH
                        : yMax - col.baselineH;
                const capped = Math.min(newApplied, ceil);
                for (let i = col.applied + 1; i <= capped; i++) {
                    const wy = col.baselineH + i;
                    const cur = getBlock(voxels, wx, wy, wz);
                    const key = opts.pattern
                        ? samplePattern(opts.pattern, voxels, wx, wy, wz, active, rng)
                        : col.baselineKey;
                    state.forward.push({ wx, wy, wz, key });
                    state.reverse.push({ wx, wy, wz, key: cur });
                    added++;
                }
                col.applied = capped;
                if (capped >= ceil) col.done = true;
            } else {
                // lower / flatten-down: clear from the top downward.
                const floor =
                    opts.mode === 'flatten'
                        ? col.baselineH - Math.max(yMin, state.flattenTargetY)
                        : col.baselineH - yMin;
                const capped = Math.min(newApplied, floor);
                for (let i = col.applied + 1; i <= capped; i++) {
                    const wy = col.baselineH - (i - 1);
                    const cur = getBlock(voxels, wx, wy, wz);
                    state.forward.push({ wx, wy, wz, key: BLOCK_AIR });
                    state.reverse.push({ wx, wy, wz, key: cur });
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
