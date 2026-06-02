/**
 * Mobile-device predicates for scripts that want to branch on touch vs
 * desktop. All three return `false` on the server, so script call sites
 * can write `if (isMobile(ctx)) mountHud()` without a separate env guard.
 *
 * Touch capability is resolved once at client boot (`state.device.touch`);
 * viewport-dependent checks read live since they change on resize/orient.
 */

import type { ScriptContext } from '../core/scene/scripts';
import { env } from './env';

/** matchMedia('(pointer: coarse)') OR navigator.maxTouchPoints > 0. */
export function isTouchDevice(ctx: ScriptContext): boolean {
    if (!env.client) return false;
    return ctx.client?.state.device.touch ?? false;
}

const MOBILE_VIEWPORT_BREAKPOINT_PX = 768;

/** viewport width below the 768px breakpoint. */
export function isMobileViewport(): boolean {
    if (!env.client) return false;
    if (typeof window === 'undefined') return false;
    return window.innerWidth < MOBILE_VIEWPORT_BREAKPOINT_PX;
}

/** isTouchDevice() && isMobileViewport(). The "should I show touch HUD" check. */
export function isMobile(ctx: ScriptContext): boolean {
    return isTouchDevice(ctx) && isMobileViewport();
}
