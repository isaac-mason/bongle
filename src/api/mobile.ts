import type { ScriptContext } from '../core/scene/scripts';
import { env } from '../env';

/** Device is touch-capable (touch-only or hybrid), true on touchscreen laptops too.
 *  Use `isTouchPrimary` to decide whether touch is actually being used. */
export function isTouchDevice(ctx: ScriptContext): boolean {
    if (!env.client) return false;
    return ctx.client?.state?.device.deviceType !== 'mouseOnly';
}

/**
 * Touch is the input being used right now, from real pointer events. Unlike
 * `isMobile` this is viewport-independent; unlike `isTouchDevice` it's false
 * on a touchscreen laptop driven by its trackpad, and flips live on a hybrid
 * device. Use to gate on-screen touch controls, checked per-tick.
 */
export function isTouchPrimary(ctx: ScriptContext): boolean {
    if (!env.client) return false;
    return ctx.client?.state?.inputManager?.inputMode === 'touch';
}

const MOBILE_VIEWPORT_BREAKPOINT_PX = 768;

/** Viewport width below the 768px breakpoint. Fragile alone (a phone whose host
 *  page renders desktop-style reports ~980px), so `isMobile` uses it only as an
 *  extra catch on top of the device signal. */
export function isMobileViewport(): boolean {
    if (!env.client) return false;
    if (typeof window === 'undefined') return false;
    return window.innerWidth < MOBILE_VIEWPORT_BREAKPOINT_PX;
}

/** A phone-class device, for compact HUD layout. Reads the viewport-independent
 *  device probe so it holds even when the host page renders desktop-width; the
 *  narrow-viewport check is only an extra catch. For gating touch controls use
 *  `isTouchPrimary` instead, which is also true on tablets. */
export function isMobile(ctx: ScriptContext): boolean {
    if (!env.client) return false;
    return (ctx.client?.state?.device.mobile ?? false) || (isTouchDevice(ctx) && isMobileViewport());
}
