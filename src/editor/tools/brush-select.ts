import type { Input } from '../../client/input';
import { isKeyDown, isModDown } from '../../client/input';
import type { ScriptContext } from '../../core/scene/scripts';
import * as Selection from '../../core/scene/selection';
import type { Voxels } from '../../core/voxels/voxels';
import type { EditRoomStoreApi } from '../edit-room-store';
import { testMask } from '../scene/mask';
import { playSelected } from '../sounds';
import { advanceBrushStroke, type BrushStrokeState, createBrushStrokeState } from './utils/brush';

export type BrushSelectState = { brush: BrushStrokeState };
export function createBrushSelectState(): BrushSelectState {
    return { brush: createBrushStrokeState() };
}

export function updateBrushSelect(
    state: BrushSelectState,
    store: EditRoomStoreApi,
    ctx: ScriptContext,
    input: Input,
    voxels: Voxels,
): void {
    advanceBrushStroke(state.brush, store, input, store.getState().brushSelectOptions, (accumulated) => {
        const s = store.getState();
        const mk = input.mouseKeyboard;
        // cmd/ctrl is an alternate add-to-selection modifier, same as shift.
        const addHeld = isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight') || isModDown(mk);
        const behavior = addHeld ? 'add' : s.selectionBehavior;
        const mask = s.brushSelectOptions.mask;

        const next = behavior === 'add' ? Selection.clone(s.selection) : Selection.create();
        let selectedAny = false;
        Selection.forEach(accumulated, (wx, wy, wz) => {
            if (mask && !testMask(mask, voxels, wx, wy, wz, Math.random)) return;
            Selection.set(next, wx, wy, wz);
            selectedAny = true;
        });
        // a stroke fully masked out leaves the selection intact rather than wiping it
        if (selectedAny || behavior === 'add') {
            store.getState().replaceSelection(next);
            playSelected(ctx, behavior === 'add');
        }
    });
}
