// block hook dispatch. setChunkBlock settles a write inline via two functions,
// one per flag bit:
//   runBlockHooks  (BLOCK_HOOKS)  — block-def onNeighbourUpdate/onNeighbourChanged
//   runBlockEvents (BLOCK_EVENTS) — script observers (onBlockBuild/Break/StateChange)
// a recompute that changes a block chains a setBlock(BULK) that recurses back
// into runBlockHooks; auth.hookDepth bounds the cascade.

import { SetBlockFlags } from './block-flags';
import { AIR } from './block-registry';
import type { BlockChangeCtx, BlockStateChangeCtx } from './blocks';
import { getBlockState, setBlock, type Voxels } from './voxels';

export const HOOK_ON_NEIGHBOUR_UPDATE = 1 << 0;
export const HOOK_ON_NEIGHBOUR_CHANGED = 1 << 1;

export type BlockObserverEntry = {
    onBlockBuild?: Set<(ev: BlockChangeCtx) => void>;
    onBlockBreak?: Set<(ev: BlockChangeCtx) => void>;
    onBlockStateChange?: Set<(ev: BlockStateChangeCtx) => void>;
};

/** lazy-init the per-room observer map. observers only exist on an authoritative
 *  Voxels, never a read-only mirror. */
export function ensureBlockObservers(voxels: Voxels): Map<number, BlockObserverEntry> {
    const auth = voxels.authority;
    if (!auth) throw new Error('[bongle] ensureBlockObservers: voxels has no authority bundle');
    auth.observers ??= new Map();
    return auth.observers;
}

const NEIGHBOUR_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
];

const MAX_HOOK_DEPTH = 512;

/** BLOCK_HOOKS: recompute this cell + its 6 neighbours (onNeighbourUpdate), then
 *  fire their onNeighbourChanged. runs for DEFAULT and BULK — bulk-authored
 *  fences still join. */
export function runBlockHooks(voxels: Voxels, wx: number, wy: number, wz: number): void {
    const auth = voxels.authority;
    if (!auth) return;
    if (auth.hookDepth >= MAX_HOOK_DEPTH) {
        console.warn('[block-hooks] MAX_HOOK_DEPTH exceeded; bailing');
        return;
    }
    auth.hookDepth++;
    try {
        recomputeAt(voxels, wx, wy, wz);
        for (let n = 0; n < 6; n++) {
            const [dx, dy, dz] = NEIGHBOUR_OFFSETS[n]!;
            recomputeAt(voxels, wx + dx, wy + dy, wz + dz);
        }
        fireNeighbourChanged(voxels, wx, wy, wz);
    } finally {
        auth.hookDepth--;
    }
}

/** BLOCK_EVENTS: fire this write's script observers. DEFAULT-only; call after
 *  runBlockHooks so observers see settled state. */
export function runBlockEvents(
    voxels: Voxels,
    wx: number,
    wy: number,
    wz: number,
    oldStateId: number,
    newStateId: number,
): void {
    const observers = voxels.authority?.observers;
    if (!observers) return;
    const { stateToBlockIndex } = voxels.registry;
    const oldBlock = stateToBlockIndex[oldStateId]!;
    const newBlock = stateToBlockIndex[newStateId]!;
    const wasAir = oldStateId === AIR;
    const isAir = newStateId === AIR;
    const at = { voxels, worldX: wx, worldY: wy, worldZ: wz };

    if (wasAir && !isAir) {
        emit(observers.get(newBlock)?.onBlockBuild, { ...at, stateId: newStateId });
    } else if (!wasAir && isAir) {
        emit(observers.get(oldBlock)?.onBlockBreak, { ...at, stateId: oldStateId });
    } else if (oldBlock !== newBlock) {
        emit(observers.get(oldBlock)?.onBlockBreak, { ...at, stateId: oldStateId });
        emit(observers.get(newBlock)?.onBlockBuild, { ...at, stateId: newStateId });
    } else if (oldStateId !== newStateId) {
        emit(observers.get(newBlock)?.onBlockStateChange, { ...at, stateId: newStateId, oldStateId });
    }
}

function emit<T>(fns: Set<(ev: T) => void> | undefined, ev: T): void {
    if (fns) for (const fn of fns) fn(ev);
}

function recomputeAt(voxels: Voxels, wx: number, wy: number, wz: number): void {
    const stateId = getBlockState(voxels, wx, wy, wz);
    if (stateId === AIR) return;
    const { stateToBlockIndex, handles, stateToKey } = voxels.registry;
    const handle = handles[stateToBlockIndex[stateId]!]!;
    if ((handle._hooks & HOOK_ON_NEIGHBOUR_UPDATE) === 0) return;
    const newId = handle._def.onNeighbourUpdate?.({ voxels, worldX: wx, worldY: wy, worldZ: wz, stateId });
    if (newId === undefined || newId === stateId) return;
    const newKey = stateToKey[newId];
    if (!newKey) return;
    // structural change, not a gameplay action → BULK; recurses to settle its own
    // neighbourhood.
    setBlock(voxels, wx, wy, wz, newKey, SetBlockFlags.BULK);
}

function fireNeighbourChanged(voxels: Voxels, wx: number, wy: number, wz: number): void {
    const { stateToBlockIndex, handles } = voxels.registry;
    for (let n = 0; n < 6; n++) {
        const [dx, dy, dz] = NEIGHBOUR_OFFSETS[n]!;
        const nwx = wx + dx;
        const nwy = wy + dy;
        const nwz = wz + dz;
        const stateId = getBlockState(voxels, nwx, nwy, nwz);
        if (stateId === AIR) continue;
        const handle = handles[stateToBlockIndex[stateId]!]!;
        if ((handle._hooks & HOOK_ON_NEIGHBOUR_CHANGED) === 0) continue;
        handle._def.onNeighbourChanged?.({ voxels, worldX: nwx, worldY: nwy, worldZ: nwz, stateId });
    }
}
