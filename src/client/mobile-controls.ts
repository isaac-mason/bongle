/**
 * On-screen joystick + button — DOM helpers mounted under the per-room
 * `touchOverlay`. They own pointer-event listeners on their own root
 * `<div>` (siblings of the canvas, not children) and write directly
 * into the room's `TouchInput` state by id. Scripts read state via the
 * `getJoystick` / `isTouchButtonDown` predicates by the same id.
 */

import { warn } from '../api/debug';
import type { ScriptContext } from '../api/scripts';
import type { JoystickState, TouchButtonState, TouchInput } from './input';

/* ── shared helpers ──────────────────────────────────────────────── */

function getOverlay(ctx: ScriptContext): { overlay: HTMLDivElement; touch: TouchInput } | null {
    const client = ctx.client;
    if (!client) return null;
    const overlay = client.touchOverlay;
    if (!overlay) return null;
    return { overlay, touch: client.input.touch };
}

function applyEdges(el: HTMLDivElement, opts: { left?: number; right?: number; top?: number; bottom?: number }): void {
    el.style.position = 'absolute';
    if (opts.left !== undefined) el.style.left = `${opts.left}px`;
    if (opts.right !== undefined) el.style.right = `${opts.right}px`;
    if (opts.top !== undefined) el.style.top = `${opts.top}px`;
    if (opts.bottom !== undefined) el.style.bottom = `${opts.bottom}px`;
}

/* ── joystick ────────────────────────────────────────────────────── */

export type CreateJoystickOpts = {
    id: string;
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
    /** outer ring diameter, CSS px. */
    size: number;
    /** 0..1 inner dead-zone applied to the normalised stick magnitude. */
    deadzone?: number;
};

export function createJoystickImpl(ctx: ScriptContext, opts: CreateJoystickOpts): { dispose(): void } | null {
    const mount = getOverlay(ctx);
    if (!mount) return null;
    const { overlay, touch } = mount;

    if (touch._joysticks.has(opts.id)) {
        warn(ctx, `createJoystick: id '${opts.id}' already registered; replacing previous joystick`);
    }
    const state: JoystickState = { x: 0, y: 0, active: false, _prevActive: false };
    touch._joysticks.set(opts.id, state);

    const size = opts.size;
    const thumbSize = Math.max(24, Math.round(size * 0.4));
    const deadzone = opts.deadzone ?? 0.1;
    const radius = size / 2;

    const root = document.createElement('div');
    root.style.width = `${size}px`;
    root.style.height = `${size}px`;
    root.style.borderRadius = '50%';
    root.style.background = 'rgba(255, 255, 255, 0.6)';
    root.style.border = '2px solid #000';
    root.style.touchAction = 'none';
    root.style.pointerEvents = 'auto';
    root.style.userSelect = 'none';
    applyEdges(root, opts);

    const thumb = document.createElement('div');
    thumb.style.position = 'absolute';
    thumb.style.left = '50%';
    thumb.style.top = '50%';
    thumb.style.width = `${thumbSize}px`;
    thumb.style.height = `${thumbSize}px`;
    thumb.style.marginLeft = `${-thumbSize / 2}px`;
    thumb.style.marginTop = `${-thumbSize / 2}px`;
    thumb.style.borderRadius = '50%';
    thumb.style.background = '#fff';
    thumb.style.border = '2px solid #000';
    thumb.style.pointerEvents = 'none';
    root.appendChild(thumb);

    let activePointerId: number | null = null;
    let centerX = 0;
    let centerY = 0;

    const setStick = (nx: number, ny: number): void => {
        const mag = Math.sqrt(nx * nx + ny * ny);
        if (mag < deadzone) {
            state.x = 0;
            state.y = 0;
            thumb.style.transform = 'translate(0px, 0px)';
            return;
        }
        // remap [deadzone, 1] → [0, 1] then clamp.
        const remapped = Math.min(1, (mag - deadzone) / (1 - deadzone));
        const sx = (nx / mag) * remapped;
        const sy = (ny / mag) * remapped;
        state.x = sx;
        state.y = sy;
        thumb.style.transform = `translate(${sx * radius}px, ${sy * radius}px)`;
    };

    const onDown = (e: PointerEvent): void => {
        if (activePointerId !== null) return;
        activePointerId = e.pointerId;
        const rect = root.getBoundingClientRect();
        centerX = rect.left + rect.width / 2;
        centerY = rect.top + rect.height / 2;
        state.active = true;
        try {
            root.setPointerCapture(e.pointerId);
        } catch {
            // capture can fail; we still receive move/up via the element.
        }
        const nx = (e.clientX - centerX) / radius;
        const ny = (e.clientY - centerY) / radius;
        setStick(nx, ny);
        e.preventDefault();
    };

    const onMove = (e: PointerEvent): void => {
        if (activePointerId !== e.pointerId) return;
        const nx = (e.clientX - centerX) / radius;
        const ny = (e.clientY - centerY) / radius;
        setStick(nx, ny);
    };

    const onUp = (e: PointerEvent): void => {
        if (activePointerId !== e.pointerId) return;
        activePointerId = null;
        state.active = false;
        state.x = 0;
        state.y = 0;
        thumb.style.transform = 'translate(0px, 0px)';
    };

    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onUp);

    overlay.appendChild(root);

    return {
        dispose(): void {
            root.removeEventListener('pointerdown', onDown);
            root.removeEventListener('pointermove', onMove);
            root.removeEventListener('pointerup', onUp);
            root.removeEventListener('pointercancel', onUp);
            root.remove();
            if (touch._joysticks.get(opts.id) === state) touch._joysticks.delete(opts.id);
        },
    };
}

/* ── button ──────────────────────────────────────────────────────── */

export type CreateTouchButtonOpts = {
    id: string;
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
    width: number;
    height: number;
    label?: string;
};

export function createTouchButtonImpl(ctx: ScriptContext, opts: CreateTouchButtonOpts): { dispose(): void } | null {
    const mount = getOverlay(ctx);
    if (!mount) return null;
    const { overlay, touch } = mount;

    if (touch._buttons.has(opts.id)) {
        warn(ctx, `createTouchButton: id '${opts.id}' already registered; replacing previous button`);
    }
    const state: TouchButtonState = { down: false, _prevDown: false };
    touch._buttons.set(opts.id, state);

    const root = document.createElement('div');
    root.style.width = `${opts.width}px`;
    root.style.height = `${opts.height}px`;
    root.style.background = 'rgba(255, 255, 255, 0.85)';
    root.style.border = '2px solid #000';
    root.style.display = 'flex';
    root.style.alignItems = 'center';
    root.style.justifyContent = 'center';
    root.style.font = '20px system-ui, -apple-system, sans-serif';
    root.style.color = '#000';
    root.style.touchAction = 'none';
    root.style.pointerEvents = 'auto';
    root.style.userSelect = 'none';
    if (opts.label) root.textContent = opts.label;
    applyEdges(root, opts);

    let activePointerId: number | null = null;

    const setDown = (down: boolean): void => {
        state.down = down;
        root.style.background = down ? 'rgba(0, 0, 0, 0.85)' : 'rgba(255, 255, 255, 0.85)';
        root.style.color = down ? '#fff' : '#000';
    };

    const onDown = (e: PointerEvent): void => {
        if (activePointerId !== null) return;
        activePointerId = e.pointerId;
        try {
            root.setPointerCapture(e.pointerId);
        } catch {
            // capture can fail; events still fire on the element.
        }
        setDown(true);
        e.preventDefault();
    };

    const onUp = (e: PointerEvent): void => {
        if (activePointerId !== e.pointerId) return;
        activePointerId = null;
        setDown(false);
    };

    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onUp);
    root.addEventListener('pointerleave', onUp);

    overlay.appendChild(root);

    return {
        dispose(): void {
            root.removeEventListener('pointerdown', onDown);
            root.removeEventListener('pointerup', onUp);
            root.removeEventListener('pointercancel', onUp);
            root.removeEventListener('pointerleave', onUp);
            root.remove();
            if (touch._buttons.get(opts.id) === state) touch._buttons.delete(opts.id);
        },
    };
}
