/**
 * One-shot device capability probe. Touch capability is hardware — it does
 * not change for the session — so we resolve it once at client boot and
 * stash the result on engine-client state. Per-frame predicates
 * (`isTouchDevice`) read `state.device.touch` instead of calling `matchMedia`
 * every tick.
 */

export type Device = {
    /** has ANY touch capability: matchMedia('(pointer: coarse)') OR
     *  navigator.maxTouchPoints > 0. true on touchscreen laptops too. */
    touch: boolean;
    /** touch is the PRIMARY pointer (matchMedia('(pointer: coarse)') alone, no
     *  maxTouchPoints). true on phones + tablets regardless of viewport size,
     *  false on a touchscreen laptop driven by its trackpad/mouse. this is the
     *  "should I show touch controls" signal — see `isTouchPrimary`. */
    touchPrimary: boolean;
};

export function init(): Device {
    return { touch: detectTouch(), touchPrimary: detectCoarsePrimary() };
}

function detectCoarsePrimary(): boolean {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        return window.matchMedia('(pointer: coarse)').matches;
    }
    return false;
}

function detectTouch(): boolean {
    if (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) return true;
    return detectCoarsePrimary();
}
