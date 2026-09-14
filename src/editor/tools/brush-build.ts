import type { Input } from '../../client/input';
import type { ScriptContext } from '../../core/scene/scripts';
import type { Voxels } from '../../core/voxels/voxels';
import type { VoxelOp } from '../blueprint';
import type { EditRoomStoreApi } from '../edit-room-store';
import { useEditor } from '../editor-store';
import { playBulkEdit } from '../sounds';
import { commitVoxelOps } from '../voxel-edit';
import { applyStamp } from './brush-apply';
import { advanceBrushStroke, type BrushStrokeState, createBrushStrokeState } from './utils/brush';

export type BrushState = { brush: BrushStrokeState };
export function createBrushState(): BrushState {
    return { brush: createBrushStrokeState() };
}

const OPS_PER_PACKET = 4096;

function sendOps(ctx: ScriptContext, ops: VoxelOp[]): void {
    for (let i = 0; i < ops.length; i += OPS_PER_PACKET) {
        commitVoxelOps(ctx, ops.slice(i, i + OPS_PER_PACKET));
    }
}

function activeBlockKey(store: EditRoomStoreApi): string {
    const slot = useEditor.getState().hotbar[store.getState().activeSlotIndex];
    return slot && slot.kind === 'block' ? slot.blockKey : '';
}

export function updateBrush(state: BrushState, store: EditRoomStoreApi, ctx: ScriptContext, input: Input, voxels: Voxels): void {
    const { pattern, mask } = store.getState().brushOptions;
    advanceBrushStroke(state.brush, store, input, store.getState().brushOptions, (accumulated) => {
        const active = activeBlockKey(store);
        const forward: VoxelOp[] = [];
        const reverse: VoxelOp[] = [];
        applyStamp(accumulated, voxels, { pattern, mask }, active, forward, reverse);
        if (forward.length > 0) {
            store.getState().action({
                label: 'brush',
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
