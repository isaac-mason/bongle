// commitVoxelOps — ship voxel edit ops to the server AND apply them eagerly
// to the local client voxels, so the change is visible this frame instead of
// one server round-trip later.
//
// the client's `ctx.voxels.authority` is null (authority lives only on the
// server room), so the local setBlock is a pure data write + remesh-dirty
// mark: it records no change ops, fires no block hooks, and seeds no light.
// the server's voxel_chunk_ops / voxel_chunk_light echo reconciles palette,
// hook cascades (fence/door connections), and authoritative lighting a
// round-trip later. placed-block lighting therefore lags by one round-trip,
// which is an accepted tradeoff for snappy placement.
//
// the authority guard keeps this strictly a client-side optimistic apply: on
// the server the same ops settle through the VoxelEditCommand listener, so a
// local apply here would double-write.

import type { ScriptContext } from '../core/scene/scripts';
import { send } from '../core/scene/scripts';
import { SetBlockFlags } from '../core/voxels/block-flags';
import { setBlock } from '../core/voxels/voxels';
import type { VoxelOp } from './blueprint';
import { VoxelEditCommand } from './commands';

export function commitVoxelOps(ctx: ScriptContext, ops: VoxelOp[]): void {
    if (!ctx.voxels.authority) {
        for (const op of ops) {
            setBlock(ctx.voxels, op.wx, op.wy, op.wz, op.key, SetBlockFlags.BULK);
        }
    }
    send(ctx, VoxelEditCommand, { ops });
}
