// shared pointer state for the voxel editor.
//
// tracks canvas pointer position (NDC) and primary-button state from unified
// pointer events, so mouse, pen and touch all drive the tools. all tools consume
// this instead of each registering their own event listeners.
//
// the hover raycast runs once per frame in editor/index.ts and writes
// editor.hoverVoxel, tools read that for hit voxel position.

import type { Input } from '../client/input';
import { isMouseDown, isMouseJustDown, isMouseJustUp } from '../client/input';

export type PointerState = {
    // pointer position in NDC space, updated via canvas pointermove/pointerdown
    ndcX: number;
    ndcY: number;

    // pointer position in canvas-relative CSS pixels (same coordinate space
    // the React viewport overlay uses). frozen under pointer lock just like ndc.
    screenX: number;
    screenY: number;

    // canvas-sourced click/held/release flags for the primary pointer (left
    // mouse button, first finger, or pen tip). secondary fingers are ignored so
    // multi-touch camera gestures don't register as clicks. under pointer lock,
    // canvas events are suppressed, callers should fall back to the engine input
    // system (isMouseJustDown etc).
    _justClicked: number; // incremented by pointerdown, consumed each frame
    _mouseHeld: boolean;
    _justUp: boolean;

    // id of the pointer currently held down as the primary; -1 when none. used
    // to ignore up/move from other pointers (e.g. a second finger).
    _activePointerId: number;

    // event handlers stored for removal on dispose
    _onPointerMove: (e: PointerEvent) => void;
    _onPointerDown: (e: PointerEvent) => void;
    _onPointerUp: (e: PointerEvent) => void;
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
        _activePointerId: -1,
        _onPointerMove: null!,
        _onPointerDown: null!,
        _onPointerUp: null!,
        _onPointerLockChange: null!,
    };

    // write ndc/screen from a pointer event's client coords. under pointer lock
    // the cursor is hidden and bound to crosshair, so callers freeze ndc at
    // (0, 0); we skip the update there and let pointerlockchange pin it.
    const updateFromEvent = (e: PointerEvent) => {
        if (document.pointerLockElement) return;
        const rect = canvas.getBoundingClientRect();
        state.screenX = e.clientX - rect.left;
        state.screenY = e.clientY - rect.top;
        state.ndcX = (state.screenX / rect.width) * 2 - 1;
        state.ndcY = -((state.screenY / rect.height) * 2 - 1);
    };

    state._onPointerMove = (e: PointerEvent) => {
        // only the primary pointer drives ndc: on a mouse that's always the
        // cursor (hover included), on touch it's the first finger. secondary
        // fingers move the camera (see camera gestures), not the tool cursor.
        if (!e.isPrimary) return;
        updateFromEvent(e);
    };

    state._onPointerLockChange = () => {
        if (document.pointerLockElement) {
            state.ndcX = 0;
            state.ndcY = 0;
        }
        // on unlock, leave (0, 0) until the next pointermove refreshes ndc.
    };

    state._onPointerDown = (e: PointerEvent) => {
        // a second finger down means the user is starting a two-finger camera
        // gesture (pinch/pan). abandon any in-progress one-finger drag so it
        // doesn't leave a stray selection box behind while the camera moves.
        if (!e.isPrimary) {
            if (state._activePointerId !== -1) {
                state._justUp = true;
                state._mouseHeld = false;
                state._activePointerId = -1;
            }
            return;
        }
        // left mouse button / first finger / pen tip only. e.button is 0 for the
        // primary press across all pointer types.
        if (e.button !== 0) return;
        // touch has no hover, so the down event is the first time we learn the
        // position — sync ndc before the click flag is consumed this frame.
        updateFromEvent(e);
        state._activePointerId = e.pointerId;
        state._justClicked++;
        state._mouseHeld = true;
        // keep receiving moves/up even if the pointer strays off the canvas mid
        // drag (selection boxes, gizmo drags), matching desktop mouse capture.
        try {
            canvas.setPointerCapture(e.pointerId);
        } catch {
            // capture can throw if the pointer is already gone; harmless.
        }
    };

    state._onPointerUp = (e: PointerEvent) => {
        if (e.pointerId !== state._activePointerId) return;
        state._justUp = true;
        state._mouseHeld = false;
        state._activePointerId = -1;
    };

    canvas.addEventListener('pointermove', state._onPointerMove);
    canvas.addEventListener('pointerdown', state._onPointerDown);
    // captured pointers deliver up to the canvas; also catch the uncaptured case
    // and cancellation (finger lifted off-screen, gesture interrupted) on window.
    canvas.addEventListener('pointerup', state._onPointerUp);
    canvas.addEventListener('pointercancel', state._onPointerUp);
    window.addEventListener('pointerup', state._onPointerUp);
    document.addEventListener('pointerlockchange', state._onPointerLockChange);

    return state;
}

export function disposePointerState(canvas: HTMLCanvasElement, state: PointerState): void {
    canvas.removeEventListener('pointermove', state._onPointerMove);
    canvas.removeEventListener('pointerdown', state._onPointerDown);
    canvas.removeEventListener('pointerup', state._onPointerUp);
    canvas.removeEventListener('pointercancel', state._onPointerUp);
    window.removeEventListener('pointerup', state._onPointerUp);
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

/** right-click down edge, used by stroke-based tools (elevation/brush/smooth)
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
