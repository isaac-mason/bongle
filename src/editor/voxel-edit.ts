import type { ScriptContext } from '../core/scene/scripts';
import { send } from '../core/scene/scripts';
import { SetBlockFlags } from '../core/voxels/block-flags';
import { setBlock } from '../core/voxels/voxels';
import type { VoxelOp } from './blueprint';
import { VoxelEditCommand } from './commands';

// applies ops eagerly to local client voxels (ctx.voxels.authority is null there, so this is a
// pure data write, no hooks or light) so placement is visible this frame; the server's echo
// reconciles hooks and lighting a round-trip later. the authority guard avoids a double-write
// on the server, where the same ops settle through the VoxelEditCommand listener.
export function commitVoxelOps(ctx: ScriptContext, ops: VoxelOp[]): void {
    if (!ctx.voxels.authority) {
        for (const op of ops) {
            setBlock(ctx.voxels, op.wx, op.wy, op.wz, op.key, SetBlockFlags.BULK);
        }
    }
    send(ctx, VoxelEditCommand, { ops });
}
