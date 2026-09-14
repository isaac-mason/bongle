import type { Input } from '../../../client/input';
import { isMouseDown, isMouseJustDown, isMouseJustUp } from '../../../client/input';
import * as Selection from '../../../core/scene/selection';
import type { EditRoomStoreApi } from '../../edit-room-store';
import { type BrushShape, buildShape } from '../../scene/shapes';

/** Created once per edit room in EditorScript onInit and threaded into the tool's update fn, never module-scoped, so two joined rooms can't share one stroke flag. */
export type BrushStrokeState = {
    active: boolean;
    /** Centre voxel of the last stamp merged into the stroke/preview, avoids re-rasterising every frame when the cursor sits still. */
    lastCenter: [number, number, number] | null;
    /** Content-key for the idle preview. A fresh Selection ref is pushed to the store only when this changes, so the selection-mesh rebuilder only repaints on real changes. */
    previewKey: string;
};

export function createBrushStrokeState(): BrushStrokeState {
    return { active: false, lastCenter: null, previewKey: '' };
}

/** The subset of a tool's options the harness needs to rasterise the stamp. */
export type BrushShapeOpts = { shape: BrushShape; size: number; height: number };

/** Scratch for rasterising one stamp's shape before merging it into the stroke accumulator; written then immediately read within a single synchronous update. */
const STAMP_SCRATCH: Selection.Selection = Selection.create();

/** On release, hands the accumulated (non-empty) Selection to `onCommit`, which turns the footprint into voxel ops, a selection, or a smooth pass. */
export function advanceBrushStroke(
    state: BrushStrokeState,
    store: EditRoomStoreApi,
    input: Input,
    opts: BrushShapeOpts,
    onCommit: (accumulated: Selection.Selection) => void,
): void {
    const mk = input.mouseKeyboard;
    const justDown = isMouseJustDown(mk, 'left');
    const held = isMouseDown(mk, 'left');
    const justUp = isMouseJustUp(mk, 'left');
    const cancel = isMouseJustDown(mk, 'right');
    const hv = store.getState().hoverVoxel;
    const { shape, size, height } = opts;

    // The release branch is gated on state.active so it won't also fire when LMB releases.
    if (state.active && cancel) {
        state.active = false;
        state.lastCenter = null;
        state.previewKey = '';
        store.setState({ brush: null });
        return;
    }

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

    if (state.active && (justUp || !held)) {
        const accumulated = store.getState().brush;
        if (accumulated && !Selection.isEmpty(accumulated)) onCommit(accumulated);
        state.active = false;
        state.lastCenter = null;
        state.previewKey = '';
        // Falls through to the idle branch so the cursor immediately picks up the next preview.
    }

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
