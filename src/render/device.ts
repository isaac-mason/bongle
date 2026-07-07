/**
 * One-shot device capability probe. Touch/device class is hardware, it does
 * not change for the session, so we resolve it once at client boot and stash
 * the result on engine-client state. Per-frame predicates (`isTouchDevice`,
 * `isMobile`) read `state.device.*` instead of re-probing every tick.
 *
 * Detection is deliberately viewport-INDEPENDENT and multi-signal: a phone
 * whose host page renders desktop-style (e.g. inside an editor with no mobile
 * viewport meta) still reports ~980px `innerWidth` and can misreport
 * `matchMedia('(pointer: coarse)')`, so we never rely on width alone and OR
 * together the reliable signals (Client Hints `userAgentData.mobile`, a UA
 * regex, `maxTouchPoints`, and the pointer media query).
 */

export type Device = {
    /** has ANY touch capability: `maxTouchPoints > 0` OR a coarse primary
     *  pointer OR a known mobile device. true on touchscreen laptops too. */
    touch: boolean;
    /** touch is the PRIMARY pointer — a phone/tablet, regardless of viewport
     *  size or a desktop-styled host page. false on a touchscreen laptop driven
     *  by its trackpad/mouse. this is the "should I show touch controls" signal
     *  (see `isTouchPrimary`). */
    touchPrimary: boolean;
    /** a phone-class device (Client Hints `userAgentData.mobile`, else a UA
     *  regex). viewport-independent, so it holds on a phone even when the page
     *  is rendered desktop-width. drives the compact phone HUD (see `isMobile`). */
    mobile: boolean;
};

export function init(): Device {
    const mobile = detectMobile();
    // a mobile device is a coarse-primary touchscreen by definition, so let the
    // robust device signal backstop the (occasionally-misreporting) media query.
    return { touch: detectTouch() || mobile, touchPrimary: detectCoarsePrimary() || mobile, mobile };
}

type UADataLike = { mobile?: boolean };

/** a phone-class device. prefers UA Client Hints (`navigator.userAgentData.mobile`,
 *  definitive on Chromium/Android), falling back to a UA regex for Safari/iOS and
 *  older browsers. NOT a viewport check — that misfires on desktop-styled host pages. */
function detectMobile(): boolean {
    if (typeof navigator === 'undefined') return false;
    const uaData = (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData;
    if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile;
    return /Android|iPhone|iPod|Windows Phone|IEMobile|BlackBerry|Opera Mini/i.test(navigator.userAgent || '');
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
