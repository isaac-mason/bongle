// shared cell-application step for brush and paint.
//
// both tools rasterise the configured shape with `buildShape`, then walk
// the resulting Selection cell-by-cell: mask-filter, pattern-sample, diff
// against the current voxel, and push forward/reverse ops. the only
// divergence between the tools is *when* those ops fly — brush batches
// on release, paint streams live during the drag — so the per-cell logic
// lives here as one function.

import * as Selection from '../../core/scene/selection';
import type { Voxels } from '../../core/voxels/voxels';
import { getBlockKey } from '../../core/voxels/voxels';
import type { VoxelOp } from '../blueprint';
import { samplePattern } from '../scene/pattern';
import { testMask } from '../scene/mask';
import type { BrushOptions } from '../edit-room-store';

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
        const oldKey = getBlockKey(voxels, wx, wy, wz);
        if (oldKey === newKey) return;
        forward.push({ wx, wy, wz, key: newKey });
        reverse.push({ wx, wy, wz, key: oldKey });
    });
}
