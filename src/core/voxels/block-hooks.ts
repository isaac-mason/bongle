// block hook dispatch, see plan-block-hooks.md for the design.
//
// one combined driver, parameterised by a SetBlockFlags mask:
//   runBlockHooks(voxels, NOTIFY_NEIGHBOURS)               // editor + recompute only
//   runBlockHooks(voxels, NOTIFY_NEIGHBOURS | FIRE_EVENTS) // server tick, recompute + observers + onNeighbourChanged
//
// runBlockHooks may be invoked inline from setBlock (per-op gameplay default)
// or in bulk from runNeighbourRecompute / runBlockEventHooks (editor command
// drain, server end-of-tick drain). per-pass cursors make every pass
// idempotent, re-running picks up only ops past the last drain cursor.
// `voxels.authority.changes.hookDrain.active` short-circuits re-entrant calls
// (e.g. a hook issues setBlock with DEFAULT flags) so the outer while-loop
// picks up the appended op naturally.
//
// the driver is depth-bounded so handler-issued setBlock chains can't
// run away. observer-issued setBlocks produce ops that the next outer
// iteration will pick up, so onBlockBuild fires for blocks placed by
// other handlers, not just by user code.
//
// the bitmask on BlockHandle._hooks tracks intrinsic hooks only.
// observer presence is tracked per-room via voxels.authority.observers.

import { SetBlockFlags } from './block-flags';
import { AIR } from './block-registry';
import type { BlockChangeCtx, BlockStateChangeCtx } from './blocks';
import { _registerBlockHooksDriver, getBlockState, setBlock, type VoxelBlockOp, type Voxels } from './voxels';

// ── intrinsic hook bitmask ──────────────────────────────────────────

export const HOOK_ON_NEIGHBOUR_UPDATE = 1 << 0;
export const HOOK_ON_NEIGHBOUR_CHANGED = 1 << 1;

// ── per-room observer registry ──────────────────────────────────────

export type BlockObserverEntry = {
    onBlockBuild?: Set<(ev: BlockChangeCtx) => void>;
    onBlockBreak?: Set<(ev: BlockChangeCtx) => void>;
    onBlockStateChange?: Set<(ev: BlockStateChangeCtx) => void>;
};

/** lazy-init observer map on first registration. caller must hold an
 *  authoritative Voxels, observers don't fire on read-only mirrors. */
export function ensureBlockObservers(voxels: Voxels): Map<number, BlockObserverEntry> {
    const auth = voxels.authority;
    if (!auth) throw new Error('[bongle] ensureBlockObservers: voxels has no authority bundle');
    if (!auth.observers) auth.observers = new Map();
    return auth.observers;
}

// ── neighbour iteration ─────────────────────────────────────────────

const NEIGHBOUR_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
];

const MAX_HOOK_DEPTH = 512;

// ── public API ──────────────────────────────────────────────────────

/**
 * editor / pure-recompute path. fires onNeighbourUpdate on the changed
 * cell and each of its 6 neighbours, depth-bounded. safe to call from
 * the editor edit-action path, no observers, no side-effect hooks.
 */
export function runNeighbourRecompute(voxels: Voxels): void {
    runBlockHooks(voxels, SetBlockFlags.NOTIFY_NEIGHBOURS);
}

/**
 * server tick path. runs recompute interleaved with onBlockBuild /
 * onBlockBreak / onBlockStateChange observers and intrinsic
 * onNeighbourChanged. handler-issued setBlocks produce more ops that
 * get processed in the same call (depth-bounded), so observer reactions
 * chain like neighbour-recompute reactions do.
 */
export function runBlockEventHooks(voxels: Voxels): void {
    runBlockHooks(voxels, SetBlockFlags.NOTIFY_NEIGHBOURS | SetBlockFlags.FIRE_EVENTS);
}

// ── driver ──────────────────────────────────────────────────────────

/**
 * fire the passes named in `mask` over `voxels.authority.changes.ops`,
 * starting from per-pass cursors that track which ops the previous call
 * already handled. inline drains from setBlock advance the cursors;
 * end-of-tick drain picks up only the tail. keeps total work O(n) across
 * n setBlock calls, never re-scans a fully-drained prefix.
 *
 * passes interleave per window so observer reactions see fully-recomputed
 * neighbour state for ops in the same batch. ops appended by hook
 * handlers extend the window and are processed in the next outer
 * iteration, depth-bounded.
 */
export function runBlockHooks(voxels: Voxels, mask: number): void {
    const auth = voxels.authority;
    if (!auth) return;
    if (mask === 0) return;

    const changes = auth.changes;
    // re-entrant call (a hook handler issued setBlock with default flags
    // and that setBlock tried to drain inline). the outer call's
    // while-loop will pick up the appended op, just return.
    if (changes.hookDrain.active) return;
    changes.hookDrain.active = true;
    try {
        const ops = changes.ops;
        const wantNeighbours = (mask & SetBlockFlags.NOTIFY_NEIGHBOURS) !== 0;
        const wantEvents = (mask & SetBlockFlags.FIRE_EVENTS) !== 0;

        let depth = 0;
        while (true) {
            const end = ops.length;
            // start each pass from its own cursor, they advance
            // independently (editor pre-drains neighbours but leaves
            // events for end-of-tick).
            const nStart = wantNeighbours ? changes.hookDrain.neighboursCursor : end;
            const eStart = wantEvents ? changes.hookDrain.eventsCursor : end;
            if (nStart >= end && eStart >= end) break;

            if (depth++ > MAX_HOOK_DEPTH) {
                console.warn('[block-hooks] depth exceeded MAX_HOOK_DEPTH; bailing');
                break;
            }

            // recompute pass. may append ops past `end`.
            if (wantNeighbours && nStart < end) {
                for (let i = nStart; i < end; i++) {
                    const op = ops[i]!;
                    if (op.kind !== 0) continue;
                    const blockOp = op as VoxelBlockOp;
                    recomputeAt(voxels, blockOp.wx, blockOp.wy, blockOp.wz);
                    for (let n = 0; n < 6; n++) {
                        const [dx, dy, dz] = NEIGHBOUR_OFFSETS[n]!;
                        recomputeAt(voxels, blockOp.wx + dx, blockOp.wy + dy, blockOp.wz + dz);
                    }
                }
                changes.hookDrain.neighboursCursor = end;
            }

            // event pass. may append ops past `end`.
            if (wantEvents && eStart < end) {
                for (let i = eStart; i < end; i++) {
                    const op = ops[i]!;
                    if (op.kind !== 0) continue;
                    fireEventsForOp(voxels, op as VoxelBlockOp);
                }
                changes.hookDrain.eventsCursor = end;
            }
        }
    } finally {
        changes.hookDrain.active = false;
    }
}

function recomputeAt(voxels: Voxels, wx: number, wy: number, wz: number): void {
    const stateId = getBlockState(voxels, wx, wy, wz);
    if (stateId === AIR) return;
    const registry = voxels.registry;
    const blockIdx = registry.stateToBlockIndex[stateId]!;
    const handle = registry.handles[blockIdx]!;
    if ((handle._hooks & HOOK_ON_NEIGHBOUR_UPDATE) === 0) return;
    const def = handle._def;
    if (!def.onNeighbourUpdate) return;
    const newId = def.onNeighbourUpdate({ voxels, worldX: wx, worldY: wy, worldZ: wz, stateId });
    if (newId === stateId) return;
    const newKey = registry.stateToKey[newId];
    if (!newKey) return;
    // BULK, outer runBlockHooks while-loop picks up the appended op; no
    // point paying the inline-drain re-entry-guard round-trip.
    setBlock(voxels, wx, wy, wz, newKey, SetBlockFlags.BULK);
}

function fireEventsForOp(voxels: Voxels, op: VoxelBlockOp): void {
    const registry = voxels.registry;
    const observers = voxels.authority?.observers ?? null;

    // observer dispatch (build / break / state change)
    if (observers) {
        const oldId = op.oldStateId;
        const newId = op.newStateId;
        const oldBlockIdx = registry.stateToBlockIndex[oldId]!;
        const newBlockIdx = registry.stateToBlockIndex[newId]!;
        const isAirOld = oldId === AIR;
        const isAirNew = newId === AIR;

        if (isAirOld && !isAirNew) {
            fireBlockBuild(observers, newBlockIdx, voxels, op.wx, op.wy, op.wz, newId);
        } else if (!isAirOld && isAirNew) {
            fireBlockBreak(observers, oldBlockIdx, voxels, op.wx, op.wy, op.wz, oldId);
        } else if (!isAirOld && !isAirNew) {
            if (oldBlockIdx === newBlockIdx) {
                if (oldId !== newId) {
                    fireBlockStateChange(observers, newBlockIdx, voxels, op.wx, op.wy, op.wz, newId, oldId);
                }
            } else {
                fireBlockBreak(observers, oldBlockIdx, voxels, op.wx, op.wy, op.wz, oldId);
                fireBlockBuild(observers, newBlockIdx, voxels, op.wx, op.wy, op.wz, newId);
            }
        }
    }

    // intrinsic onNeighbourChanged on the 6 neighbours
    for (let n = 0; n < 6; n++) {
        const [dx, dy, dz] = NEIGHBOUR_OFFSETS[n]!;
        const nwx = op.wx + dx;
        const nwy = op.wy + dy;
        const nwz = op.wz + dz;
        const neighbourId = getBlockState(voxels, nwx, nwy, nwz);
        if (neighbourId === AIR) continue;
        const neighbourBlockIdx = registry.stateToBlockIndex[neighbourId]!;
        const neighbourHandle = registry.handles[neighbourBlockIdx]!;
        if ((neighbourHandle._hooks & HOOK_ON_NEIGHBOUR_CHANGED) === 0) continue;
        const def = neighbourHandle._def;
        if (!def.onNeighbourChanged) continue;
        def.onNeighbourChanged({ voxels, worldX: nwx, worldY: nwy, worldZ: nwz, stateId: neighbourId });
    }
}

function fireBlockBuild(
    observers: Map<number, BlockObserverEntry>,
    blockIdx: number,
    voxels: Voxels,
    wx: number,
    wy: number,
    wz: number,
    stateId: number,
): void {
    const entry = observers.get(blockIdx);
    if (!entry?.onBlockBuild) return;
    const ctx: BlockChangeCtx = { voxels, worldX: wx, worldY: wy, worldZ: wz, stateId };
    for (const fn of entry.onBlockBuild) fn(ctx);
}

function fireBlockBreak(
    observers: Map<number, BlockObserverEntry>,
    blockIdx: number,
    voxels: Voxels,
    wx: number,
    wy: number,
    wz: number,
    stateId: number,
): void {
    const entry = observers.get(blockIdx);
    if (!entry?.onBlockBreak) return;
    const ctx: BlockChangeCtx = { voxels, worldX: wx, worldY: wy, worldZ: wz, stateId };
    for (const fn of entry.onBlockBreak) fn(ctx);
}

function fireBlockStateChange(
    observers: Map<number, BlockObserverEntry>,
    blockIdx: number,
    voxels: Voxels,
    wx: number,
    wy: number,
    wz: number,
    stateId: number,
    oldStateId: number,
): void {
    const entry = observers.get(blockIdx);
    if (!entry?.onBlockStateChange) return;
    const ctx: BlockStateChangeCtx = { voxels, worldX: wx, worldY: wy, worldZ: wz, stateId, oldStateId };
    for (const fn of entry.onBlockStateChange) fn(ctx);
}

// register the driver with voxels.ts so setBlock can drain inline without
// importing this module directly (avoids an ESM value cycle).
_registerBlockHooksDriver(runBlockHooks);
