import * as Selection from '../../core/scene/selection';
import type { Voxels } from '../../core/voxels/voxels';
import { getBlock } from '../../core/voxels/voxels';
import type { VoxelOp } from '../blueprint';
import type { BrushOptions } from '../edit-room-store';
import { testMask } from '../scene/mask';
import { samplePattern } from '../scene/pattern';

/** walk `stamp` and append a forward/reverse op for every cell that
 *  passes `opts.mask` and actually changes block key. `active` is the
 *  current hotbar block ($active pattern token). */
export function applyStamp(
    stamp: Selection.Selection,
    voxels: Voxels,
    opts: Pick<BrushOptions, 'pattern' | 'mask'>,
    active: string,
    forward: VoxelOp[],
    reverse: VoxelOp[],
    rng: () => number = Math.random,
): void {
    Selection.forEach(stamp, (wx, wy, wz) => {
        if (opts.mask && !testMask(opts.mask, voxels, wx, wy, wz, rng)) return;
        const newKey = samplePattern(opts.pattern, voxels, wx, wy, wz, active, rng);
        const oldKey = getBlock(voxels, wx, wy, wz);
        if (oldKey === newKey) return;
        forward.push({ wx, wy, wz, key: newKey });
        reverse.push({ wx, wy, wz, key: oldKey });
    });
}
