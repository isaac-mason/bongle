// magic select tool.
//
// click a voxel -> BFS flood-fill expands outward to all "matching" voxels.
// what "matching" means is controlled by MagicSelectOptions.compareType.
// directional constraints (up/down/horizontal/corners) and gap-jumping (range)
// further shape the expansion.
//
// called each frame from EditorScript.onFrame (client only).
// uses the shared PointerState for click detection and editor.hoverVoxel
// for the seed voxel (raycast runs once per frame in editor/index.ts).

import type { Input } from '../../client/input';
import { isKeyDown } from '../../client/input';
import * as Selection from '../../core/scene/selection';
import type { Blocks } from '../../core/voxels/block-registry';
import { AIR } from '../../core/voxels/block-registry';
import type { Voxels } from '../../core/voxels/voxels';
import { getBlockState } from '../../core/voxels/voxels';
import type { EditRoomStoreApi, MagicSelectOptions } from '../edit-room-store';
import type { PointerState } from '../pointer-state';
import { pointerJustDown } from '../pointer-state';

// ── neighbour generation ───────────────────────────────────────────
//
// build the list of (dx,dy,dz) offsets to expand into, respecting
// the up/down/horizontal and corners options.
//
// 6-connectivity: face neighbours only (|dx|+|dy|+|dz| === 1)
// 26-connectivity: add edge- and corner-touching cells
//
// a diagonal cell is allowed only if all of its non-zero axes are
// permitted. e.g. (+1, +1, 0) is allowed only if horizontal && up (or down).

function buildNeighbourOffsets(opts: MagicSelectOptions): Array<[number, number, number]> {
    const result: Array<[number, number, number]> = [];

    for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0 && dz === 0) continue;

                // check each non-zero axis against the direction constraints
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

// ── match predicate ────────────────────────────────────────────────

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
            // cull[0] = CullType.NONE, any non-zero cull type is "solid"
            return (sid) => sid !== AIR && blocks.cull[sid]! !== 0;
        case 'any':
            return (sid) => sid !== AIR;
    }
}

// ── BFS ────────────────────────────────────────────────────────────

function runBFS(
    seed: [number, number, number],
    voxels: Voxels,
    blocks: Blocks,
    opts: MagicSelectOptions,
): Selection.Selection {
    const result = Selection.create();

    const [sx, sy, sz] = seed;
    const seedStateId = getBlockState(voxels, sx, sy, sz);

    // nothing to do if seed is air
    if (seedStateId === AIR) return result;

    const seedBlockTypeId = blocks.blockTypeId[seedStateId]!;
    const matches = makeMatchFn(opts, seedStateId, seedBlockTypeId, blocks);

    // guard: seed itself must match
    if (!matches(seedStateId)) return result;

    const offsets = buildNeighbourOffsets(opts);
    const { limit, range } = opts;

    // visited set, keyed as "wx,wy,wz" strings. bounded by limit so acceptable cost.
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

        // enqueue neighbours, with gap-jumping for range > 1
        for (const [dx, dy, dz] of offsets) {
            for (let step = 1; step <= range; step++) {
                const nx = cx + dx * step;
                const ny = cy + dy * step;
                const nz = cz + dz * step;
                const key = `${nx},${ny},${nz}`;
                if (!visited.has(key)) {
                    visited.add(key);
                    // for gap > 1 we still need to enqueue intermediate empty cells
                    // so the BFS can "see through" them, only add if potentially reachable.
                    // we skip if a previous step was non-matching (gap too wide).
                    // note: the matches check at the top of the loop handles the filtering.
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

    // surface-only post pass: remove interior voxels (those fully surrounded by matching voxels)
    if (opts.surfaceOnly) {
        const interior: Array<[number, number, number]> = [];
        Selection.forEach(result, (wx, wy, wz) => {
            let exposed = false;
            for (const [dx, dy, dz] of offsets) {
                const nx = wx + dx;
                const ny = wy + dy;
                const nz = wz + dz;
                // exposed if the neighbour is not in the selection
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

// ── per-frame update ───────────────────────────────────────────────

export function updateMagicSelect(
    store: EditRoomStoreApi,
    pointer: PointerState,
    input: Input,
    voxels: Voxels,
    blocks: Blocks,
): void {
    const justDown = pointerJustDown(pointer, input);
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

    store.setState({ selection: next });
}
