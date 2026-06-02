// brush tool update function.
//
// called each frame from EditorScript onFrame (client only). drives the
// store's `brush` field (the cyan-rendered any-shape Selection) as both:
//   - idle preview: the configured shape rasterised at the hovered voxel
//     so the user sees where the next stamp lands before clicking.
//   - active stroke: a Selection accumulating every centre the cursor
//     crosses while LMB is held. nothing is written to voxels until
//     release — the user can drag across an area, see the eventual
//     footprint, and back out by releasing on empty space (Esc would
//     also work via a cancel branch later if wanted).
//
// commit on mouse-up runs the accumulated Selection through the same
// resolveFill machinery as /set, producing one undoable action per
// stroke. shape rasterisation is shared with the selection-bound verbs
// via scene/shapes.buildShape.

import type { ScriptContext } from '../../core/scene/scripts';
import { send } from '../../core/scene/scripts';
import { VoxelEditCommand } from '../commands';
import type { Voxels } from '../../core/voxels/voxels';
import type { PointerState } from '../pointer-state';
import { pointerJustDown, pointerHeld, pointerJustUp, pointerJustRight } from '../pointer-state';
import type { Input } from '../../client/input';
import type { EditRoomStoreApi } from '../edit-room-store';
import * as Selection from '../../core/scene/selection';
import { buildShape } from '../scene/shapes';
import { applyStamp } from './brush-apply';
import { useEditor } from '../editor-store';
import type { VoxelOp } from '../blueprint';

const OPS_PER_PACKET = 4096;

function sendOps(ctx: ScriptContext, ops: VoxelOp[]): void {
    for (let i = 0; i < ops.length; i += OPS_PER_PACKET) {
        send(ctx, VoxelEditCommand, { ops: ops.slice(i, i + OPS_PER_PACKET) });
    }
}

// ── stroke state ───────────────────────────────────────────────────

let _strokeActive = false;
/** centre voxel of the last stamp merged into the stroke / preview —
 *  avoids re-rasterising on every frame when the cursor sits still. */
let _lastCenter: [number, number, number] | null = null;
/** content-key for the idle preview ("x,y,z|shape|size|height"). a fresh
 *  Selection ref is pushed to the store only when this changes, so the
 *  cyan mesh rebuilder (reference-eq dirty check) only repaints on real
 *  changes — not every frame. */
let _previewKey = '';

/** module-level scratch used to rasterise one stamp's shape before
 *  merging it into the stroke accumulator. */
const STAMP_SCRATCH: Selection.Selection = Selection.create();

function activeBlockKey(store: EditRoomStoreApi): string {
    const slot = useEditor.getState().hotbar[store.getState().activeSlotIndex];
    return slot && slot.kind === 'block' ? slot.blockKey : '';
}

function previewKeyFor(
    center: [number, number, number],
    shape: string,
    size: number,
    height: number,
): string {
    return `${center[0]},${center[1]},${center[2]}|${shape}|${size}|${height}`;
}

// ── per-frame update ───────────────────────────────────────────────

export function updateBrush(
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
    const { shape, size, height, pattern, mask } = s.brushOptions;
    const hv = s.hoverVoxel;

    // ── right-click cancel ──
    // discard the accumulated stamp Selection without committing; the
    // release branch is gated on _strokeActive so it won't fire when LMB
    // eventually releases.
    if (_strokeActive && cancel) {
        _strokeActive = false;
        _lastCenter = null;
        _previewKey = '';
        store.setState({ brush: null });
        return;
    }

    // ── stroke start: clear accumulator, seed with the click cell ──
    if (justDown && !_strokeActive) {
        _strokeActive = true;
        _lastCenter = null;
        const sel = Selection.create();
        if (hv) {
            buildShape(sel, shape, hv[0], hv[1], hv[2], size, height);
            _lastCenter = [hv[0], hv[1], hv[2]];
        }
        store.setState({ brush: sel });
        _previewKey = '';
    }

    // ── drag: OR each new centre's stamp into the accumulator ──
    if (_strokeActive && held && hv) {
        const sameAsLast =
            _lastCenter !== null &&
            _lastCenter[0] === hv[0] &&
            _lastCenter[1] === hv[1] &&
            _lastCenter[2] === hv[2];
        if (!sameAsLast) {
            _lastCenter = [hv[0], hv[1], hv[2]];
            const prev = store.getState().brush;
            const next = prev ? Selection.clone(prev) : Selection.create();
            STAMP_SCRATCH.chunks.clear();
            STAMP_SCRATCH.nodes.clear();
            buildShape(STAMP_SCRATCH, shape, hv[0], hv[1], hv[2], size, height);
            Selection.merge(next, STAMP_SCRATCH);
            store.setState({ brush: next });
        }
    }

    // ── release: commit the accumulated Selection in one action ──
    if (_strokeActive && (justUp || !held)) {
        const accumulated = store.getState().brush;
        if (accumulated && !Selection.isEmpty(accumulated)) {
            const active = activeBlockKey(store);
            const forward: VoxelOp[] = [];
            const reverse: VoxelOp[] = [];
            applyStamp(accumulated, voxels, { pattern, mask }, active, forward, reverse);
            if (forward.length > 0) {
                store.getState().action({
                    label: 'brush',
                    do() {
                        sendOps(ctx, forward);
                    },
                    undo() {
                        sendOps(ctx, reverse);
                    },
                });
            }
        }
        _strokeActive = false;
        _lastCenter = null;
        _previewKey = '';
        // fall through to the idle branch so the cursor immediately picks
        // up the shape-at-hover preview for the next stamp.
    }

    // ── idle: shape-at-hover preview ──
    if (!_strokeActive) {
        if (hv) {
            const key = previewKeyFor(hv, shape, size, height);
            if (key !== _previewKey) {
                _previewKey = key;
                const sel = Selection.create();
                buildShape(sel, shape, hv[0], hv[1], hv[2], size, height);
                store.setState({ brush: sel });
            }
        } else if (_previewKey !== '') {
            _previewKey = '';
            store.setState({ brush: null });
        }
    }
}
