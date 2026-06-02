// shared pointer state for the voxel editor.
//
// tracks canvas mouse position (NDC) and button state. all tools consume
// this instead of each registering their own event listeners.
//
// the hover raycast runs once per frame in editor/index.ts and writes
// editor.hoverVoxel — tools read that for hit voxel position.

import { isMouseDown, isMouseJustDown, isMouseJustUp } from '../client/input';
import type { Input } from '../client/input';

export type PointerState = {
    // mouse position in NDC space, updated via canvas mousemove
    ndcX: number;
    ndcY: number;

    // mouse position in canvas-relative CSS pixels (same coordinate space
    // the React viewport overlay uses). frozen under pointer lock just like ndc.
    screenX: number;
    screenY: number;

    // canvas-sourced click/held/release flags (left button only).
    // under pointer lock, canvas events are suppressed — callers should
    // fall back to the engine input system (isMouseJustDown etc).
    _justClicked: number; // incremented by mousedown, consumed each frame
    _mouseHeld: boolean;
    _justUp: boolean;

    // event handlers stored for removal on dispose
    _onMouseMove: (e: MouseEvent) => void;
    _onMouseDown: (e: MouseEvent) => void;
    _onMouseUp: (e: MouseEvent) => void;
    _onPointerLockChange: () => void;
};

export function createPointerState(canvas: HTMLCanvasElement): PointerState {
    const state: PointerState = {
        ndcX: 0,
        ndcY: 0,
        screenX: 0,
        screenY: 0,
        _justClicked: 0,
        _mouseHeld: false,
        _justUp: false,
        _onMouseMove: null!,
        _onMouseDown: null!,
        _onMouseUp: null!,
        _onPointerLockChange: null!,
    };

    state._onMouseMove = (e: MouseEvent) => {
        // under pointer lock the cursor is hidden and bound to crosshair —
        // freeze ndc at (0, 0) so editor raycasts hit screen center.
        if (document.pointerLockElement) return;
        const rect = canvas.getBoundingClientRect();
        state.screenX = e.clientX - rect.left;
        state.screenY = e.clientY - rect.top;
        state.ndcX = (state.screenX / rect.width) * 2 - 1;
        state.ndcY = -((state.screenY / rect.height) * 2 - 1);
    };

    state._onPointerLockChange = () => {
        if (document.pointerLockElement) {
            state.ndcX = 0;
            state.ndcY = 0;
        }
        // on unlock, leave (0, 0) until the next mousemove refreshes ndc.
    };

    state._onMouseDown = (e: MouseEvent) => {
        if (e.button === 0) {
            state._justClicked++;
            state._mouseHeld = true;
        }
    };

    state._onMouseUp = (e: MouseEvent) => {
        if (e.button === 0) {
            state._justUp = true;
            state._mouseHeld = false;
        }
    };

    canvas.addEventListener('mousemove', state._onMouseMove);
    canvas.addEventListener('mousedown', state._onMouseDown);
    canvas.addEventListener('mouseup', state._onMouseUp);
    // catch mouseup outside the canvas too
    window.addEventListener('mouseup', state._onMouseUp);
    document.addEventListener('pointerlockchange', state._onPointerLockChange);

    return state;
}

export function disposePointerState(canvas: HTMLCanvasElement, state: PointerState): void {
    canvas.removeEventListener('mousemove', state._onMouseMove);
    canvas.removeEventListener('mousedown', state._onMouseDown);
    canvas.removeEventListener('mouseup', state._onMouseUp);
    window.removeEventListener('mouseup', state._onMouseUp);
    document.removeEventListener('pointerlockchange', state._onPointerLockChange);
}

// ── per-frame helpers ──────────────────────────────────────────────
//
// resolve click/held/release taking pointer lock into account.
// canvas events don't fire under pointer lock, so we fall back to
// the engine input system which handles that case.

export function pointerJustDown(pointer: PointerState, input: Input): boolean {
    if (document.pointerLockElement) return isMouseJustDown(input.mouseKeyboard, 'left');
    const v = pointer._justClicked > 0;
    return v;
}

export function pointerHeld(pointer: PointerState, input: Input): boolean {
    if (document.pointerLockElement) return isMouseDown(input.mouseKeyboard, 'left');
    return pointer._mouseHeld;
}

export function pointerJustUp(pointer: PointerState, input: Input): boolean {
    if (document.pointerLockElement) return isMouseJustUp(input.mouseKeyboard, 'left');
    return pointer._justUp;
}

/** right-click down edge — used by stroke-based tools (elevation/brush/smooth)
 *  as a "cancel in-progress stroke" affordance. canvas-level right-button
 *  events aren't tracked here (no shared per-frame state needed beyond
 *  cancellation), so this always defers to the engine input system. */
export function pointerJustRight(input: Input): boolean {
    return isMouseJustDown(input.mouseKeyboard, 'right');
}

// call once per frame after all tools have consumed the flags
export function pointerFlush(pointer: PointerState): void {
    pointer._justClicked = 0;
    pointer._justUp = false;
}
