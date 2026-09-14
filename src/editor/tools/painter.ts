import type { Input } from '../../client/input';
import { isMouseDown, isMouseJustDown, isMouseJustUp } from '../../client/input';
import type { ScriptContext } from '../../core/scene/scripts';
import * as Selection from '../../core/scene/selection';
import type { Voxels } from '../../core/voxels/voxels';
import { BLOCK_AIR, getBlock } from '../../core/voxels/voxels';
import type { VoxelOp } from '../blueprint';
import type { EditRoomStoreApi } from '../edit-room-store';
import { useEditor } from '../editor-store';
import { activeBlockKeyOf } from '../inventory';
import { buildShape } from '../scene/shapes';
import { playBulkEdit } from '../sounds';
import { commitVoxelOps } from '../voxel-edit';
import { applyStamp } from './brush-apply';

const OPS_PER_PACKET = 4096;

function sendOps(ctx: ScriptContext, ops: VoxelOp[]): void {
    for (let i = 0; i < ops.length; i += OPS_PER_PACKET) {
        commitVoxelOps(ctx, ops.slice(i, i + OPS_PER_PACKET));
    }
}

/** per-room painter stroke state, created once per edit room and threaded into `updatePainter`
 *  rather than module-scoped, so two joined rooms don't share one stroke. */
export type PainterState = {
    active: boolean;
    forward: VoxelOp[];
    reverse: VoxelOp[];
    /** cells already touched this stroke, prevents re-painting on re-crossing */
    visited: Set<string>;
    /** last cursor centre, skips the stamp rebuild when the cursor sits still */
    lastCenter: [number, number, number] | null;
    /** idle-preview cache key, content-eq dirty check matching brush.ts */
    previewKey: string;
    /** last stroke sfx timestamp, ms */
    lastSoundAt: number;
};

export function createPainterState(): PainterState {
    return {
        active: false,
        forward: [],
        reverse: [],
        visited: new Set(),
        lastCenter: null,
        previewKey: '',
        lastSoundAt: 0,
    };
}

/** minimum gap between stroke sfx, ms; caps retrigger rate on a fast drag into a stream of clips */
const STROKE_SOUND_MS = 80;

const STAMP_SCRATCH: Selection.Selection = Selection.create();

export function updatePainter(
    state: PainterState,
    store: EditRoomStoreApi,
    ctx: ScriptContext,
    input: Input,
    voxels: Voxels,
): void {
    const mk = input.mouseKeyboard;
    const justDown = isMouseJustDown(mk, 'left');
    const held = isMouseDown(mk, 'left');
    const justUp = isMouseJustUp(mk, 'left');
    const cancel = isMouseJustDown(mk, 'right');
    const s = store.getState();
    const opts = s.paintOptions;
    const hv = s.hoverVoxel;

    // ops already sent live can't be unsent without an undo round-trip, so cancel means stop
    // accumulating without pushing an undo action; the painted blocks stay until ctrl-z
    if (state.active && cancel) {
        state.active = false;
        state.forward = [];
        state.reverse = [];
        state.visited.clear();
        state.lastCenter = null;
        state.lastSoundAt = 0;
        return;
    }

    if (justDown && !state.active) {
        state.active = true;
        state.forward = [];
        state.reverse = [];
        state.visited.clear();
        state.lastCenter = null;
        state.lastSoundAt = 0;
    }

    if (state.active && held && hv) {
        const sameAsLast =
            state.lastCenter !== null &&
            state.lastCenter[0] === hv[0] &&
            state.lastCenter[1] === hv[1] &&
            state.lastCenter[2] === hv[2];
        if (!sameAsLast) {
            state.lastCenter = [hv[0], hv[1], hv[2]];
            const active = activeBlockKeyOf(useEditor.getState().hotbar, store.getState().activeSlotIndex);
            // only feeds applyStamp cells not already painted this stroke, making re-crossing a no-op
            STAMP_SCRATCH.chunks.clear();
            STAMP_SCRATCH.nodes.clear();
            buildShape(STAMP_SCRATCH, opts.shape, hv[0], hv[1], hv[2], opts.size, opts.height);
            const fresh = Selection.create();
            Selection.forEach(STAMP_SCRATCH, (wx, wy, wz) => {
                const k = `${wx},${wy},${wz}`;
                if (state.visited.has(k)) return;
                state.visited.add(k);
                // paint recolours existing blocks only; skipping air here keeps that rule built-in
                // rather than folded into the user's mask field
                if (getBlock(voxels, wx, wy, wz) === BLOCK_AIR) return;
                Selection.set(fresh, wx, wy, wz);
            });
            const frameForward: VoxelOp[] = [];
            const frameReverse: VoxelOp[] = [];
            applyStamp(fresh, voxels, opts, active, frameForward, frameReverse);
            if (frameForward.length > 0) {
                sendOps(ctx, frameForward);
                // one clip per cadence tick, characterising the cells painted this frame
                const now = performance.now();
                if (now - state.lastSoundAt >= STROKE_SOUND_MS) {
                    state.lastSoundAt = now;
                    playBulkEdit(ctx, frameForward, frameReverse);
                }
                for (const op of frameForward) state.forward.push(op);
                for (const op of frameReverse) state.reverse.push(op);
            }
        }
    }

    // wraps the stroke in a single undoable action; do() is a no-op on first call since ops
    // were already applied live
    if (state.active && (justUp || !held)) {
        if (state.forward.length > 0) {
            const forward = state.forward;
            const reverse = state.reverse;
            // the stroke already made its own noise, so the closing dispatch stays quiet;
            // a later redo has no cadence behind it and speaks for the whole stroke
            let live = true;
            store.getState().action({
                label: 'paint',
                do() {
                    sendOps(ctx, forward);
                    if (live) live = false;
                    else playBulkEdit(ctx, forward, reverse);
                },
                undo() {
                    sendOps(ctx, reverse);
                    playBulkEdit(ctx, reverse, forward);
                },
            });
        }
        state.active = false;
        state.forward = [];
        state.reverse = [];
        state.visited.clear();
        state.lastCenter = null;
        state.lastSoundAt = 0;
    }

    // shown both idle and mid-stroke; the footprint shows where the next stamp will land
    if (hv) {
        const key = `${hv[0]},${hv[1]},${hv[2]}|${opts.shape}|${opts.size}|${opts.height}`;
        if (key !== state.previewKey) {
            state.previewKey = key;
            const sel = Selection.create();
            buildShape(sel, opts.shape, hv[0], hv[1], hv[2], opts.size, opts.height);
            // null tint uses the default flowing rainbow brush
            store.setState({ brush: sel, brushFill: null, brushEdges: null });
        }
    } else if (state.previewKey !== '') {
        state.previewKey = '';
        store.setState({ brush: null, brushFill: null, brushEdges: null });
    }
}
