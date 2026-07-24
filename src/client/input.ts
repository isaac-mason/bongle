/**
 * client input, split into:
 *   - `Input` (per-room data; held keys/buttons, mouse deltas, prev maps)
 *   - `InputManager` (client-level; owns DOM listeners and routes events
 *     into whichever Input is currently the active target)
 *
 * scripts read from `ctx.client!.input` (their room's data). Inactive
 * rooms' inputs receive no events, so scripts running there see zeros.
 *
 * usage:
 *   const mouseKeyboard = ctx.client!.input.mouseKeyboard
 *   if (mouseKeyboard.isKeyDown('KeyW')) { ... }
 */

/* ── text input focus detection ───────────────────────────────────── */

// returns true when a text input / textarea / contenteditable / select
// has focus. used to suppress game input while the user is typing.
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

/* ── mouse + keyboard data ────────────────────────────────────────── */

export type MouseButton = 'left' | 'middle' | 'right';

/**
 * pixel threshold for drag-vs-tap discrimination. cursor movement beyond
 * this distance from the down-point promotes the gesture to a drag;
 * release before crossing it is reported as a tap.
 */
const DRAG_THRESHOLD_PX = 4;

/**
 * per-button drag-vs-tap state. sampled at button-down (in clientX/Y
 * screen space). while the button is held, mousemove compares cursor
 * distance from the down-point: once it exceeds DRAG_THRESHOLD_PX the
 * gesture becomes a drag and `dragJustStarted` fires for one frame. on
 * button-up, if no drag ever started, `tapped` fires for one frame.
 * lets press-and-drag handlers (e.g. fly-look pointer-lock) and click
 * handlers (e.g. block placement) coexist on the same button.
 */
type MouseButtonGesture = {
    downX: number;
    downY: number;
    drag: boolean;
    dragJustStarted: boolean;
    tapped: boolean;
};

function createGesture(): MouseButtonGesture {
    return { downX: 0, downY: 0, drag: false, dragJustStarted: false, tapped: false };
}

/** modifier state, sampled from KeyboardEvent/MouseEvent on every event. */
type ModifierState = { mod: boolean; shift: boolean; alt: boolean };

export type MouseKeyboardInput = {
    /** currently held keys by KeyboardEvent.code */
    _keyState: Map<string, boolean>;
    /** key state from the previous frame (for just-up; just-down uses _keyJustPressed) */
    _prevKeyState: Map<string, boolean>;
    /**
     * codes that received a non-repeat keydown since last reset. drives
     * isKeyJustDown directly so macOS doesn't drop subsequent presses when
     * Cmd is held (Cmd+letter swallows the letter's keyup on macOS, leaving
     * _keyState stuck true so the prev/current diff fails on the next press).
     */
    _keyJustPressed: Set<string>;
    /**
     * current modifier state. `mod` is cmd-on-mac / ctrl-on-win (e.metaKey
     * || e.ctrlKey), matching the convention used elsewhere in the editor.
     */
    _mods: ModifierState;
    /** modifier state from previous frame */
    _prevMods: ModifierState;
    /** accumulated mouse movement since last reset() */
    _dx: number;
    _dy: number;
    /** current mouse button state */
    _buttons: { left: boolean; right: boolean; middle: boolean };
    /** button state from previous frame */
    _prevButtons: { left: boolean; right: boolean; middle: boolean };
    /** accumulated scroll wheel delta since last reset() */
    _wheelDeltaY: number;
    /** per-button drag-vs-tap discrimination, see MouseButtonGesture */
    _gestures: { left: MouseButtonGesture; middle: MouseButtonGesture; right: MouseButtonGesture };
    /** pointer-lock state, snapshotted once per frame so `is/was/just` agree
     *  within a frame (raw `document.pointerLockElement` can flip mid-frame). */
    _locked: boolean;
    _prevLocked: boolean;
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
        _prevButtons: { left: false, right: false, middle: false },
        _wheelDeltaY: 0,
        _gestures: { left: createGesture(), middle: createGesture(), right: createGesture() },
        _locked: false,
        _prevLocked: false,
    };
}

/** call once per frame to snapshot prev state and clear per-frame accumulators. */
export function resetMouseKeyboardInput(mouseKeyboard: MouseKeyboardInput): void {
    // snapshot key state into prev
    const allKeys = new Set([...mouseKeyboard._keyState.keys(), ...mouseKeyboard._prevKeyState.keys()]);
    mouseKeyboard._prevKeyState.clear();
    for (const key of allKeys) {
        mouseKeyboard._prevKeyState.set(key, mouseKeyboard._keyState.get(key) ?? false);
    }

    // snapshot modifier state into prev
    mouseKeyboard._prevMods.mod = mouseKeyboard._mods.mod;
    mouseKeyboard._prevMods.shift = mouseKeyboard._mods.shift;
    mouseKeyboard._prevMods.alt = mouseKeyboard._mods.alt;

    // snapshot button state into prev
    mouseKeyboard._prevButtons.left = mouseKeyboard._buttons.left;
    mouseKeyboard._prevButtons.middle = mouseKeyboard._buttons.middle;
    mouseKeyboard._prevButtons.right = mouseKeyboard._buttons.right;

    // snapshot pointer-lock state into prev, then re-read it for this frame
    mouseKeyboard._prevLocked = mouseKeyboard._locked;
    mouseKeyboard._locked = typeof document !== 'undefined' && !!document.pointerLockElement;

    // clear per-frame accumulators
    mouseKeyboard._keyJustPressed.clear();
    mouseKeyboard._dx = 0;
    mouseKeyboard._dy = 0;
    mouseKeyboard._wheelDeltaY = 0;
    mouseKeyboard._gestures.left.dragJustStarted = false;
    mouseKeyboard._gestures.left.tapped = false;
    mouseKeyboard._gestures.middle.dragJustStarted = false;
    mouseKeyboard._gestures.middle.tapped = false;
    mouseKeyboard._gestures.right.dragJustStarted = false;
    mouseKeyboard._gestures.right.tapped = false;
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

export function isMouseJustDown(mouseKeyboard: MouseKeyboardInput, button: MouseButton): boolean {
    return mouseKeyboard._buttons[button] && !mouseKeyboard._prevButtons[button];
}

export function isMouseJustUp(mouseKeyboard: MouseKeyboardInput, button: MouseButton): boolean {
    return !mouseKeyboard._buttons[button] && mouseKeyboard._prevButtons[button];
}

/**
 * fires for one frame the moment a held button crosses the drag
 * threshold. use in place of `isMouseJustDown` for actions that should
 * commit to a drag gesture (e.g. fly-look pointer-lock), so a quick
 * click doesn't trigger them.
 */
export function isMouseDragStart(mouseKeyboard: MouseKeyboardInput, button: MouseButton): boolean {
    return mouseKeyboard._gestures[button].dragJustStarted;
}

/**
 * fires for one frame on button-up when the press never crossed the
 * drag threshold. use for click commit actions (e.g. block placement)
 * so a drag release doesn't double as a tap.
 */
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

/** Fires for one frame the moment the pointer becomes locked (unlocked → locked). */
export function isMouseJustLocked(mouseKeyboard: MouseKeyboardInput): boolean {
    return mouseKeyboard._locked && !mouseKeyboard._prevLocked;
}

/* ── touch input ──────────────────────────────────────────────────── */

/**
 * Single canvas touch (one finger). Mirrors Unity's EnhancedTouch.Touch
 * for raw position/start/delta state, and adds latched gesture edge
 * flags (`tapped`/`longPressed`/`swiped`) so scripts can read intent
 * with a single per-touch iteration, same model as the mouse gestures
 * above.
 */
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

    /** first frame this pointerId is observed. */
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
    /** previous-frame `down`, mirrors the _prevButtons trick above. */
    _prevDown: boolean;
    /** `look:true` buttons also drive the camera while held (a fire button you
     *  can aim with). their drag is forwarded into the same look pipeline as a
     *  right-half canvas drag, see `consumeTouchButtonLookDrag`. */
    look: boolean;
    /** CSS-px drag accumulated since the last consume; meaningful only when `look`. */
    _dragX: number;
    _dragY: number;
};

export type TouchInput = {
    /** live touches keyed by pointerId. */
    _canvasTouches: Map<number, CanvasTouch>;
    /** touches that ended this frame; cleared by reset. */
    _canvasTouchesEnded: Map<number, CanvasTouch>;
    /** inter-touch distance last frame (for pinch). 0 when !=2 touches. */
    _pinchPrevDist: number;
    /** registered virtual joysticks. id chosen by the script. */
    _joysticks: Map<string, JoystickState>;
    /** registered virtual buttons. */
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
        // latch long-press once it crosses the threshold without drifting.
        if (
            !touch._longPressLatched &&
            now - touch.downAt >= LONG_PRESS_MIN_MS &&
            touch._maxDriftSq < LONG_PRESS_MAX_DRIFT_PX_SQ
        ) {
            touch.longPressed = true;
            touch._longPressLatched = true;
        }
        // trim stale velocity samples.
        const cutoff = now - SWIPE_SAMPLE_WINDOW_MS;
        const s = touch._recentSamples;
        while (s.length > 0 && s[0]!.t < cutoff) s.shift();
    }
    t._canvasTouchesEnded.clear();
    t._pinchPrevDist = pinchDist(t);
    for (const j of t._joysticks.values()) j._prevActive = j.active;
    for (const b of t._buttons.values()) b._prevDown = b.down;
}

/* ── touch predicates ─────────────────────────────────────────────── */

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

/** Sum the drag accumulated by every `look:true` button since the last call,
 *  zeroing it. CSS px, same units as a canvas touch's `dx/dy`, so the caller
 *  applies it with the touch look sensitivity. Lets a fire button double as an
 *  aim surface: hold to act, slide to look. Returns `{dx:0, dy:0}` when none. */
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

/* ── canvas touch listeners ───────────────────────────────────────── */

/**
 * Installs `pointerdown/move/up/cancel` on the canvas, filtered to
 * `pointerType === 'touch'`. Touches on virtual joystick/button DOM
 * (sibling-of-canvas under viewport) never bubble here because canvas
 * isn't their ancestor, automatic separation between canvas-touch
 * gestures and HUD touches. Returns a disposer.
 */
export function installCanvasTouchListeners(canvas: HTMLCanvasElement, input: Input): () => void {
    const t = input.touch;

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
            // capture can fail if the pointer is already released.
        }
    };

    const onMove = (e: PointerEvent): void => {
        if (e.pointerType !== 'touch') return;
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
        const touch = t._canvasTouches.get(e.pointerId);
        if (!touch) return;
        const now = Date.now();
        // finalise gestures.
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
        const touch = t._canvasTouches.get(e.pointerId);
        if (!touch) return;
        touch.justEnded = true;
        t._canvasTouches.delete(e.pointerId);
        t._canvasTouchesEnded.set(e.pointerId, touch);
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);

    return () => {
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onCancel);
    };
}

/* ── input container ──────────────────────────────────────────────── */

export type Input = {
    mouseKeyboard: MouseKeyboardInput;
    touch: TouchInput;
    /** does this room want the pointer locked (desktop mouse-look)? Persistent
     *  room intent, set via `setPointerLock`. Lives here (not on a controller
     *  trait) so it survives a controller being removed and re-added — e.g. the
     *  death→respawn churn — with no relock dance. Default false; the player
     *  controller sets it true in `onInit`, fly/orbit set it false. */
    _lockWanted: boolean;
    /** has this room's controller declared its lock intent at least once (any
     *  `setPointerLock` call)? Distinguishes a freshly-mounted room whose
     *  `_lockWanted=false` is merely the un-run default (intent still pending)
     *  from a live room whose `false` is authoritative. `reconcilePointerLock`
     *  holds a lock through a room swap only while intent is still pending. */
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

/* ── input manager (DOM listeners + active target router) ─────────── */

export type InputManager = {
    /** the Input that DOM events currently write into. null = drop events. */
    target: Input | null;
    /** touch capability, resolved once at boot. touch never pointer-locks. */
    _touch: boolean;
    /** UI / ad / host surfaces holding the cursor free while shown. */
    _lockReleases: Set<string>;
    /** element to pointer-lock; captured from the last canvas mousedown. fallback
     *  only — prefer `_lockEl` when set. */
    _lockTargetEl: HTMLElement | null;
    /** stable element to pointer-lock (`document.documentElement`), instead of a
     *  per-room canvas. the canvas gets display:none'd (and its room disposed) on a
     *  room swap, which drops a lock bound to it; the root element never does. mouse
     *  deltas are global while locked, so look still works. */
    _lockEl: HTMLElement | null;
    /** tracked from window focus/blur — don't poll document.hasFocus() (unreliable
     *  in the embed iframe, would flicker the lock). */
    _focused: boolean;
    _handlers: {
        keydown: (e: KeyboardEvent) => void;
        keyup: (e: KeyboardEvent) => void;
        mousedown: (e: MouseEvent) => void;
        mouseup: (e: MouseEvent) => void;
        mousemove: (e: MouseEvent) => void;
        wheel: (e: WheelEvent) => void;
        focus: () => void;
        blur: () => void;
        pointerlockerror: () => void;
    };
};

export function createInputManager(touch: boolean): InputManager {
    const m: InputManager = {
        target: null,
        _touch: touch,
        _lockReleases: new Set(),
        _lockTargetEl: null,
        _lockEl: typeof document === 'undefined' ? null : document.documentElement,
        _focused: typeof document === 'undefined' ? true : document.hasFocus(),
        _handlers: null as any,
    };

    const handlers = {
        keydown: (e: KeyboardEvent) => {
            const mouseKeyboard = m.target?.mouseKeyboard;
            if (!mouseKeyboard) return;
            // suppress game/editor input while a text field has focus so
            // typing in inspector fields, chat, etc. doesn't trigger
            // shortcuts or character movement. Check both `e.target` (stable
            // even if a portal/dismissable layer moves focus before this
            // bubble-phase listener fires, e.g. Radix Popover on Escape) and
            // current focus, to cover the case where the keypress originates
            // outside the input.
            if (isTextInputElement(e.target) || isTextInputFocused()) return;
            // Tab has aggressive default browser behavior (focus traversal).
            // only fire it as a game key when focus is on the viewport
            // (body or canvas); on any other UI element let the browser
            // handle tab navigation normally.
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
            // always clear on keyup to avoid stuck keys when focus
            // changes while a key is held.
            mouseKeyboard._keyState.set(e.code, false);
            mouseKeyboard._mods.mod = e.metaKey || e.ctrlKey;
            mouseKeyboard._mods.shift = e.shiftKey;
            mouseKeyboard._mods.alt = e.altKey;
            // macOS swallows letter keyups while Cmd is held, when Cmd
            // itself releases, flush any non-modifier held keys so the
            // next press registers as a fresh just-down.
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
        mousedown: (e: MouseEvent) => {
            const mouseKeyboard = m.target?.mouseKeyboard;
            if (!mouseKeyboard) return;
            mouseKeyboard._mods.mod = e.metaKey || e.ctrlKey;
            mouseKeyboard._mods.shift = e.shiftKey;
            mouseKeyboard._mods.alt = e.altKey;
            // game input is viewport-only: ignore presses that originate on
            // overlay UI (toolbars, inspector, hotbar). otherwise a right-
            // click on UI would arm a drag gesture and the fly controller
            // would grab pointer-lock as soon as the cursor moved. mousemove
            // and mouseup stay on window so a drag that started on the canvas
            // still completes if released elsewhere.
            // while pointer-locked the event targets the lock element (the root
            // `_lockEl`), not the canvas — those clicks ARE game input by
            // definition (no cursor to land on UI), so let them through, same as
            // the wheel handler does.
            const onCanvas = e.target instanceof HTMLCanvasElement;
            if (!onCanvas && !document.pointerLockElement) return;
            // a click on the canvas should defocus any active text input so
            // shortcuts like cmd+z route to the editor instead of the input's
            // native undo history. the canvas itself isn't focusable, so
            // without this the previously-focused input keeps focus.
            if (isTextInputFocused()) (document.activeElement as HTMLElement).blur();
            // this is a real user gesture on the game surface — the only place
            // the browser lets us ACQUIRE pointer lock. remember the canvas so
            // `releasePointer().restore()` can re-lock later, then try now. (only
            // a canvas press sets the fallback target; a locked-state press already
            // has the lock, and its target is the root, not a canvas.)
            if (onCanvas) m._lockTargetEl = e.target;
            // the press that RE-acquires the lock (room wants it, not held yet) is
            // spent on recapturing the cursor — swallow it so it never registers as a
            // button-down, and no gameplay reads it as a click (fire, place, tap). the
            // next press, made while already locked, is the first real action. testing
            // the lock BEFORE tryAcquire (below) is the reliable read: acquisition is
            // async, so a frame loop can't tell this press from a real one once the
            // lock lands mid-hold.
            const acquiresLock = computeShouldBeLocked(m) && !document.pointerLockElement;
            tryAcquirePointerLock(m);
            const name: MouseButton | null =
                e.button === 0 ? 'left' : e.button === 1 ? 'middle' : e.button === 2 ? 'right' : null;
            if (!name || acquiresLock) return;
            mouseKeyboard._buttons[name] = true;
            const g = mouseKeyboard._gestures[name];
            g.downX = e.clientX;
            g.downY = e.clientY;
            g.drag = false;
        },
        mouseup: (e: MouseEvent) => {
            const mouseKeyboard = m.target?.mouseKeyboard;
            if (!mouseKeyboard) return;
            mouseKeyboard._mods.mod = e.metaKey || e.ctrlKey;
            mouseKeyboard._mods.shift = e.shiftKey;
            mouseKeyboard._mods.alt = e.altKey;
            const name: MouseButton | null =
                e.button === 0 ? 'left' : e.button === 1 ? 'middle' : e.button === 2 ? 'right' : null;
            if (!name) return;
            // no matching registered press → nothing to release. covers the swallowed
            // lock-acquire click (its down never registered) and presses begun off the
            // game surface, so neither emits a spurious tap.
            if (!mouseKeyboard._buttons[name]) return;
            mouseKeyboard._buttons[name] = false;
            const g = mouseKeyboard._gestures[name];
            // a release that never crossed the drag threshold is a tap.
            // a drag-look release isn't mis-fired here because the drag
            // promotion that triggered pointer-lock already set g.drag,
            // the lock state doesn't need to be re-checked. taps issued
            // while pointer-locked (e.g. RMB-place from inside the
            // player-controller's locked view) are intentional.
            if (!g.drag) g.tapped = true;
        },
        mousemove: (e: MouseEvent) => {
            const mouseKeyboard = m.target?.mouseKeyboard;
            if (!mouseKeyboard) return;
            mouseKeyboard._dx += e.movementX;
            mouseKeyboard._dy += e.movementY;
            const t2 = DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX;
            for (const name of ['left', 'middle', 'right'] as const) {
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
            // Consume the wheel when it's over the canvas (or while pointer-
            // locked) so the page (or embedding iframe's parent) doesn't
            // also scroll while the user is dolly-zooming. Same viewport-
            // only gate as mousedown: wheel over overlay UI scrolls
            // normally.
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
            // the browser already drops pointer lock on blur; mirror it so the
            // formula agrees and we don't try to re-acquire while unfocused.
            m._focused = false;
            reconcilePointerLock(m);
        },
        // fires on `document` in browsers that report failure via the event
        // instead of a rejected promise; the promise path warns in
        // tryAcquirePointerLock. Both share the once-per-session guard.
        pointerlockerror: warnPointerLockBlocked,
    };

    m._handlers = handlers;

    window.addEventListener('keydown', handlers.keydown);
    window.addEventListener('keyup', handlers.keyup);
    window.addEventListener('mousedown', handlers.mousedown);
    window.addEventListener('mouseup', handlers.mouseup);
    window.addEventListener('mousemove', handlers.mousemove);
    window.addEventListener('wheel', handlers.wheel, { passive: false });
    window.addEventListener('focus', handlers.focus);
    window.addEventListener('blur', handlers.blur);
    document.addEventListener('pointerlockerror', handlers.pointerlockerror);

    return m;
}

export function setInputManagerTarget(m: InputManager, target: Input | null): void {
    m.target = target;
    // a room swap changes whose intent we read — re-derive. Usually the new room
    // already declared its intent (onInit fires at join, before this activation),
    // so reconcile settles it now: keep the lock for a room that wants it, release
    // for one that doesn't. If the new room is mounted but hasn't declared yet,
    // reconcile HOLDS the held lock (on the stable `_lockEl`, not the swapped-out
    // canvas) until its controller runs — releasing needs a user gesture to undo,
    // so a premature release in that gap would strand the cursor.
    reconcilePointerLock(m);
}

export function disposeInputManager(m: InputManager): void {
    const h = m._handlers;
    window.removeEventListener('keydown', h.keydown);
    window.removeEventListener('keyup', h.keyup);
    window.removeEventListener('mousedown', h.mousedown);
    window.removeEventListener('mouseup', h.mouseup);
    window.removeEventListener('mousemove', h.mousemove);
    window.removeEventListener('wheel', h.wheel);
    window.removeEventListener('focus', h.focus);
    window.removeEventListener('blur', h.blur);
    document.removeEventListener('pointerlockerror', h.pointerlockerror);
    m.target = null;
}

/* ── pointer lock ─────────────────────────────────────────────────────
 * Whether the pointer is locked is a value DERIVED each frame from the active
 * room's intent + UI releases + touch + focus (Quake `IN_Frame`). The web adds
 * one asymmetry over a native grab: releasing works any time, acquiring needs a
 * user gesture — so the reconciler only RELEASES, and acquisition happens from
 * gesture handlers (canvas mousedown, `releasePointer().restore()`). */

/** pure derivation, no side effects. */
export function computeShouldBeLocked(m: InputManager): boolean {
    return (m.target?._lockWanted ?? false) && m._lockReleases.size === 0 && !m._touch && m._focused;
}

/** RELEASE-only. Runs end-of-frame, on target swap/blur, and on release add. */
export function reconcilePointerLock(m: InputManager): void {
    if (computeShouldBeLocked(m) || !document.pointerLockElement) return;
    // the active room doesn't want the lock right now — but if it's freshly
    // mounted and hasn't declared its intent yet (controller onInit pending after
    // a room swap), that `false` is the un-run default, not an authoritative "no".
    // hold the held lock until the controller runs (it declares next tick, then a
    // following reconcile keeps or releases as it truly wants). only hold when the
    // sole blocker IS the pending intent — a UI release, blur, or touch genuinely
    // wants the cursor free, so those fall through to release.
    if (m.target && !m.target._lockDeclared && m._lockReleases.size === 0 && m._focused && !m._touch) return;
    document.exitPointerLock();
}

/** A genuine request failure (as opposed to the benign post-Esc cooldown) usually
 *  means the embedding blocked capture: a sandboxed/opaque-origin iframe missing
 *  the `pointer-lock` Permissions-Policy or `allow-pointer-lock` sandbox flag, or a
 *  hardened browser with pointer lock disabled. Silent failures make these reports
 *  undiagnosable, so surface one hint. Guarded so we log at most once per session
 *  (post-Esc reacquire attempts also land here and must not spam). */
let warnedPointerLockBlocked = false;
function warnPointerLockBlocked(): void {
    if (warnedPointerLockBlocked) return;
    warnedPointerLockBlocked = true;
    console.warn(
        'Pointer lock request was blocked. If this persists, the embedding iframe may be missing ' +
            'the `pointer-lock` Permissions-Policy / `allow-pointer-lock` sandbox flag, or the browser ' +
            'has pointer lock disabled (e.g. hardened Firefox: full-screen-api.pointer-lock.enabled, ' +
            'privacy.resistFingerprinting).',
    );
}

/** ACQUIRE — call only from a real user gesture. `unadjustedMovement` gives raw,
 *  un-accelerated deltas (better aim); older Safari rejects it, so retry plain,
 *  and always swallow the post-Esc cooldown's rejection (logging one hint). */
export function tryAcquirePointerLock(m: InputManager): void {
    if (!computeShouldBeLocked(m) || document.pointerLockElement) return;
    // prefer the stable container so the lock survives room swaps; fall back to
    // the last-clicked canvas if the container isn't wired yet.
    const el = m._lockEl ?? m._lockTargetEl;
    if (!el) return;
    const p = (el.requestPointerLock as (o?: { unadjustedMovement?: boolean }) => Promise<void> | undefined)({
        unadjustedMovement: true,
    });
    if (p?.catch)
        p.catch(() =>
            (el.requestPointerLock() as Promise<void> | undefined)?.catch?.(warnPointerLockBlocked),
        );
}

/** UI/ad/host surface asks to free the cursor while shown. Releases immediately
 *  (no waiting a frame with a menu over a locked cursor). */
export function addLockRelease(m: InputManager, id: string): void {
    m._lockReleases.add(id);
    reconcilePointerLock(m);
}

/** the surface closed. Re-acquire synchronously — call from the close gesture so
 *  the lock comes back in that gesture; otherwise it waits for the next click. */
export function removeLockRelease(m: InputManager, id: string): void {
    m._lockReleases.delete(id);
    tryAcquirePointerLock(m);
}
