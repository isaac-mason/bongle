/**
 * One-shot device capability probe. Touch capability is hardware — it does
 * not change for the session — so we resolve it once at client boot and
 * stash the result on engine-client state. Per-frame predicates
 * (`isTouchDevice`) read `state.device.touch` instead of calling `matchMedia`
 * every tick.
 */

export type Device = {
    /** matchMedia('(pointer: coarse)') OR navigator.maxTouchPoints > 0. */
    touch: boolean;
};

export function init(): Device {
    return { touch: detectTouch() };
}

function detectTouch(): boolean {
    if (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) return true;
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        return window.matchMedia('(pointer: coarse)').matches;
    }
    return false;
}
