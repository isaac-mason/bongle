// brush (build) tool update function — the build-category brush that stamps
// voxels. its selection-category sibling is `brush-select.ts`.
//
// called each frame from EditorScript onFrame (client only). the accumulate-
// then-commit stroke lifecycle (idle preview, drag accumulation into the
// store's `brush` field, right-click cancel) lives in the shared
// `utils/brush` harness; this file supplies only the commit step: run the
// accumulated Selection through `applyStamp` (the same mask/pattern machinery
// as /set) and wrap the resulting ops in one undoable action per stroke.

import type { Input } from '../../client/input';
import type { ScriptContext } from '../../core/scene/scripts';
import { send } from '../../core/scene/scripts';
import type { Voxels } from '../../core/voxels/voxels';
import type { VoxelOp } from '../blueprint';
import { VoxelEditCommand } from '../commands';
import type { EditRoomStoreApi } from '../edit-room-store';
import { useEditor } from '../editor-store';
import type { PointerState } from '../pointer-state';
import { applyStamp } from './brush-apply';
import { advanceBrushStroke, type BrushStrokeState, createBrushStrokeState } from './utils/brush';

// per-room state contract. the shared stroke harness is nested under `brush`
// so a brush-specific field can be added later as a sibling (no intersection,
// no churn) without the parent EditorScript having to know.
export type BrushState = { brush: BrushStrokeState };
export function createBrushState(): BrushState {
    return { brush: createBrushStrokeState() };
}

const OPS_PER_PACKET = 4096;

function sendOps(ctx: ScriptContext, ops: VoxelOp[]): void {
    for (let i = 0; i < ops.length; i += OPS_PER_PACKET) {
        send(ctx, VoxelEditCommand, { ops: ops.slice(i, i + OPS_PER_PACKET) });
    }
}

function activeBlockKey(store: EditRoomStoreApi): string {
    const slot = useEditor.getState().hotbar[store.getState().activeSlotIndex];
    return slot && slot.kind === 'block' ? slot.blockKey : '';
}

// ── per-frame update ───────────────────────────────────────────────

export function updateBrush(
    state: BrushState,
    store: EditRoomStoreApi,
    ctx: ScriptContext,
    pointer: PointerState,
    input: Input,
    voxels: Voxels,
): void {
    const { pattern, mask } = store.getState().brushOptions;
    advanceBrushStroke(state.brush, store, pointer, input, store.getState().brushOptions, (accumulated) => {
        const active = activeBlockKey(store);
        const forward: VoxelOp[] = [];
        const reverse: VoxelOp[] = [];
        applyStamp(accumulated, voxels, { pattern, mask }, active, forward, reverse);
        if (forward.length > 0) {
            store.getState().action({
                label: 'brush',
                do() {
                    sendOps(ctx, forward);
                },
                undo() {
                    sendOps(ctx, reverse);
                },
            });
        }
    });
}
