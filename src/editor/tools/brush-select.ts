// brush-select tool update function.
//
// the selection-category sibling of the brush (build) tool: same shape ×
// stroke machinery, but the accumulated footprint folds into the room
// *selection* instead of writing voxels. called each frame from
// EditorScript onFrame (client only).
//
// the store's `brush` field doubles as both the cyan hover preview (the
// configured shape rasterised at the hovered voxel) and the live stroke
// accumulator (every centre the cursor crosses while LMB is held). nothing
// touches `selection` until release — the user drags across an area, sees
// the eventual footprint, then on mouse-up the stroke is mask-filtered and
// merged into `selection` per `selectionBehavior` (replace / add, shift =
// force add, mirroring box-select). right-click cancels the stroke.
//
// like brush (build), the optional mask is applied at commit only — the
// preview always shows the full shape so the user sees the brush footprint,
// and the mask just narrows which of those cells actually get selected.

import type { ScriptContext } from '../../core/scene/scripts';
import type { Voxels } from '../../core/voxels/voxels';
import type { PointerState } from '../pointer-state';
import { pointerJustDown, pointerHeld, pointerJustUp, pointerJustRight } from '../pointer-state';
import type { Input } from '../../client/input';
import { isKeyDown } from '../../client/input';
import type { EditRoomStoreApi } from '../edit-room-store';
import * as Selection from '../../core/scene/selection';
import { buildShape } from '../scene/shapes';
import { testMask } from '../scene/mask';

// ── stroke state ───────────────────────────────────────────────────

/** per-room brush-select stroke state. created once per edit room in
 *  EditorScript onInit and threaded into `updateBrushSelect` — never
 *  module-scoped, so two joined rooms can't share one stroke flag. */
export type BrushSelectState = {
    active: boolean;
    /** centre voxel of the last stamp merged into the stroke / preview —
     *  avoids re-rasterising on every frame when the cursor sits still. */
    lastCenter: [number, number, number] | null;
    /** content-key for the idle preview ("x,y,z|shape|size|height"). a fresh
     *  Selection ref is pushed to the store only when this changes, so the
     *  brush mesh rebuilder (reference-eq dirty check) only repaints on real
     *  changes — not every frame. */
    previewKey: string;
};

export function createBrushSelectState(): BrushSelectState {
    return { active: false, lastCenter: null, previewKey: '' };
}

/** module-level scratch used to rasterise one stamp's shape before merging
 *  it into the stroke accumulator. carries no state between calls — only
 *  ever written then immediately read within a single synchronous update —
 *  so it stays module-scoped (mirrors box-select's `_queryRegion`). */
const STAMP_SCRATCH: Selection.Selection = Selection.create();

function previewKeyFor(
    center: [number, number, number],
    shape: string,
    size: number,
    height: number,
): string {
    return `${center[0]},${center[1]},${center[2]}|${shape}|${size}|${height}`;
}

// ── per-frame update ───────────────────────────────────────────────

export function updateBrushSelect(
    state: BrushSelectState,
    store: EditRoomStoreApi,
    _ctx: ScriptContext,
    pointer: PointerState,
    input: Input,
    voxels: Voxels,
): void {
    const justDown = pointerJustDown(pointer, input);
    const held = pointerHeld(pointer, input);
    const justUp = pointerJustUp(pointer, input);
    const cancel = pointerJustRight(input);
    const s = store.getState();
    const { shape, size, height, mask } = s.brushSelectOptions;
    const hv = s.hoverVoxel;

    // ── right-click cancel ──
    // discard the accumulated stamp Selection without committing; the
    // release branch is gated on state.active so it won't fire when LMB
    // eventually releases.
    if (state.active && cancel) {
        state.active = false;
        state.lastCenter = null;
        state.previewKey = '';
        store.setState({ brush: null });
        return;
    }

    // ── stroke start: clear accumulator, seed with the click cell ──
    if (justDown && !state.active) {
        state.active = true;
        state.lastCenter = null;
        const sel = Selection.create();
        if (hv) {
            buildShape(sel, shape, hv[0], hv[1], hv[2], size, height);
            state.lastCenter = [hv[0], hv[1], hv[2]];
        }
        store.setState({ brush: sel });
        state.previewKey = '';
    }

    // ── drag: OR each new centre's stamp into the accumulator ──
    if (state.active && held && hv) {
        const sameAsLast =
            state.lastCenter !== null &&
            state.lastCenter[0] === hv[0] &&
            state.lastCenter[1] === hv[1] &&
            state.lastCenter[2] === hv[2];
        if (!sameAsLast) {
            state.lastCenter = [hv[0], hv[1], hv[2]];
            const prev = store.getState().brush;
            const next = prev ? Selection.clone(prev) : Selection.create();
            STAMP_SCRATCH.chunks.clear();
            STAMP_SCRATCH.nodes.clear();
            buildShape(STAMP_SCRATCH, shape, hv[0], hv[1], hv[2], size, height);
            Selection.merge(next, STAMP_SCRATCH);
            store.setState({ brush: next });
        }
    }

    // ── release: fold the accumulated stamp into the selection ──
    if (state.active && (justUp || !held)) {
        const accumulated = store.getState().brush;
        if (accumulated && !Selection.isEmpty(accumulated)) {
            const mk = input.mouseKeyboard;
            const shiftHeld = isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight');
            const behavior = shiftHeld ? 'add' : s.selectionBehavior;

            // start from the current selection when adding, empty otherwise;
            // walk the stamp, mask-filter, and set each surviving cell.
            const next = behavior === 'add' ? Selection.clone(s.selection) : Selection.create();
            let selectedAny = false;
            Selection.forEach(accumulated, (wx, wy, wz) => {
                if (mask && !testMask(mask, voxels, wx, wy, wz, Math.random)) return;
                Selection.set(next, wx, wy, wz);
                selectedAny = true;
            });
            // only clobber the existing selection when the stroke actually
            // selected something — a stroke fully masked out (e.g. dragged
            // over air with a `#existing` mask) leaves the selection intact
            // rather than silently wiping it.
            if (selectedAny || behavior === 'add') {
                store.setState({ selection: next });
            }
        }
        state.active = false;
        state.lastCenter = null;
        state.previewKey = '';
        // fall through to the idle branch so the cursor immediately picks
        // up the shape-at-hover preview for the next stamp.
    }

    // ── idle: shape-at-hover preview ──
    if (!state.active) {
        if (hv) {
            const key = previewKeyFor(hv, shape, size, height);
            if (key !== state.previewKey) {
                state.previewKey = key;
                const sel = Selection.create();
                buildShape(sel, shape, hv[0], hv[1], hv[2], size, height);
                store.setState({ brush: sel });
            }
        } else if (state.previewKey !== '') {
            state.previewKey = '';
            store.setState({ brush: null });
        }
    }
}
