// painter tool — live-application sibling of the brush tool.
//
// shares the brush's options shape (shape/size/height/pattern/mask) and
// its cell-application step (`applyStamp`). the *only* difference is
// timing: brush accumulates a Selection mid-stroke and commits all ops
// on release, painter sends each frame's new cells live so the user sees
// the paint stream during the drag. one undo action per drag, same as
// brush.
//
// size 0 collapses the stamp to a single voxel — that's the classic
// 1-voxel paint behaviour, no separate mode needed.

import type { ScriptContext } from '../../core/scene/scripts';
import { send } from '../../core/scene/scripts';
import { VoxelEditCommand } from '../commands';
import type { Voxels } from '../../core/voxels/voxels';
import { BLOCK_AIR, getBlock } from '../../core/voxels/voxels';
import type { PointerState } from '../pointer-state';
import { pointerJustDown, pointerHeld, pointerJustUp, pointerJustRight } from '../pointer-state';
import { useEditor } from '../editor-store';
import type { EditRoomStoreApi } from '../edit-room-store';
import { activeBlockKeyOf } from '../inventory';
import type { Input } from '../../client/input';
import type { VoxelOp } from '../blueprint';
import * as Selection from '../../core/scene/selection';
import { buildShape } from '../scene/shapes';
import { applyStamp } from './brush-apply';
import { BRUSH_TINTS } from '../visuals/editor-colors';

const OPS_PER_PACKET = 4096;

function sendOps(ctx: ScriptContext, ops: VoxelOp[]): void {
    for (let i = 0; i < ops.length; i += OPS_PER_PACKET) {
        send(ctx, VoxelEditCommand, { ops: ops.slice(i, i + OPS_PER_PACKET) });
    }
}

// ── stroke state ───────────────────────────────────────────────────

/** per-room painter stroke state. created once per edit room in EditorScript
 *  onInit and threaded into `updatePainter` — never module-scoped, so two
 *  joined rooms can't share one stroke. */
export type PainterState = {
    active: boolean;
    forward: VoxelOp[];
    reverse: VoxelOp[];
    /** cells already touched this stroke — prevents re-painting on re-crossing. */
    visited: Set<string>;
    /** last cursor centre — skip the stamp rebuild when the cursor sits still. */
    lastCenter: [number, number, number] | null;
    /** idle-preview cache key (content-eq dirty check, matches brush.ts). */
    previewKey: string;
};

export function createPainterState(): PainterState {
    return {
        active: false,
        forward: [],
        reverse: [],
        visited: new Set(),
        lastCenter: null,
        previewKey: '',
    };
}

const STAMP_SCRATCH: Selection.Selection = Selection.create();

// ── per-frame update ───────────────────────────────────────────────

export function updatePainter(
    state: PainterState,
    store: EditRoomStoreApi,
    ctx: ScriptContext,
    pointer: PointerState,
    input: Input,
    voxels: Voxels,
): void {
    const justDown = pointerJustDown(pointer, input);
    const held = pointerHeld(pointer, input);
    const justUp = pointerJustUp(pointer, input);
    const cancel = pointerJustRight(input);
    const s = store.getState();
    const opts = s.paintOptions;
    const hv = s.hoverVoxel;

    // ── right-click cancel ──
    // ops already sent live cannot be unsent without an undo round-trip,
    // so cancel means "stop accumulating + don't push an undo action".
    // the painted blocks stay; the user can undo via ctrl-z if they want.
    if (state.active && cancel) {
        state.active = false;
        state.forward = [];
        state.reverse = [];
        state.visited.clear();
        state.lastCenter = null;
        return;
    }

    // ── stroke start ──
    if (justDown && !state.active) {
        state.active = true;
        state.forward = [];
        state.reverse = [];
        state.visited.clear();
        state.lastCenter = null;
    }

    // ── apply while held ──
    if (state.active && held && hv) {
        const sameAsLast =
            state.lastCenter !== null &&
            state.lastCenter[0] === hv[0] &&
            state.lastCenter[1] === hv[1] &&
            state.lastCenter[2] === hv[2];
        if (!sameAsLast) {
            state.lastCenter = [hv[0], hv[1], hv[2]];
            const active = activeBlockKeyOf(useEditor.getState().hotbar, store.getState().activeSlotIndex);
            // rasterise the stamp into the scratch Selection, but only feed
            // applyStamp the cells we haven't already painted this stroke —
            // this is what makes re-crossing painted cells a no-op.
            STAMP_SCRATCH.chunks.clear();
            STAMP_SCRATCH.nodes.clear();
            buildShape(STAMP_SCRATCH, opts.shape, hv[0], hv[1], hv[2], opts.size, opts.height);
            const fresh = Selection.create();
            Selection.forEach(STAMP_SCRATCH, (wx, wy, wz) => {
                const k = `${wx},${wy},${wz}`;
                if (state.visited.has(k)) return;
                state.visited.add(k);
                // paint is "recolour existing blocks" — air is not a block.
                // skipping air here (rather than via a default mask) keeps the
                // rule built-in: the user's mask field is purely additive
                // filtering on top of "only existing voxels".
                if (getBlock(voxels, wx, wy, wz) === BLOCK_AIR) return;
                Selection.set(fresh, wx, wy, wz);
            });
            const frameForward: VoxelOp[] = [];
            const frameReverse: VoxelOp[] = [];
            applyStamp(fresh, voxels, opts, active, frameForward, frameReverse);
            if (frameForward.length > 0) {
                // send live so the user sees the paint stream.
                sendOps(ctx, frameForward);
                for (const op of frameForward) state.forward.push(op);
                for (const op of frameReverse) state.reverse.push(op);
            }
        }
    }

    // ── release: wrap the stroke in a single undoable action ──
    // do() is a no-op on first call (ops already applied live); undo/redo
    // round-trips replay correctly via the captured arrays.
    if (state.active && (justUp || !held)) {
        if (state.forward.length > 0) {
            const forward = state.forward;
            const reverse = state.reverse;
            store.getState().action({
                label: 'paint',
                do() {
                    sendOps(ctx, forward);
                },
                undo() {
                    sendOps(ctx, reverse);
                },
            });
        }
        state.active = false;
        state.forward = [];
        state.reverse = [];
        state.visited.clear();
        state.lastCenter = null;
    }

    // ── footprint preview ──
    // shown both idle and mid-stroke: the live voxel mutations show what
    // was already painted; the cyan footprint shows where the *next* stamp
    // will land so the user can aim.
    if (hv) {
        const key = `${hv[0]},${hv[1]},${hv[2]}|${opts.shape}|${opts.size}|${opts.height}`;
        if (key !== state.previewKey) {
            state.previewKey = key;
            const sel = Selection.create();
            buildShape(sel, opts.shape, hv[0], hv[1], hv[2], opts.size, opts.height);
            store.setState({
                brush: sel,
                brushFill: BRUSH_TINTS.cyan.fill,
                brushEdges: BRUSH_TINTS.cyan.edges,
            });
        }
    } else if (state.previewKey !== '') {
        state.previewKey = '';
        store.setState({ brush: null, brushFill: null, brushEdges: null });
    }
}
