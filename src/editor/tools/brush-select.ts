// brush-select tool update function.
//
// the selection-category sibling of the brush (build) tool: same shape ×
// stroke machinery (the shared `utils/brush` harness), but the accumulated
// footprint folds into the room *selection* instead of writing voxels.
// called each frame from EditorScript onFrame (client only).
//
// on release the stroke is mask-filtered and merged into `selection` per
// `selectionBehavior` (replace / add, shift = force add, mirroring
// box-select). like brush (build), the optional mask is applied at commit
// only, the preview always shows the full shape so the user sees the brush
// footprint, and the mask just narrows which cells actually get selected.

import type { Input } from '../../client/input';
import { isKeyDown } from '../../client/input';
import type { ScriptContext } from '../../core/scene/scripts';
import * as Selection from '../../core/scene/selection';
import type { Voxels } from '../../core/voxels/voxels';
import type { EditRoomStoreApi } from '../edit-room-store';
import type { PointerState } from '../pointer-state';
import { testMask } from '../scene/mask';
import { advanceBrushStroke, type BrushStrokeState, createBrushStrokeState } from './utils/brush';

// per-room state contract. the shared stroke harness is nested under `brush`
// so a select-specific field can be added later as a sibling (no intersection,
// no churn) without the parent EditorScript having to know.
export type BrushSelectState = { brush: BrushStrokeState };
export function createBrushSelectState(): BrushSelectState {
    return { brush: createBrushStrokeState() };
}

// ── per-frame update ───────────────────────────────────────────────

export function updateBrushSelect(
    state: BrushSelectState,
    store: EditRoomStoreApi,
    _ctx: ScriptContext,
    pointer: PointerState,
    input: Input,
    voxels: Voxels,
): void {
    advanceBrushStroke(state.brush, store, pointer, input, store.getState().brushSelectOptions, (accumulated) => {
        const s = store.getState();
        const mk = input.mouseKeyboard;
        const shiftHeld = isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight');
        const behavior = shiftHeld ? 'add' : s.selectionBehavior;
        const mask = s.brushSelectOptions.mask;

        // start from the current selection when adding, empty otherwise; walk
        // the stamp, mask-filter, and set each surviving cell.
        const next = behavior === 'add' ? Selection.clone(s.selection) : Selection.create();
        let selectedAny = false;
        Selection.forEach(accumulated, (wx, wy, wz) => {
            if (mask && !testMask(mask, voxels, wx, wy, wz, Math.random)) return;
            Selection.set(next, wx, wy, wz);
            selectedAny = true;
        });
        // only clobber the existing selection when the stroke actually selected
        // something, a stroke fully masked out (e.g. dragged over air with a
        // `#existing` mask) leaves the selection intact rather than wiping it.
        if (selectedAny || behavior === 'add') {
            store.setState({ selection: next });
        }
    });
}
