// shared brush-stroke harness for the accumulate-then-commit tools
// (brush, brush-select, smooth).
//
// all three drive the store's `brush` field identically: an idle shape-at-
// hover preview, then while LMB is held a Selection accumulating every
// centre the cursor crosses, with nothing committed until release. the
// tools differ ONLY in what `release` does with the accumulated footprint —
// brush rasterises voxel ops, brush-select folds it into `selection`, smooth
// runs the gaussian — so that step is a callback the tool supplies. the
// cancel / start / drag / idle machinery lives here once.
//
// shape rasterisation is `scene/shapes.buildShape`; the preview/accumulator
// reference-eq dirty check (a fresh Selection ref is the repaint signal)
// matches the selection-mesh rebuilder.

import * as Selection from '../../../core/scene/selection';
import type { PointerState } from '../../pointer-state';
import { pointerJustDown, pointerHeld, pointerJustUp, pointerJustRight } from '../../pointer-state';
import type { Input } from '../../../client/input';
import type { EditRoomStoreApi } from '../../edit-room-store';
import { buildShape, type BrushShape } from '../../scene/shapes';

/** per-room brush-stroke state. created once per edit room in EditorScript
 *  onInit and threaded into the tool's update fn — never module-scoped, so
 *  two joined rooms can't share one stroke flag. */
export type BrushStrokeState = {
    active: boolean;
    /** centre voxel of the last stamp merged into the stroke / preview —
     *  avoids re-rasterising on every frame when the cursor sits still. */
    lastCenter: [number, number, number] | null;
    /** content-key for the idle preview ("x,y,z|shape|size|height"). a fresh
     *  Selection ref is pushed to the store only when this changes, so the
     *  selection-mesh rebuilder (reference-eq dirty check) only repaints on
     *  real changes — not every frame. */
    previewKey: string;
};

export function createBrushStrokeState(): BrushStrokeState {
    return { active: false, lastCenter: null, previewKey: '' };
}

/** the subset of a tool's options the harness needs to rasterise the stamp.
 *  every brush-family option object is a structural superset of this. */
export type BrushShapeOpts = { shape: BrushShape; size: number; height: number };

/** module-level scratch used to rasterise one stamp's shape before merging
 *  it into the stroke accumulator. carries no state between calls — only ever
 *  written then immediately read within a single synchronous update. */
const STAMP_SCRATCH: Selection.Selection = Selection.create();

/**
 * advance one frame of an accumulate-then-commit brush stroke. handles the
 * shared lifecycle — right-click cancel, stroke start, drag accumulation into
 * `store.brush`, and the idle shape-at-hover preview — and on release hands
 * the accumulated (non-empty) Selection to `onCommit`. the caller's only job
 * is `onCommit`: it reads whatever else it needs (active block, mask,
 * selection behavior, …) off the store and turns the footprint into voxel
 * ops / a selection / a smooth pass.
 */
export function advanceBrushStroke(
    state: BrushStrokeState,
    store: EditRoomStoreApi,
    pointer: PointerState,
    input: Input,
    opts: BrushShapeOpts,
    onCommit: (accumulated: Selection.Selection) => void,
): void {
    const justDown = pointerJustDown(pointer, input);
    const held = pointerHeld(pointer, input);
    const justUp = pointerJustUp(pointer, input);
    const cancel = pointerJustRight(input);
    const hv = store.getState().hoverVoxel;
    const { shape, size, height } = opts;

    // ── right-click cancel ──
    // discard the accumulated stamp Selection without committing; the release
    // branch is gated on state.active so it won't fire when LMB releases.
    if (state.active && cancel) {
        state.active = false;
        state.lastCenter = null;
        state.previewKey = '';
        store.setState({ brush: null });
        return;
    }

    // ── stroke start: clear accumulator, seed with the click cell ──
    if (justDown && !state.active) {
        state.active = true;
        state.lastCenter = null;
        const sel = Selection.create();
        if (hv) {
            buildShape(sel, shape, hv[0], hv[1], hv[2], size, height);
            state.lastCenter = [hv[0], hv[1], hv[2]];
        }
        store.setState({ brush: sel });
        state.previewKey = '';
    }

    // ── drag: OR each new centre's stamp into the accumulator ──
    if (state.active && held && hv) {
        const sameAsLast =
            state.lastCenter !== null &&
            state.lastCenter[0] === hv[0] &&
            state.lastCenter[1] === hv[1] &&
            state.lastCenter[2] === hv[2];
        if (!sameAsLast) {
            state.lastCenter = [hv[0], hv[1], hv[2]];
            const prev = store.getState().brush;
            const next = prev ? Selection.clone(prev) : Selection.create();
            STAMP_SCRATCH.chunks.clear();
            STAMP_SCRATCH.nodes.clear();
            buildShape(STAMP_SCRATCH, shape, hv[0], hv[1], hv[2], size, height);
            Selection.merge(next, STAMP_SCRATCH);
            store.setState({ brush: next });
        }
    }

    // ── release: hand the accumulated footprint to the tool ──
    if (state.active && (justUp || !held)) {
        const accumulated = store.getState().brush;
        if (accumulated && !Selection.isEmpty(accumulated)) onCommit(accumulated);
        state.active = false;
        state.lastCenter = null;
        state.previewKey = '';
        // fall through to the idle branch so the cursor immediately picks up
        // the shape-at-hover preview for the next stamp.
    }

    // ── idle: shape-at-hover preview ──
    if (!state.active) {
        if (hv) {
            const key = `${hv[0]},${hv[1]},${hv[2]}|${shape}|${size}|${height}`;
            if (key !== state.previewKey) {
                state.previewKey = key;
                const sel = Selection.create();
                buildShape(sel, shape, hv[0], hv[1], hv[2], size, height);
                store.setState({ brush: sel });
            }
        } else if (state.previewKey !== '') {
            state.previewKey = '';
            store.setState({ brush: null });
        }
    }
}
