/**
 * Mobile-device predicates for scripts that want to branch on touch vs
 * desktop. All three return `false` on the server, so script call sites
 * can write `if (isMobile(ctx)) mountHud()` without a separate env guard.
 *
 * Touch capability is resolved once at client boot (`state.device.touch`);
 * viewport-dependent checks read live since they change on resize/orient.
 */

import type { ScriptContext } from '../core/scene/scripts';
import { env } from '../env';

/** matchMedia('(pointer: coarse)') OR navigator.maxTouchPoints > 0. true on
 *  touchscreen laptops too, use `isTouchPrimary` to gate touch controls. */
export function isTouchDevice(ctx: ScriptContext): boolean {
    if (!env.client) return false;
    return ctx.client?.state?.device.touch ?? false;
}

/**
 * Touch is the PRIMARY pointer (matchMedia('(pointer: coarse)')). Unlike
 * `isMobile` this is viewport-INDEPENDENT, so it stays true on a tablet or a
 * phone held in landscape; unlike `isTouchDevice` it's false on a touchscreen
 * laptop driven by its trackpad. This is the "should I show on-screen touch
 * controls (joystick, action buttons)" check. Resolved once at client boot.
 */
export function isTouchPrimary(ctx: ScriptContext): boolean {
    if (!env.client) return false;
    return ctx.client?.state?.device.touchPrimary ?? false;
}

const MOBILE_VIEWPORT_BREAKPOINT_PX = 768;

/** viewport width below the 768px breakpoint. FRAGILE on its own — a phone whose
 *  host page renders desktop-style reports ~980px here — so `isMobile` only uses it
 *  as an extra catch on top of the robust device signal, never as the sole check. */
export function isMobileViewport(): boolean {
    if (!env.client) return false;
    if (typeof window === 'undefined') return false;
    return window.innerWidth < MOBILE_VIEWPORT_BREAKPOINT_PX;
}

/** A phone-class device — the "use a compact/phone HUD LAYOUT" check. Reads the
 *  robust, viewport-independent device probe (Client Hints / UA), so it holds on a
 *  real phone even when the host page (e.g. the editor) renders desktop-width; the
 *  narrow-viewport check is only an extra catch (small window / split-screen). For
 *  gating touch CONTROLS (joystick, action buttons) use `isTouchPrimary`, which is
 *  also true on tablets. */
export function isMobile(ctx: ScriptContext): boolean {
    if (!env.client) return false;
    return (ctx.client?.state?.device.mobile ?? false) || (isTouchDevice(ctx) && isMobileViewport());
}
