/**
 * public input api, polled per-frame mouse/keyboard/touch state for scripts.
 *
 * access via `ctx.client!.input.mouseKeyboard` / `.touch`. predicates take
 * the input instance as their first arg so they're tree-shakeable and
 * carry no hidden state.
 */

export type {
    CanvasTouch,
    Input,
    JoystickState,
    MouseButton,
    MouseKeyboardInput,
    TouchButtonState,
    TouchInput,
} from '../client/input';
export {
    consumeTouchButtonLookDrag,
    getCanvasTouch,
    getCanvasTouches,
    getCanvasTouchesJustEnded,
    getJoystick,
    getPinchDelta,
    getPinchScale,
    isJoystickJustActive,
    isJoystickJustReleased,
    isKeyDown,
    isKeyJustDown,
    isKeyJustUp,
    isMouseDown,
    isMouseDragStart,
    isMouseJustDown,
    isMouseJustLocked,
    isMouseJustUp,
    isMouseLocked,
    isMouseTap,
    isTouchButtonDown,
    isTouchButtonJustDown,
    isTouchButtonJustUp,
    wasMouseLocked,
} from '../client/input';
