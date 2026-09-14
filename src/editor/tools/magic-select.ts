import type { Input } from '../../client/input';
import { isKeyDown, isMouseJustDown } from '../../client/input';
import type { ScriptContext } from '../../core/scene/scripts';
import * as Selection from '../../core/scene/selection';
import type { Blocks } from '../../core/voxels/block-registry';
import { AIR } from '../../core/voxels/block-registry';
import type { Voxels } from '../../core/voxels/voxels';
import { getBlockState } from '../../core/voxels/voxels';
import type { EditRoomStoreApi, MagicSelectOptions } from '../edit-room-store';
import { playSelected } from '../sounds';

// builds (dx,dy,dz) offsets to expand into: 6-connectivity is face neighbours only
// (|dx|+|dy|+|dz| === 1), 26-connectivity adds edge/corner cells. a diagonal cell is allowed
// only if all of its non-zero axes are permitted, e.g. (+1, +1, 0) needs horizontal && up.
function buildNeighbourOffsets(opts: MagicSelectOptions): Array<[number, number, number]> {
    const result: Array<[number, number, number]> = [];

    for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0 && dz === 0) continue;

                if (dy > 0 && !opts.up) continue;
                if (dy < 0 && !opts.down) continue;
                if ((dx !== 0 || dz !== 0) && !opts.horizontal) continue;

                // without corners, restrict to face-adjacent (manhattan distance == 1)
                if (!opts.corners && Math.abs(dx) + Math.abs(dy) + Math.abs(dz) !== 1) continue;

                result.push([dx, dy, dz]);
            }
        }
    }

    return result;
}

function makeMatchFn(
    opts: MagicSelectOptions,
    seedStateId: number,
    seedBlockTypeId: number,
    blocks: Blocks,
): (stateId: number) => boolean {
    switch (opts.compareType) {
        case 'block':
            return (sid) => sid !== AIR && blocks.blockTypeId[sid] === seedBlockTypeId;
        case 'blockstate':
            return (sid) => sid === seedStateId;
        case 'solid':
            // cull[0] is CullType.NONE; any non-zero cull type counts as solid
            return (sid) => sid !== AIR && blocks.cull[sid]! !== 0;
        case 'any':
            return (sid) => sid !== AIR;
    }
}

function runBFS(seed: [number, number, number], voxels: Voxels, blocks: Blocks, opts: MagicSelectOptions): Selection.Selection {
    const result = Selection.create();

    const [sx, sy, sz] = seed;
    const seedStateId = getBlockState(voxels, sx, sy, sz);

    if (seedStateId === AIR) return result;

    const seedBlockTypeId = blocks.blockTypeId[seedStateId]!;
    const matches = makeMatchFn(opts, seedStateId, seedBlockTypeId, blocks);

    if (!matches(seedStateId)) return result;

    const offsets = buildNeighbourOffsets(opts);
    const { limit, range } = opts;

    // visited set bounded by limit, so its cost stays acceptable
    const visited = new Set<string>();
    const queue: Array<[number, number, number]> = [[sx, sy, sz]];
    visited.add(`${sx},${sy},${sz}`);
    let count = 0;

    while (queue.length > 0 && count < limit) {
        const item = queue.shift()!;
        const [cx, cy, cz] = item;

        const sid = getBlockState(voxels, cx, cy, cz);
        if (!matches(sid)) continue;

        Selection.set(result, cx, cy, cz);
        count++;

        for (const [dx, dy, dz] of offsets) {
            for (let step = 1; step <= range; step++) {
                const nx = cx + dx * step;
                const ny = cy + dy * step;
                const nz = cz + dz * step;
                const key = `${nx},${ny},${nz}`;
                if (!visited.has(key)) {
                    visited.add(key);
                    // for gap > 1, enqueue only if the previous step was air, so the BFS can
                    // "see through" empty gaps without jumping across a non-matching block
                    if (
                        step === 1 ||
                        getBlockState(voxels, cx + dx * (step - 1), cy + dy * (step - 1), cz + dz * (step - 1)) === AIR
                    ) {
                        queue.push([nx, ny, nz]);
                    }
                }
            }
        }
    }

    // removes interior voxels, those fully surrounded by matching voxels
    if (opts.surfaceOnly) {
        const interior: Array<[number, number, number]> = [];
        Selection.forEach(result, (wx, wy, wz) => {
            let exposed = false;
            for (const [dx, dy, dz] of offsets) {
                const nx = wx + dx;
                const ny = wy + dy;
                const nz = wz + dz;
                if (!Selection.has(result, nx, ny, nz)) {
                    exposed = true;
                    break;
                }
            }
            if (!exposed) interior.push([wx, wy, wz]);
        });
        for (const [wx, wy, wz] of interior) {
            Selection.unset(result, wx, wy, wz);
        }
    }

    return result;
}

export function updateMagicSelect(
    store: EditRoomStoreApi,
    ctx: ScriptContext,
    input: Input,
    voxels: Voxels,
    blocks: Blocks,
): void {
    const justDown = isMouseJustDown(input.mouseKeyboard, 'left');
    if (!justDown) return;

    // magic-select is voxel-only, skip when target restricts to nodes
    const s = store.getState();
    const { selectionBehavior, magicSelectOptions, selectTarget } = s;
    if (selectTarget === 'nodes') return;

    const hv = s.hoverVoxel;
    if (!hv) return;

    const seed: [number, number, number] = [hv[0], hv[1], hv[2]];
    const bfsResult = runBFS(seed, voxels, blocks, magicSelectOptions);

    const mk = input.mouseKeyboard;
    const shiftHeld = isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight');
    const effectiveBehavior = shiftHeld ? 'add' : selectionBehavior;

    let next: Selection.Selection;
    if (effectiveBehavior === 'add') {
        next = Selection.clone(s.selection);
        Selection.merge(next, bfsResult);
    } else {
        next = bfsResult;
        next.nodes = new Set(s.selection.nodes); // preserve current node selection
    }

    store.getState().replaceSelection(next);
    playSelected(ctx, effectiveBehavior === 'add');
}
