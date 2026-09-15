function isTextInputFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    return isTextInputElement(el);
}

function isTextInputElement(el: Element | EventTarget | null): boolean {
    if (!el || !(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
}

export type MouseButton = 'left' | 'middle' | 'right';

const MOUSE_BUTTONS = ['left', 'middle', 'right'] as const;

/** cursor movement beyond this distance from the down-point (px) promotes the gesture to a drag; a release before that is a tap. */
const DRAG_THRESHOLD_PX = 4;

/** per-button drag-vs-tap state, lets press-and-drag handlers and click handlers coexist on the same button. */
type MouseButtonGesture = {
    downX: number;
    downY: number;
    drag: boolean;
    dragJustStarted: boolean;
    tapped: boolean;
    /** latches like `_keyJustPressed` so a press and release inside one frame still reads as a press. */
    pressed: boolean;
    released: boolean;
    /** press withheld because it was spent on a pointer-lock request: the click that recaptures the cursor must not
     *  also reach the game, so it stays here until the request settles, and lands only if the browser refused it. */
    heldForLock: boolean;
    /** the release arrived while the press was still withheld, so promoting it has to read as a whole tap. */
    heldRelease: boolean;
};

function createGesture(): MouseButtonGesture {
    return {
        downX: 0,
        downY: 0,
        drag: false,
        dragJustStarted: false,
        tapped: false,
        pressed: false,
        released: false,
        heldForLock: false,
        heldRelease: false,
    };
}

/** position of the primary pointer over the shared display canvas; ndc is pinned to (0, 0) while pointer-locked. */
export type Cursor = {
    x: number;
    y: number;
    ndcX: number;
    ndcY: number;
};

type ModifierState = { mod: boolean; shift: boolean; alt: boolean };

export type MouseKeyboardInput = {
    _keyState: Map<string, boolean>;
    /** key state from the previous frame; just-down uses _keyJustPressed instead. */
    _prevKeyState: Map<string, boolean>;
    /** codes with a non-repeat keydown since last reset, so macOS doesn't drop presses when Cmd+letter swallows the letter's keyup. */
    _keyJustPressed: Set<string>;
    /** `mod` is cmd-on-mac / ctrl-on-win (e.metaKey || e.ctrlKey) */
    _mods: ModifierState;
    _prevMods: ModifierState;
    _dx: number;
    _dy: number;
    _buttons: { left: boolean; right: boolean; middle: boolean };
    /** written by the canvas pointer listeners, so only the active room's cursor moves. */
    _cursor: Cursor;
    _wheelDeltaY: number;
    _gestures: { left: MouseButtonGesture; middle: MouseButtonGesture; right: MouseButtonGesture };
    /** snapshotted once per frame so `is/was/just` agree within a frame, since raw `document.pointerLockElement` can flip mid-frame. */
    _locked: boolean;
    _prevLocked: boolean;
    /** mirrors InputManager._lockReleases: true while a UI surface is holding pointer input, so viewport wheel gestures ignore it. */
    _pointerCapturedByUi: boolean;
};

export function createMouseKeyboardInput(): MouseKeyboardInput {
    return {
        _keyState: new Map(),
        _prevKeyState: new Map(),
        _keyJustPressed: new Set(),
        _mods: { mod: false, shift: false, alt: false },
        _prevMods: { mod: false, shift: false, alt: false },
        _dx: 0,
        _dy: 0,
        _buttons: { left: false, right: false, middle: false },
        _cursor: { x: 0, y: 0, ndcX: 0, ndcY: 0 },
        _wheelDeltaY: 0,
        _gestures: { left: createGesture(), middle: createGesture(), right: createGesture() },
        _locked: false,
        _prevLocked: false,
        _pointerCapturedByUi: false,
    };
}

/** call once per frame to snapshot prev state and clear per-frame accumulators. */
export function resetMouseKeyboardInput(mouseKeyboard: MouseKeyboardInput): void {
    const allKeys = new Set([...mouseKeyboard._keyState.keys(), ...mouseKeyboard._prevKeyState.keys()]);
    mouseKeyboard._prevKeyState.clear();
    for (const key of allKeys) {
        mouseKeyboard._prevKeyState.set(key, mouseKeyboard._keyState.get(key) ?? false);
    }

    mouseKeyboard._prevMods.mod = mouseKeyboard._mods.mod;
    mouseKeyboard._prevMods.shift = mouseKeyboard._mods.shift;
    mouseKeyboard._prevMods.alt = mouseKeyboard._mods.alt;

    // canvas pointer events don't reach us while locked, so pin the cursor to the crosshair here
    mouseKeyboard._prevLocked = mouseKeyboard._locked;
    mouseKeyboard._locked = typeof document !== 'undefined' && !!document.pointerLockElement;
    if (mouseKeyboard._locked) {
        mouseKeyboard._cursor.ndcX = 0;
        mouseKeyboard._cursor.ndcY = 0;
    }

    mouseKeyboard._keyJustPressed.clear();
    mouseKeyboard._dx = 0;
    mouseKeyboard._dy = 0;
    mouseKeyboard._wheelDeltaY = 0;
    resetGesture(mouseKeyboard._gestures.left);
    resetGesture(mouseKeyboard._gestures.middle);
    resetGesture(mouseKeyboard._gestures.right);
}

function resetGesture(g: MouseButtonGesture): void {
    g.dragJustStarted = false;
    g.tapped = false;
    g.pressed = false;
    g.released = false;
}

export function isKeyDown(mouseKeyboard: MouseKeyboardInput, code: string): boolean {
    return mouseKeyboard._keyState.get(code) ?? false;
}

export function isKeyJustDown(mouseKeyboard: MouseKeyboardInput, code: string): boolean {
    return mouseKeyboard._keyJustPressed.has(code);
}

export function isKeyJustUp(mouseKeyboard: MouseKeyboardInput, code: string): boolean {
    return !(mouseKeyboard._keyState.get(code) ?? false) && (mouseKeyboard._prevKeyState.get(code) ?? false);
}

/** cmd-on-mac / ctrl-on-win held this frame. */
export function isModDown(mouseKeyboard: MouseKeyboardInput): boolean {
    return mouseKeyboard._mods.mod;
}

export function isShiftDown(mouseKeyboard: MouseKeyboardInput): boolean {
    return mouseKeyboard._mods.shift;
}

export function isAltDown(mouseKeyboard: MouseKeyboardInput): boolean {
    return mouseKeyboard._mods.alt;
}

export function isMouseDown(mouseKeyboard: MouseKeyboardInput, button: MouseButton): boolean {
    return mouseKeyboard._buttons[button];
}

/** fires for one frame when the button went down, latched at the event so a press-then-release within a frame is still seen. */
export function isMouseJustDown(mouseKeyboard: MouseKeyboardInput, button: MouseButton): boolean {
    return mouseKeyboard._gestures[button].pressed;
}

export function isMouseJustUp(mouseKeyboard: MouseKeyboardInput, button: MouseButton): boolean {
    return mouseKeyboard._gestures[button].released;
}

/** the returned object is the live cursor, read it, don't hold it across frames. */
export function getCursor(mouseKeyboard: MouseKeyboardInput): Readonly<Cursor> {
    return mouseKeyboard._cursor;
}

/** fires for one frame the moment a held button crosses the drag threshold; use in place of `isMouseJustDown` for drag-commit actions. */
export function isMouseDragStart(mouseKeyboard: MouseKeyboardInput, button: MouseButton): boolean {
    return mouseKeyboard._gestures[button].dragJustStarted;
}

/** fires for one frame on button-up when the press never crossed the drag threshold; use for click-commit actions. */
export function isMouseTap(mouseKeyboard: MouseKeyboardInput, button: MouseButton): boolean {
    return mouseKeyboard._gestures[button].tapped;
}

/** Is the pointer locked this frame? (mouse-look / cursor captured.) */
export function isMouseLocked(mouseKeyboard: MouseKeyboardInput): boolean {
    return mouseKeyboard._locked;
}

/** Was the pointer locked last frame? Pair with `isMouseLocked` for edge logic. */
export function wasMouseLocked(mouseKeyboard: MouseKeyboardInput): boolean {
    return mouseKeyboard._prevLocked;
}

/** Fires for one frame the moment the pointer becomes locked (unlocked to locked). */
export function isMouseJustLocked(mouseKeyboard: MouseKeyboardInput): boolean {
    return mouseKeyboard._locked && !mouseKeyboard._prevLocked;
}

/** single canvas touch (one finger): raw position/start/delta state, plus latched gesture edge flags. */
export type CanvasTouch = {
    pointerId: number;
    /** current position, CSS px from canvas top-left. */
    x: number;
    y: number;
    /** accumulated movement since last reset, CSS px. */
    dx: number;
    dy: number;
    /** position at pointerdown, CSS px from canvas top-left. */
    startX: number;
    startY: number;
    /** Date.now() at pointerdown, ms. */
    downAt: number;

    justStarted: boolean;
    /** last frame; only set on entries in _canvasTouchesEnded. */
    justEnded: boolean;
    /** ended within TAP_MAX_MS and TAP_MAX_DRIFT_PX. */
    tapped: boolean;
    /** crossed LONG_PRESS_MIN_MS without leaving LONG_PRESS_MAX_DRIFT_PX. */
    longPressed: boolean;
    /** ended with velocity above SWIPE_MIN_VELOCITY_PX_PER_MS. */
    swiped: boolean;
    /** direction of the swipe (CSS px from startX/Y to endX/Y), 0 if !swiped. */
    swipeDx: number;
    swipeDy: number;

    _maxDriftSq: number;
    _longPressLatched: boolean;
    _recentSamples: { t: number; x: number; y: number }[];
};

export type JoystickState = {
    /** [-1, 1] on each axis with deadzone applied; (0, 0) when idle. */
    x: number;
    y: number;
    /** true while a finger is pressing the joystick. */
    active: boolean;
    /** previous-frame `active`, for edge predicates. */
    _prevActive: boolean;
};

export type TouchButtonState = {
    down: boolean;
    /** previous-frame `down`, for just-down / just-up edges. */
    _prevDown: boolean;
    /** `look:true` buttons also drive the camera while held; their drag is forwarded into the same look pipeline as a canvas drag. */
    look: boolean;
    /** CSS-px drag accumulated since the last consume; meaningful only when `look`. */
    _dragX: number;
    _dragY: number;
};

export type TouchInput = {
    _canvasTouches: Map<number, CanvasTouch>;
    /** touches that ended this frame; cleared by reset. */
    _canvasTouchesEnded: Map<number, CanvasTouch>;
    /** inter-touch distance last frame (for pinch). 0 when !=2 touches. */
    _pinchPrevDist: number;
    _joysticks: Map<string, JoystickState>;
    _buttons: Map<string, TouchButtonState>;
};

const TAP_MAX_MS = 250;
const TAP_MAX_DRIFT_PX_SQ = 8 * 8;
const LONG_PRESS_MIN_MS = 500;
const LONG_PRESS_MAX_DRIFT_PX_SQ = 8 * 8;
const SWIPE_MIN_VELOCITY_PX_PER_MS = 0.5;
const SWIPE_SAMPLE_WINDOW_MS = 80;

const ZERO_JOYSTICK: Readonly<JoystickState> = Object.freeze({
    x: 0,
    y: 0,
    active: false,
    _prevActive: false,
});

export function createTouchInput(): TouchInput {
    return {
        _canvasTouches: new Map(),
        _canvasTouchesEnded: new Map(),
        _pinchPrevDist: 0,
        _joysticks: new Map(),
        _buttons: new Map(),
    };
}

function pinchDist(t: TouchInput): number {
    if (t._canvasTouches.size !== 2) return 0;
    const it = t._canvasTouches.values();
    const a = it.next().value!;
    const b = it.next().value!;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

/** Called once per client tick from `resetInput`. */
export function resetTouchInput(t: TouchInput): void {
    const now = Date.now();
    for (const touch of t._canvasTouches.values()) {
        touch.dx = 0;
        touch.dy = 0;
        touch.justStarted = false;
        touch.longPressed = false;
        if (
            !touch._longPressLatched &&
            now - touch.downAt >= LONG_PRESS_MIN_MS &&
            touch._maxDriftSq < LONG_PRESS_MAX_DRIFT_PX_SQ
        ) {
            touch.longPressed = true;
            touch._longPressLatched = true;
        }
        const cutoff = now - SWIPE_SAMPLE_WINDOW_MS;
        const s = touch._recentSamples;
        while (s.length > 0 && s[0]!.t < cutoff) s.shift();
    }
    t._canvasTouchesEnded.clear();
    t._pinchPrevDist = pinchDist(t);
    for (const j of t._joysticks.values()) j._prevActive = j.active;
    for (const b of t._buttons.values()) b._prevDown = b.down;
}

export function getCanvasTouches(t: TouchInput): ReadonlyMap<number, CanvasTouch> {
    return t._canvasTouches;
}

export function getCanvasTouch(t: TouchInput, pointerId: number): CanvasTouch | null {
    return t._canvasTouches.get(pointerId) ?? null;
}

export function getCanvasTouchesJustEnded(t: TouchInput): ReadonlyMap<number, CanvasTouch> {
    return t._canvasTouchesEnded;
}

/** change in inter-touch distance this frame (CSS px), 0 if !=2 touches. */
export function getPinchDelta(t: TouchInput): number {
    if (t._canvasTouches.size !== 2) return 0;
    const current = pinchDist(t);
    return current - t._pinchPrevDist;
}

/** currentDist / lastFrameDist, 1.0 if not pinching. */
export function getPinchScale(t: TouchInput): number {
    if (t._canvasTouches.size !== 2 || t._pinchPrevDist === 0) return 1;
    return pinchDist(t) / t._pinchPrevDist;
}

export function getJoystick(t: TouchInput, id: string): Readonly<JoystickState> {
    return t._joysticks.get(id) ?? ZERO_JOYSTICK;
}

export function isJoystickJustActive(t: TouchInput, id: string): boolean {
    const j = t._joysticks.get(id);
    return j ? j.active && !j._prevActive : false;
}

export function isJoystickJustReleased(t: TouchInput, id: string): boolean {
    const j = t._joysticks.get(id);
    return j ? !j.active && j._prevActive : false;
}

export function isTouchButtonDown(t: TouchInput, id: string): boolean {
    return t._buttons.get(id)?.down ?? false;
}

export function isTouchButtonJustDown(t: TouchInput, id: string): boolean {
    const b = t._buttons.get(id);
    return b ? b.down && !b._prevDown : false;
}

export function isTouchButtonJustUp(t: TouchInput, id: string): boolean {
    const b = t._buttons.get(id);
    return b ? !b.down && b._prevDown : false;
}

/** sums the drag accumulated by every `look:true` button since the last call, zeroing it; lets a fire button double as an aim surface. */
export function consumeTouchButtonLookDrag(t: TouchInput): { dx: number; dy: number } {
    let dx = 0;
    let dy = 0;
    for (const b of t._buttons.values()) {
        if (!b.look) continue;
        dx += b._dragX;
        dy += b._dragY;
        b._dragX = 0;
        b._dragY = 0;
    }
    return { dx, dy };
}

/** installs pointerdown/move/up/cancel on the shared display canvas, routed to the active room's input via `manager.target`. */
export function installCanvasListeners(canvas: HTMLCanvasElement, manager: InputManager): void {
    // under pointer lock no canvas pointer events arrive; resetMouseKeyboardInput pins ndc to the crosshair
    const writeCursor = (e: PointerEvent): void => {
        if (!e.isPrimary) return;
        const mouseKeyboard = manager.target?.mouseKeyboard;
        if (!mouseKeyboard) return;
        const rect = canvas.getBoundingClientRect();
        const cursor = mouseKeyboard._cursor;
        cursor.x = e.clientX - rect.left;
        cursor.y = e.clientY - rect.top;
        cursor.ndcX = (cursor.x / rect.width) * 2 - 1;
        cursor.ndcY = -((cursor.y / rect.height) * 2 - 1);
    };
    const onCursorDown = (e: PointerEvent): void => {
        // touch has no hover, so the down is the first time we learn the position; write it before the window handler registers the press.
        writeCursor(e);
        if (!e.isPrimary || e.button !== 0) return;
        try {
            canvas.setPointerCapture(e.pointerId);
        } catch {
            // pointer may already be released
        }
    };

    const sampleVelocity = (touch: CanvasTouch, now: number): boolean => {
        const s = touch._recentSamples;
        const cutoff = now - SWIPE_SAMPLE_WINDOW_MS;
        while (s.length > 0 && s[0]!.t < cutoff) s.shift();
        if (s.length < 2) return false;
        const first = s[0]!;
        const last = s[s.length - 1]!;
        const dt = last.t - first.t;
        if (dt <= 0) return false;
        const dx = last.x - first.x;
        const dy = last.y - first.y;
        const v = Math.sqrt(dx * dx + dy * dy) / dt;
        return v >= SWIPE_MIN_VELOCITY_PX_PER_MS;
    };

    const onDown = (e: PointerEvent): void => {
        if (e.pointerType !== 'touch') return;
        const t = manager.target?.touch;
        if (!t) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const now = Date.now();
        const touch: CanvasTouch = {
            pointerId: e.pointerId,
            x,
            y,
            dx: 0,
            dy: 0,
            startX: x,
            startY: y,
            downAt: now,
            justStarted: true,
            justEnded: false,
            tapped: false,
            longPressed: false,
            swiped: false,
            swipeDx: 0,
            swipeDy: 0,
            _maxDriftSq: 0,
            _longPressLatched: false,
            _recentSamples: [{ t: now, x, y }],
        };
        t._canvasTouches.set(e.pointerId, touch);
        try {
            canvas.setPointerCapture(e.pointerId);
        } catch {
            // pointer may already be released
        }
    };

    const onMove = (e: PointerEvent): void => {
        if (e.pointerType !== 'touch') return;
        const t = manager.target?.touch;
        if (!t) return;
        const touch = t._canvasTouches.get(e.pointerId);
        if (!touch) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        touch.dx += x - touch.x;
        touch.dy += y - touch.y;
        touch.x = x;
        touch.y = y;
        const driftX = x - touch.startX;
        const driftY = y - touch.startY;
        const driftSq = driftX * driftX + driftY * driftY;
        if (driftSq > touch._maxDriftSq) touch._maxDriftSq = driftSq;
        touch._recentSamples.push({ t: Date.now(), x, y });
    };

    const onUp = (e: PointerEvent): void => {
        if (e.pointerType !== 'touch') return;
        const t = manager.target?.touch;
        if (!t) return;
        const touch = t._canvasTouches.get(e.pointerId);
        if (!touch) return;
        const now = Date.now();
        touch.justEnded = true;
        const tapped = now - touch.downAt < TAP_MAX_MS && touch._maxDriftSq < TAP_MAX_DRIFT_PX_SQ;
        touch.tapped = tapped;
        if (sampleVelocity(touch, now)) {
            touch.swiped = true;
            touch.swipeDx = touch.x - touch.startX;
            touch.swipeDy = touch.y - touch.startY;
        }
        t._canvasTouches.delete(e.pointerId);
        t._canvasTouchesEnded.set(e.pointerId, touch);
    };

    const onCancel = (e: PointerEvent): void => {
        if (e.pointerType !== 'touch') return;
        const t = manager.target?.touch;
        if (!t) return;
        const touch = t._canvasTouches.get(e.pointerId);
        if (!touch) return;
        touch.justEnded = true;
        t._canvasTouches.delete(e.pointerId);
        t._canvasTouchesEnded.set(e.pointerId, touch);
    };

    canvas.addEventListener('pointerdown', onCursorDown);
    canvas.addEventListener('pointermove', writeCursor);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);

    manager._disposeCanvas = () => {
        canvas.removeEventListener('pointerdown', onCursorDown);
        canvas.removeEventListener('pointermove', writeCursor);
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onCancel);
    };
}

export type Input = {
    mouseKeyboard: MouseKeyboardInput;
    touch: TouchInput;
    /** persistent room intent, set via `setPointerLock`; survives a controller being removed and re-added with no relock dance. */
    _lockWanted: boolean;
    /** whether the room's controller has declared its lock intent at least once, so a fresh `_lockWanted=false` reads as pending. */
    _lockDeclared: boolean;
};

export function createInput(): Input {
    return {
        mouseKeyboard: createMouseKeyboardInput(),
        touch: createTouchInput(),
        _lockWanted: false,
        _lockDeclared: false,
    };
}

export function resetInput(input: Input): void {
    resetMouseKeyboardInput(input.mouseKeyboard);
    resetTouchInput(input.touch);
}

export type InputManager = {
    /** the Input that DOM events currently write into. null = drop events. */
    target: Input | null;
    /** "last input wins", written by the `pointerdown` handler below; lives here since its readers are React-free trait code. */
    inputMode: 'mouse' | 'touch';
    /** UI / ad / host surfaces holding the cursor free while shown. */
    _lockReleases: Set<string>;
    /** captured from the last canvas mousedown; fallback only, prefer `_lockEl` when set. */
    _lockTargetEl: HTMLElement | null;
    /** stable element to pointer-lock instead of a per-room canvas, since the canvas gets display:none'd on a room swap. */
    _lockEl: HTMLElement | null;
    /** tracked from window focus/blur, and repaired by any key/pointer event, since the embed iframe does not
     *  reliably get a window `focus` when focus returns to it and a stale `false` wedges the lock off for good. */
    _focused: boolean;
    /** a promise-backed lock request is in flight and will settle the withheld press itself, so the document-level
     *  `pointerlockerror` must keep its hands off: it has no request identity and would settle a retry prematurely. */
    _lockRequestPending: boolean;
    _handlers: {
        keydown: (e: KeyboardEvent) => void;
        keyup: (e: KeyboardEvent) => void;
        pointerdown: (e: PointerEvent) => void;
        pointerup: (e: PointerEvent) => void;
        pointermove: (e: PointerEvent) => void;
        pointercancel: (e: PointerEvent) => void;
        wheel: (e: WheelEvent) => void;
        focus: () => void;
        blur: () => void;
        modality: (e: PointerEvent) => void;
        pointerlockchange: () => void;
        pointerlockerror: () => void;
    };
    /** set by installCanvasListeners, run in disposeInputManager. */
    _disposeCanvas: (() => void) | null;
};

export function createInputManager(): InputManager {
    const m: InputManager = {
        target: null,
        inputMode: 'mouse',
        _lockReleases: new Set(),
        _lockTargetEl: null,
        _lockEl: typeof document === 'undefined' ? null : document.documentElement,
        _focused: typeof document === 'undefined' ? true : document.hasFocus(),
        _lockRequestPending: false,
        _handlers: null as any,
        _disposeCanvas: null,
    };

    const handlers = {
        keydown: (e: KeyboardEvent) => {
            m._focused = true;
            const mouseKeyboard = m.target?.mouseKeyboard;
            if (!mouseKeyboard) return;
            // check both e.target (stable even if a portal moves focus before this bubble-phase listener fires) and current focus.
            if (isTextInputElement(e.target) || isTextInputFocused()) return;
            // only fire Tab as a game key when focus is on the viewport; otherwise let the browser's focus-traversal handle it.
            if (e.code === 'Tab') {
                const a = document.activeElement;
                const onViewport = !a || a === document.body || a instanceof HTMLCanvasElement;
                if (!onViewport) return;
                e.preventDefault();
            }
            mouseKeyboard._keyState.set(e.code, true);
            if (!e.repeat) mouseKeyboard._keyJustPressed.add(e.code);
            mouseKeyboard._mods.mod = e.metaKey || e.ctrlKey;
            mouseKeyboard._mods.shift = e.shiftKey;
            mouseKeyboard._mods.alt = e.altKey;
        },
        keyup: (e: KeyboardEvent) => {
            const mouseKeyboard = m.target?.mouseKeyboard;
            if (!mouseKeyboard) return;
            mouseKeyboard._keyState.set(e.code, false);
            mouseKeyboard._mods.mod = e.metaKey || e.ctrlKey;
            mouseKeyboard._mods.shift = e.shiftKey;
            mouseKeyboard._mods.alt = e.altKey;
            // macOS swallows letter keyups while Cmd is held; when Cmd releases, flush held keys so the next press is a fresh just-down.
            if (e.code === 'MetaLeft' || e.code === 'MetaRight') {
                for (const code of mouseKeyboard._keyState.keys()) {
                    if (
                        code === 'MetaLeft' ||
                        code === 'MetaRight' ||
                        code === 'ControlLeft' ||
                        code === 'ControlRight' ||
                        code === 'ShiftLeft' ||
                        code === 'ShiftRight' ||
                        code === 'AltLeft' ||
                        code === 'AltRight'
                    )
                        continue;
                    mouseKeyboard._keyState.set(code, false);
                }
            }
        },
        // pointer events (not mouse events) so the first finger drives buttons/drag/look too; `isPrimary` keeps a second finger from reading as a button.
        pointerdown: (e: PointerEvent) => {
            if (!e.isPrimary) return;
            // an event delivered here proves this document holds focus, whether or not `focus` ever fired on its window.
            m._focused = true;
            const mouseKeyboard = m.target?.mouseKeyboard;
            if (!mouseKeyboard) return;
            mouseKeyboard._mods.mod = e.metaKey || e.ctrlKey;
            mouseKeyboard._mods.shift = e.shiftKey;
            mouseKeyboard._mods.alt = e.altKey;
            // game input is viewport-only, otherwise a right-click on UI could arm a drag gesture and grab pointer-lock.
            const onCanvas = e.target instanceof HTMLCanvasElement;
            if (!onCanvas && !document.pointerLockElement) return;
            // the canvas itself isn't focusable, so a click there wouldn't otherwise defocus a text input holding shortcuts.
            if (isTextInputFocused()) (document.activeElement as HTMLElement).blur();
            // remember the canvas so `releasePointer().restore()` can re-lock later.
            if (onCanvas) m._lockTargetEl = e.target;
            const acquiresLock = tryAcquirePointerLock(m);
            const name: MouseButton | null =
                e.button === 0 ? 'left' : e.button === 1 ? 'middle' : e.button === 2 ? 'right' : null;
            if (!name) return;
            const g = mouseKeyboard._gestures[name];
            g.downX = e.clientX;
            g.downY = e.clientY;
            g.drag = false;
            g.heldRelease = false;
            // the press that RE-acquires the lock is spent recapturing the cursor, so withhold it rather than swallow
            // it: a request the browser refuses (Chrome locks pointer lock out for ~1.25s after an Esc exit) gives it
            // back, instead of the click vanishing and every retry vanishing with it.
            g.heldForLock = acquiresLock;
            if (acquiresLock) return;
            mouseKeyboard._buttons[name] = true;
            g.pressed = true;
        },
        pointerup: (e: PointerEvent) => {
            if (!e.isPrimary) return;
            const mouseKeyboard = m.target?.mouseKeyboard;
            if (!mouseKeyboard) return;
            mouseKeyboard._mods.mod = e.metaKey || e.ctrlKey;
            mouseKeyboard._mods.shift = e.shiftKey;
            mouseKeyboard._mods.alt = e.altKey;
            const name: MouseButton | null =
                e.button === 0 ? 'left' : e.button === 1 ? 'middle' : e.button === 2 ? 'right' : null;
            if (!name) return;
            // the press is still withheld pending its lock request; remember the release so promoting it reads as a tap.
            if (mouseKeyboard._gestures[name].heldForLock) {
                mouseKeyboard._gestures[name].heldRelease = true;
                return;
            }
            // no matching registered press: covers presses begun off the game surface.
            if (!mouseKeyboard._buttons[name]) return;
            mouseKeyboard._buttons[name] = false;
            const g = mouseKeyboard._gestures[name];
            g.released = true;
            // a release that never crossed the drag threshold is a tap.
            if (!g.drag) g.tapped = true;
        },
        // the browser took the pointer away mid-press: release every held button as a plain up, no tap.
        pointercancel: (e: PointerEvent) => {
            if (!e.isPrimary) return;
            const mouseKeyboard = m.target?.mouseKeyboard;
            if (!mouseKeyboard) return;
            for (const name of MOUSE_BUTTONS) {
                // the gesture is gone, so a press withheld for a lock request must not surface later.
                mouseKeyboard._gestures[name].heldForLock = false;
                if (!mouseKeyboard._buttons[name]) continue;
                mouseKeyboard._buttons[name] = false;
                mouseKeyboard._gestures[name].released = true;
            }
        },
        pointermove: (e: PointerEvent) => {
            if (!e.isPrimary) return;
            const mouseKeyboard = m.target?.mouseKeyboard;
            if (!mouseKeyboard) return;
            mouseKeyboard._dx += e.movementX;
            mouseKeyboard._dy += e.movementY;
            const t2 = DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX;
            for (const name of MOUSE_BUTTONS) {
                if (!mouseKeyboard._buttons[name]) continue;
                const g = mouseKeyboard._gestures[name];
                if (g.drag) continue;
                const dx = e.clientX - g.downX;
                const dy = e.clientY - g.downY;
                if (dx * dx + dy * dy > t2) {
                    g.drag = true;
                    g.dragJustStarted = true;
                }
            }
        },
        wheel: (e: WheelEvent) => {
            const mouseKeyboard = m.target?.mouseKeyboard;
            // consume the wheel over the canvas (or while locked) so the embedding page doesn't also scroll during a dolly-zoom.
            const onCanvas = e.target instanceof HTMLCanvasElement;
            if (!mouseKeyboard) {
                if (document.pointerLockElement || onCanvas) e.preventDefault();
                return;
            }
            mouseKeyboard._mods.mod = e.metaKey || e.ctrlKey;
            mouseKeyboard._mods.shift = e.shiftKey;
            mouseKeyboard._mods.alt = e.altKey;
            mouseKeyboard._wheelDeltaY += e.deltaY;
            if (document.pointerLockElement || onCanvas) e.preventDefault();
        },
        focus: () => {
            m._focused = true;
        },
        blur: () => {
            // the browser already drops pointer lock on blur; mirror it so we don't try to re-acquire while unfocused.
            m._focused = false;
            releaseHeldInput(m.target?.mouseKeyboard);
            reconcilePointerLock(m);
        },
        // capture phase, so it lands before the bubbling pointerdown handler for the same interaction.
        modality: (e: PointerEvent) => {
            m.inputMode = e.pointerType === 'touch' ? 'touch' : 'mouse';
        },
        // the authority on a request landing: `requestPointerLock` returns no promise in older browsers, so this is
        // the only signal there that the withheld click actually bought the lock.
        pointerlockchange: () => {
            if (!document.pointerLockElement) return;
            m._lockRequestPending = false;
            settleLockPress(m, true);
        },
        // fires on `document` in browsers that report pointer-lock failure via the event instead of a rejected promise.
        pointerlockerror: () => {
            warnPointerLockBlocked();
            if (!m._lockRequestPending) settleLockPress(m, false);
        },
    };

    m._handlers = handlers;

    window.addEventListener('keydown', handlers.keydown);
    window.addEventListener('keyup', handlers.keyup);
    window.addEventListener('pointerdown', handlers.pointerdown);
    window.addEventListener('pointerup', handlers.pointerup);
    window.addEventListener('pointermove', handlers.pointermove);
    window.addEventListener('pointercancel', handlers.pointercancel);
    window.addEventListener('wheel', handlers.wheel, { passive: false });
    window.addEventListener('focus', handlers.focus);
    window.addEventListener('blur', handlers.blur);
    // capture + passive: see the modality of every interaction, even ones a target stops from bubbling, without blocking it.
    window.addEventListener('pointerdown', handlers.modality, { capture: true, passive: true });
    document.addEventListener('pointerlockchange', handlers.pointerlockchange);
    document.addEventListener('pointerlockerror', handlers.pointerlockerror);

    return m;
}

/** mirrors the "a UI surface is holding pointer input" fact onto the active target's per-frame input. */
function syncPointerCapture(m: InputManager): void {
    if (m.target) m.target.mouseKeyboard._pointerCapturedByUi = m._lockReleases.size > 0;
}

export function setInputManagerTarget(m: InputManager, target: Input | null): void {
    // a press the outgoing room withheld for a lock request must not surface in the incoming one.
    if (m.target) for (const button of MOUSE_BUTTONS) m.target.mouseKeyboard._gestures[button].heldForLock = false;
    m.target = target;
    syncPointerCapture(m);
    // a room swap changes whose intent we read; reconcile holds the lock until the new room's controller declares its intent.
    reconcilePointerLock(m);
}

export function disposeInputManager(m: InputManager): void {
    const h = m._handlers;
    window.removeEventListener('keydown', h.keydown);
    window.removeEventListener('keyup', h.keyup);
    window.removeEventListener('pointerdown', h.pointerdown);
    window.removeEventListener('pointerup', h.pointerup);
    window.removeEventListener('pointermove', h.pointermove);
    window.removeEventListener('pointercancel', h.pointercancel);
    window.removeEventListener('wheel', h.wheel);
    window.removeEventListener('focus', h.focus);
    window.removeEventListener('blur', h.blur);
    window.removeEventListener('pointerdown', h.modality, { capture: true } as EventListenerOptions);
    document.removeEventListener('pointerlockchange', h.pointerlockchange);
    document.removeEventListener('pointerlockerror', h.pointerlockerror);
    m._disposeCanvas?.();
    m._disposeCanvas = null;
    m.target = null;
}

// lock state is derived each frame from room intent + UI releases + modality + focus; releasing works any time, acquiring needs a user gesture.

/** pure derivation, no side effects; gated on the current modality, not touch capability, so a mouse user on a touchscreen laptop still locks. */
export function computeShouldBeLocked(m: InputManager): boolean {
    return (m.target?._lockWanted ?? false) && m._lockReleases.size === 0 && m.inputMode !== 'touch' && m._focused;
}

/** release-only; runs end-of-frame, on target swap/blur, and on release add. */
export function reconcilePointerLock(m: InputManager): void {
    if (computeShouldBeLocked(m) || !document.pointerLockElement) return;
    // a freshly-mounted room that hasn't declared its lock intent yet reads its un-run `false` as pending, so hold the lock.
    if (m.target && !m.target._lockDeclared && m._lockReleases.size === 0 && m._focused && m.inputMode !== 'touch') return;
    document.exitPointerLock();
}

/** a genuine request failure usually means the embedding blocked capture or the browser has pointer lock disabled. */
let warnedPointerLockBlocked = false;
function warnPointerLockBlocked(): void {
    if (warnedPointerLockBlocked) return;
    warnedPointerLockBlocked = true;
    console.warn(
        'Pointer lock request was blocked. If this persists, the embedding iframe may be missing ' +
            'the `allow-pointer-lock` sandbox flag, or the browser has pointer lock disabled ' +
            '(e.g. hardened Firefox: full-screen-api.pointer-lock.enabled, privacy.resistFingerprinting).',
    );
}

/** acquire, call only from a real user gesture; `unadjustedMovement` gives raw deltas, older Safari rejects it so retry
 *  plain. Returns whether a request actually went out, i.e. whether this gesture was spent recapturing the cursor. */
export function tryAcquirePointerLock(m: InputManager): boolean {
    if (!computeShouldBeLocked(m) || document.pointerLockElement) return false;
    // prefer the stable container so the lock survives room swaps.
    const el = m._lockEl ?? m._lockTargetEl;
    if (!el) return false;
    const p = (el.requestPointerLock as (o?: { unadjustedMovement?: boolean }) => Promise<void> | undefined)({
        unadjustedMovement: true,
    });
    if (!p?.catch) return true;
    m._lockRequestPending = true;
    p.catch(() => {
        // the rejection lands a task later, so re-check: a UI surface may have taken the cursor in the meantime, and
        // re-requesting then would hand the lock back under an open panel and race the next frame's exit.
        if (!computeShouldBeLocked(m) || document.pointerLockElement) {
            m._lockRequestPending = false;
            return settleLockPress(m, false);
        }
        const plain = el.requestPointerLock() as Promise<void> | undefined;
        if (!plain?.catch) return;
        plain.catch(() => {
            warnPointerLockBlocked();
            m._lockRequestPending = false;
            settleLockPress(m, false);
        });
    });
    return true;
}

/** the lock request the click was spent on resolved: a granted lock consumes the withheld press, a refused one hands
 *  it back rather than eating the click. Idempotent, since both the promise and `pointerlockerror` can report. */
function settleLockPress(m: InputManager, acquired: boolean): void {
    const mouseKeyboard = m.target?.mouseKeyboard;
    if (!mouseKeyboard) return;
    for (const button of MOUSE_BUTTONS) {
        const g = mouseKeyboard._gestures[button];
        if (!g.heldForLock) continue;
        g.heldForLock = false;
        if (acquired) continue;
        g.pressed = true;
        // the release already came and went; `pressed`/`released` latch, so one frame still reads the whole tap.
        if (g.heldRelease) {
            g.released = true;
            g.tapped = true;
        } else {
            mouseKeyboard._buttons[button] = true;
        }
    }
}

/** focus left the document, so the keyup and pointerup for anything held land in whatever took it and never reach us.
 *  Drop the held state instead of letting a key the user has physically released read as down until they press it
 *  again, and report the buttons as released so a hold-to-charge action still completes. */
function releaseHeldInput(mouseKeyboard: MouseKeyboardInput | undefined): void {
    if (!mouseKeyboard) return;
    for (const code of mouseKeyboard._keyState.keys()) mouseKeyboard._keyState.set(code, false);
    mouseKeyboard._mods.mod = false;
    mouseKeyboard._mods.shift = false;
    mouseKeyboard._mods.alt = false;
    for (const button of MOUSE_BUTTONS) {
        mouseKeyboard._gestures[button].heldForLock = false;
        if (!mouseKeyboard._buttons[button]) continue;
        mouseKeyboard._buttons[button] = false;
        mouseKeyboard._gestures[button].released = true;
    }
}

/** UI/ad/host surface asks to free the cursor while shown; releases immediately, no waiting a frame. */
export function addLockRelease(m: InputManager, id: string): void {
    m._lockReleases.add(id);
    syncPointerCapture(m);
    reconcilePointerLock(m);
}

/** true while a UI overlay is holding pointer input; viewport wheel gestures check this so a scroll over a panel drives the panel. */
export function isPointerCapturedByUi(mouseKeyboard: MouseKeyboardInput): boolean {
    return mouseKeyboard._pointerCapturedByUi;
}

/** the surface closed; re-acquire synchronously, called from the close gesture so the lock comes back in that gesture. */
export function removeLockRelease(m: InputManager, id: string): void {
    m._lockReleases.delete(id);
    syncPointerCapture(m);
    tryAcquirePointerLock(m);
}
